// png-squeeze-01: squeeze 1280x720 screenshots into the smallest lossless PNG.
//
// Strategy (all written from scratch, Node built-ins only):
//   1. Decode the input PNG to raw RGBA (inflate + unfilter, any colour type, 8-bit).
//   2. Reduce the colour model when it is exact: palette (<=256 distinct colours,
//      two palette orderings), grey / grey+alpha (R==G==B everywhere), RGB (opaque),
//      else RGBA.
//   3. For each layout, filter every row with all five PNG filters plus a
//      sum-of-absolute-values adaptive choice, rank the streams with zlib level 6,
//      and keep the best.
//   4. Encode the winner with zlib level 9 (default and Z_FILTERED strategies) and
//      keep the smaller stream.
//   5. Write a minimal PNG: IHDR, PLTE/tRNS only when needed, one IDAT, IEND.
//
// Deterministic: fixed iteration counts, no clock, no randomness, no environment
// input besides the input/output directory paths. One run handles all 8 instances.
import { mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

const INPUT_DIR: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const MAX_BYTES: number = 4194304;

// ---------------------------------------------------------------- CRC-32 / Adler-32
const CRC_TABLE: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------------------------------------------------------------- PNG decoding
interface Decoded {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(buf: Buffer): Decoded {
  if (buf.length < 8 || buf[0] !== 137 || buf[1] !== 80 || buf[2] !== 78 || buf[3] !== 71) {
    throw new Error('not a PNG');
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idatParts: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || !(colourType in CHANNELS)) {
    throw new Error('unsupported PNG (need 8-bit, non-interlaced, colour type 0/2/3/4/6)');
  }
  const ch = CHANNELS[colourType];
  const raw = inflateSync(Buffer.concat(idatParts));
  const stride = width * ch;
  if (raw.length !== height * (stride + 1)) throw new Error('unexpected inflated size');
  const src = new Uint8Array(width * height * ch);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[p++];
    const row = raw.subarray(p, p + stride);
    p += stride;
    const cur = src.subarray(y * stride, (y + 1) * stride);
    const prv = y === 0 ? null : src.subarray((y - 1) * stride, y * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0;
      const b = prv ? prv[i] : 0;
      const c = i >= ch && prv ? prv[i - ch] : 0;
      let v = row[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) v += paeth(a, b, c);
      cur[i] = v & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * ch;
    const d = i * 4;
    if (colourType === 6) {
      rgba[d] = src[s];
      rgba[d + 1] = src[s + 1];
      rgba[d + 2] = src[s + 2];
      rgba[d + 3] = src[s + 3];
    } else if (colourType === 2) {
      rgba[d] = src[s];
      rgba[d + 1] = src[s + 1];
      rgba[d + 2] = src[s + 2];
      rgba[d + 3] = 255;
    } else if (colourType === 0) {
      rgba[d] = src[s];
      rgba[d + 1] = src[s];
      rgba[d + 2] = src[s];
      rgba[d + 3] = 255;
    } else if (colourType === 4) {
      rgba[d] = src[s];
      rgba[d + 1] = src[s];
      rgba[d + 2] = src[s];
      rgba[d + 3] = src[s + 1];
    } else {
      // palette
      const idx = src[s];
      if (!palette || idx * 3 + 2 >= palette.length) throw new Error('palette index out of range');
      rgba[d] = palette[idx * 3];
      rgba[d + 1] = palette[idx * 3 + 1];
      rgba[d + 2] = palette[idx * 3 + 2];
      rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- Layouts
interface Layout {
  colourType: number;
  channels: number;
  data: Uint8Array; // samples, row-major, channels per pixel
  palette: Uint8Array | null; // RGB triples for colour type 3
  trns: Uint8Array | null; // alpha per palette entry (trimmed), for colour type 3
}

function buildLayouts(decoded: Decoded): Layout[] {
  const { width, height, rgba } = decoded;
  const n = width * height;
  const counts = new Map<number, number>();
  const firstSeen = new Map<number, number>();
  let grey = true;
  let opaque = true;
  let alphaVar = false;
  let minA = 255;
  let maxA = 0;
  let order = 0;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    if (r !== g || g !== b) grey = false;
    if (a !== 255) opaque = false;
    if (a < minA) minA = a;
    if (a > maxA) maxA = a;
    if (counts.size <= 256) {
      const key = r * 16777216 + g * 65536 + b * 256 + a;
      const prev = counts.get(key);
      if (prev === undefined) {
        counts.set(key, 1);
        firstSeen.set(key, order++);
      } else {
        counts.set(key, prev + 1);
      }
    }
  }
  alphaVar = minA !== maxA;
  const paletteable = counts.size <= 256;

  if (grey) {
    if (!alphaVar) {
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = rgba[i * 4];
      return [{ colourType: 0, channels: 1, data, palette: null, trns: null }];
    }
    const data = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) {
      data[i * 2] = rgba[i * 4];
      data[i * 2 + 1] = rgba[i * 4 + 3];
    }
    return [{ colourType: 4, channels: 2, data, palette: null, trns: null }];
  }

  if (paletteable) {
    const keys = [...counts.keys()];
    const layouts: Layout[] = [];
    // Ordering 1: first occurrence. Ordering 2: most frequent first.
    const orderings: number[][] = [
      [...keys].sort((a, b) => (firstSeen.get(a) as number) - (firstSeen.get(b) as number)),
      [...keys].sort(
        (a, b) => (counts.get(b) as number) - (counts.get(a) as number) || (firstSeen.get(a) as number) - (firstSeen.get(b) as number),
      ),
    ];
    for (const ordering of orderings) {
      const indexOf = new Map<number, number>();
      const palette = new Uint8Array(ordering.length * 3);
      const alphas = new Uint8Array(ordering.length);
      for (let k = 0; k < ordering.length; k++) {
        const key = ordering[k];
        indexOf.set(key, k);
        palette[k * 3] = Math.floor(key / 16777216);
        palette[k * 3 + 1] = Math.floor(key / 65536) % 256;
        palette[k * 3 + 2] = Math.floor(key / 256) % 256;
        alphas[k] = key % 256;
      }
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const key = rgba[i * 4] * 16777216 + rgba[i * 4 + 1] * 65536 + rgba[i * 4 + 2] * 256 + rgba[i * 4 + 3];
        data[i] = indexOf.get(key) as number;
      }
      let trns: Uint8Array | null = null;
      let lastNonOpaque = -1;
      for (let k = 0; k < alphas.length; k++) if (alphas[k] !== 255) lastNonOpaque = k;
      if (lastNonOpaque >= 0) trns = alphas.subarray(0, lastNonOpaque + 1);
      layouts.push({ colourType: 3, channels: 1, data, palette, trns });
    }
    return layouts;
  }

  if (opaque) {
    const data = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      data[i * 3] = rgba[i * 4];
      data[i * 3 + 1] = rgba[i * 4 + 1];
      data[i * 3 + 2] = rgba[i * 4 + 2];
    }
    return [{ colourType: 2, channels: 3, data, palette: null, trns: null }];
  }

  return [{ colourType: 6, channels: 4, data: rgba, palette: null, trns: null }];
}

// ---------------------------------------------------------------- Filtering
// Build the five fixed-filter streams plus a sum-of-abs adaptive stream for one
// layout, in a single pass over the rows.
function buildFilterStreams(layout: Layout, width: number, height: number): Uint8Array[] {
  const ch = layout.channels;
  const data = layout.data;
  const stride = width * ch;
  const rowLen = stride + 1;
  const streams: Uint8Array[] = [];
  for (let f = 0; f < 5; f++) streams.push(new Uint8Array(height * rowLen));
  const adaptive = new Uint8Array(height * rowLen);
  streams.push(adaptive);
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const prv = y === 0 ? null : data.subarray((y - 1) * stride, y * stride);
    const sums = [0, 0, 0, 0, 0];
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? row[i - ch] : 0;
      const b = prv ? prv[i] : 0;
      const c = i >= ch && prv ? prv[i - ch] : 0;
      const v = row[i];
      const f0 = v;
      const f1 = (v - a) & 255;
      const f2 = (v - b) & 255;
      const f3 = (v - ((a + b) >> 1)) & 255;
      const f4 = (v - paeth(a, b, c)) & 255;
      const base = y * rowLen + 1 + i;
      streams[0][base] = f0;
      streams[1][base] = f1;
      streams[2][base] = f2;
      streams[3][base] = f3;
      streams[4][base] = f4;
      sums[0] += f0 < 128 ? f0 : 256 - f0;
      sums[1] += f1 < 128 ? f1 : 256 - f1;
      sums[2] += f2 < 128 ? f2 : 256 - f2;
      sums[3] += f3 < 128 ? f3 : 256 - f3;
      sums[4] += f4 < 128 ? f4 : 256 - f4;
    }
    let best = 0;
    for (let f = 1; f < 5; f++) if (sums[f] < sums[best]) best = f;
    for (let f = 0; f < 5; f++) streams[f][y * rowLen] = f;
    adaptive[y * rowLen] = best;
    adaptive.set(streams[best].subarray(y * rowLen + 1, (y + 1) * rowLen), y * rowLen + 1);
  }
  return streams;
}

// ---------------------------------------------------------------- PNG writing
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  out.set(data, 8);
  const crc = crc32(out, 4, 8 + data.length);
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

function writePng(layout: Layout, width: number, height: number, zlibStream: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = layout.colourType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const parts: Buffer[] = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (layout.palette) parts.push(chunk('PLTE', layout.palette));
  if (layout.trns) parts.push(chunk('tRNS', layout.trns));
  parts.push(chunk('IDAT', zlibStream));
  parts.push(chunk('IEND', new Uint8Array(0)));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- Per-instance
function squeezeOne(inputPath: string, outputPath: string): void {
  const input = readFileSync(inputPath);
  let png: Buffer;
  try {
    const decoded = decodePng(input);
    const layouts = buildLayouts(decoded);
    let bestStream: Uint8Array | null = null;
    let bestRank = Infinity;
    let bestLayout: Layout | null = null;
    for (const layout of layouts) {
      const streams = buildFilterStreams(layout, decoded.width, decoded.height);
      for (const stream of streams) {
        const ranked = deflateSync(stream, { level: 6 });
        if (ranked.length < bestRank) {
          bestRank = ranked.length;
          bestStream = stream;
          bestLayout = layout;
        }
      }
    }
    if (!bestStream || !bestLayout) throw new Error('no candidate stream');
    const candidates: Buffer[] = [
      deflateSync(bestStream, { level: 9 }),
      deflateSync(bestStream, { level: 9, strategy: constants.Z_FILTERED }),
    ];
    let zlibStream = candidates[0];
    for (const c of candidates) if (c.length < zlibStream.length) zlibStream = c;
    png = writePng(bestLayout, decoded.width, decoded.height, zlibStream);
    // Sanity: the answer must decode back to the same pixels. If anything is off,
    // fall back to the input file (a valid, if large, answer).
    const check = decodePng(png);
    if (
      check.width !== decoded.width ||
      check.height !== decoded.height ||
      check.rgba.length !== decoded.rgba.length ||
      !check.rgba.every((v, i) => v === decoded.rgba[i])
    ) {
      throw new Error('round-trip mismatch');
    }
    if (png.length > MAX_BYTES) throw new Error('answer over 4 MiB');
  } catch {
    // Fallback: copy the input (stored PNG, always in the accepted format).
    png = input;
  }
  mkdirSync(join(outputPath, '..'), { recursive: true });
  writeFileSync(outputPath, png);
}

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const ids = readdirSync(INPUT_DIR).sort();
  for (const id of ids) {
    const inPath = join(INPUT_DIR, id, 'image.png');
    const outDir = join(OUTPUT_DIR, id);
    mkdirSync(outDir, { recursive: true });
    try {
      squeezeOne(inPath, join(outDir, 'image.png'));
    } catch {
      // Last-resort fallback so the instance is still answered.
      try {
        copyFileSync(inPath, join(outDir, 'image.png'));
      } catch {
        // leave the instance unanswered rather than crashing the whole run
      }
    }
  }
}

main();
