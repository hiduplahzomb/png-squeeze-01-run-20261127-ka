// png-squeeze-01: squeeze 1280x720 screenshots into the smallest lossless PNG.
//
// Strategy (written from scratch, Node built-ins only):
//   1. Decode the input PNG to raw RGBA (inflate + unfilter, any colour type,
//      8-bit, non-interlaced). The decoder verifies every chunk CRC, rejects
//      filter bytes above 4, and applies tRNS for colour types 0, 2 and 3
//      (single transparent key for 0/2, per-index alpha for 3).
//   2. Reduce the colour model when it is exact: palette (<=256 distinct
//      colours, five orderings: first-seen, frequency, luminance,
//      transparent-entries-first, and spatial-neighbour greedy), grey /
//      grey+alpha (grey only when every pixel is opaque; a single transparent
//      grey/RGB value that no opaque pixel uses becomes a tRNS key instead of
//      an alpha channel), RGB (opaque), else RGBA. A palette is also tried as
//      a rival to grey when the grey levels are few.
//   3. For each layout, filter every row with all five PNG filters plus
//      three adaptive choices (minimum signed sum, fewest distinct byte
//      pairs, and brute force: each filter tried per row, or per band of
//      rows, deflated against the 32 KiB written before it). Candidates are
//      ranked by TOTAL file bytes (deflate stream + PLTE/tRNS chunk
//      overhead), not by the deflate stream alone; the best three survive
//      to the final deflate.
//   4. Final deflate: screen the three survivors cheaply (level 7, or 6 on
//      heavy images, at memLevel 5 for 1-channel / 6 otherwise), then level 9
//      only on the screening winner (3 calls normally, 1 on heavy images).
//   5. Write a minimal PNG: IHDR, PLTE/tRNS only when needed, one IDAT,
//      IEND. A round-trip decode check (Buffer.compare) runs per instance;
//      on any failure the program falls back to copying the input file.
//
// Deterministic: fixed iteration counts, no clock, no randomness, no
// environment input besides the input/output directory paths. One run
// handles all 8 instances.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

const INPUT_DIR: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const MAX_BYTES: number = 4194304;
const DICT_BYTES: number = 32768;
const BRUTE_BAND_ROWS: number = 8;
const BRUTE_BAND_ROWS_WIDE: number = 16;

// ---------------------------------------------------------------- CRC-32
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

// Undo the row filters of an inflated image into `out` (row-major, `ch`
// channels per pixel). Rejects any filter byte above 4 instead of silently
// treating it as None.
function unfilterInto(raw: Buffer, width: number, height: number, ch: number, out: Uint8Array): void {
  const stride = width * ch;
  let p = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[p++];
    if (f > 4) throw new Error('bad filter byte');
    const row = raw.subarray(p, p + stride);
    p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prv = y === 0 ? null : out.subarray((y - 1) * stride, y * stride);
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
}

function decodePng(buf: Buffer): Decoded {
  if (
    buf.length < 8 ||
    buf[0] !== 137 || buf[1] !== 80 || buf[2] !== 78 || buf[3] !== 71 ||
    buf[4] !== 13 || buf[5] !== 10 || buf[6] !== 26 || buf[7] !== 10
  ) {
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
  let seenIhdr = false;
  const idatParts: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (len > buf.length - off - 12) throw new Error('chunk overruns file');
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const storedCrc = buf.readUInt32BE(off + 8 + len);
    if (crc32(buf, off + 4, off + 8 + len) !== storedCrc) throw new Error('bad CRC in ' + type);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colourType = data[9];
      interlace = data[12];
      seenIhdr = true;
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
  if (!seenIhdr || idatParts.length === 0) throw new Error('missing IHDR or IDAT');
  if (bitDepth !== 8 || interlace !== 0 || !(colourType in CHANNELS)) {
    throw new Error('unsupported PNG (need 8-bit, non-interlaced, colour type 0/2/3/4/6)');
  }
  const ch = CHANNELS[colourType];
  const raw = inflateSync(Buffer.concat(idatParts));
  const stride = width * ch;
  if (raw.length !== height * (stride + 1)) throw new Error('unexpected inflated size');
  const rgba = new Uint8Array(width * height * 4);
  if (colourType === 6) {
    // Unfilter straight into the RGBA buffer: no intermediate copy.
    unfilterInto(raw, width, height, ch, rgba);
    return { width, height, rgba };
  }
  const src = new Uint8Array(width * height * ch);
  unfilterInto(raw, width, height, ch, src);
  // tRNS single keys for colour types 0 and 2: one grey value / RGB triple
  // that decodes as fully transparent, everything else opaque.
  let keyGrey = -1;
  let keyR = -1;
  let keyG = -1;
  let keyB = -1;
  if (colourType === 0 && trns) {
    if (trns.length !== 2) throw new Error('bad tRNS for grey');
    keyGrey = trns.readUInt16BE(0);
  } else if (colourType === 2 && trns) {
    if (trns.length !== 6) throw new Error('bad tRNS for RGB');
    keyR = trns.readUInt16BE(0);
    keyG = trns.readUInt16BE(2);
    keyB = trns.readUInt16BE(4);
  }
  for (let i = 0; i < width * height; i++) {
    const s = i * ch;
    const d = i * 4;
    if (colourType === 2) {
      rgba[d] = src[s];
      rgba[d + 1] = src[s + 1];
      rgba[d + 2] = src[s + 2];
      rgba[d + 3] = src[s] === keyR && src[s + 1] === keyG && src[s + 2] === keyB ? 0 : 255;
    } else if (colourType === 0) {
      rgba[d] = src[s];
      rgba[d + 1] = src[s];
      rgba[d + 2] = src[s];
      rgba[d + 3] = src[s] === keyGrey ? 0 : 255;
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

// ---------------------------------------------------------------- Analysis
interface Analysis {
  grey: boolean;
  opaque: boolean;
  hasPartial: boolean;
  paletteable: boolean;
  counts: Map<number, number>;
  firstSeen: Map<number, number>;
  greyLevels: number;
  // RGB (r<<16|g<<8|b) of the single fully-transparent colour, or -1 when
  // there is none or more than one.
  transKey: number;
}

function analyse(decoded: Decoded): Analysis {
  const { width, height, rgba } = decoded;
  const n = width * height;
  const counts = new Map<number, number>();
  const firstSeen = new Map<number, number>();
  let grey = true;
  let opaque = true;
  let hasPartial = false;
  let order = 0;
  const greySet = new Set<number>();
  let transKey = -1;
  let transMultiple = false;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    if (r !== g || g !== b) {
      grey = false;
    } else if (greySet.size <= 256) {
      greySet.add(r);
    }
    if (a === 255) {
      // opaque
    } else if (a === 0) {
      opaque = false;
      const k = (r << 16) | (g << 8) | b;
      if (transKey === -1) transKey = k;
      else if (transKey !== k) transMultiple = true;
    } else {
      opaque = false;
      hasPartial = true;
    }
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
  if (transMultiple) transKey = -1;
  return {
    grey,
    opaque,
    hasPartial,
    paletteable: counts.size <= 256,
    counts,
    firstSeen,
    greyLevels: greySet.size,
    transKey,
  };
}

// True when an opaque pixel uses this RGB triple, which would make a tRNS
// single key ambiguous (that pixel would wrongly decode as transparent).
function opaqueUsesColour(rgba: Uint8Array, rgbKey: number): boolean {
  const r = (rgbKey >> 16) & 255;
  const g = (rgbKey >> 8) & 255;
  const b = rgbKey & 255;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] === r && rgba[i + 1] === g && rgba[i + 2] === b && rgba[i + 3] === 255) return true;
  }
  return false;
}

// ---------------------------------------------------------------- Layouts
interface Layout {
  colourType: number;
  channels: number;
  data: Uint8Array; // samples, row-major, channels per pixel
  palette: Uint8Array | null; // RGB triples for colour type 3
  trns: Uint8Array | null; // chunk payload: trimmed palette alphas, or a tRNS key
  tag: string;
}

// Chunk overhead of a layout's PLTE/tRNS, in bytes (12 bytes per chunk).
function overhead(layout: Layout): number {
  return (layout.palette ? 12 + layout.palette.length : 0) + (layout.trns ? 12 + layout.trns.length : 0);
}

// Total PNG file bytes for a layout with a deflate stream of this length:
// 8 signature + 25 IHDR + 12 IDAT overhead + 12 IEND + PLTE/tRNS overhead.
function totalBytes(layout: Layout, deflateLen: number): number {
  return 57 + overhead(layout) + deflateLen;
}

// Greedy spatial ordering: start from the most frequent colour, then always
// place the unused colour most adjacent (right or below) to the colours
// already placed, so neighbours in the image get nearby palette indices.
function spatialOrder(
  width: number,
  height: number,
  indexData: Uint8Array,
  k: number,
  freq: Uint32Array,
  seen: Uint32Array,
): number[] {
  const adj = new Uint32Array(k * k);
  for (let y = 0; y < height; y++) {
    const base = y * width;
    for (let x = 0; x < width; x++) {
      const a = indexData[base + x];
      if (x + 1 < width) {
        const b = indexData[base + x + 1];
        if (a !== b) {
          adj[a * k + b]++;
          adj[b * k + a]++;
        }
      }
      if (y + 1 < height) {
        const b = indexData[base + width + x];
        if (a !== b) {
          adj[a * k + b]++;
          adj[b * k + a]++;
        }
      }
    }
  }
  const placed = new Uint8Array(k);
  const score = new Uint32Array(k);
  const order: number[] = [];
  for (let step = 0; step < k; step++) {
    let best = -1;
    for (let c = 0; c < k; c++) {
      if (placed[c]) continue;
      if (
        best === -1 ||
        score[c] > score[best] ||
        (score[c] === score[best] &&
          (freq[c] > freq[best] || (freq[c] === freq[best] && seen[c] < seen[best])))
      ) {
        best = c;
      }
    }
    placed[best] = 1;
    order.push(best);
    for (let c = 0; c < k; c++) {
      if (!placed[c]) score[c] += adj[c * k + best] + adj[best * k + c];
    }
  }
  return order;
}

// All palette layouts for an image with at most 256 distinct colours.
function paletteLayouts(decoded: Decoded, an: Analysis): Layout[] {
  const { width, height, rgba } = decoded;
  const n = width * height;
  const keys = [...an.counts.keys()];
  const k = keys.length;
  const tmp = new Map<number, number>();
  for (let i = 0; i < k; i++) tmp.set(keys[i], i);
  const indexData = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const key = rgba[i * 4] * 16777216 + rgba[i * 4 + 1] * 65536 + rgba[i * 4 + 2] * 256 + rgba[i * 4 + 3];
    indexData[i] = tmp.get(key) as number;
  }
  const R = new Uint8Array(k);
  const G = new Uint8Array(k);
  const B = new Uint8Array(k);
  const A = new Uint8Array(k);
  const freq = new Uint32Array(k);
  const seen = new Uint32Array(k);
  const lum = new Uint32Array(k);
  for (let i = 0; i < k; i++) {
    const key = keys[i];
    R[i] = Math.floor(key / 16777216);
    G[i] = Math.floor(key / 65536) % 256;
    B[i] = Math.floor(key / 256) % 256;
    A[i] = key % 256;
    freq[i] = an.counts.get(key) as number;
    seen[i] = an.firstSeen.get(key) as number;
    lum[i] = 299 * R[i] + 587 * G[i] + 114 * B[i];
  }
  const idx = [...Array(k).keys()];
  const byFreq = (a: number, b: number): number => freq[b] - freq[a] || seen[a] - seen[b];
  const orderings: { tag: string; order: number[] }[] = [];
  const push = (tag: string, order: number[]): void => {
    for (const o of orderings) {
      if (o.order.length === order.length && o.order.every((v, i) => v === order[i])) return;
    }
    orderings.push({ tag, order });
  };
  push('first', [...idx]);
  push('freq', [...idx].sort(byFreq));
  push('lum', [...idx].sort((a, b) => {
    // Transparent entries first (ascending alpha), then luminance for the
    // opaque ones, so a palette tRNS stays short when this ordering wins.
    const ta = A[a] < 255 ? 0 : 1;
    const tb = A[b] < 255 ? 0 : 1;
    return ta - tb || (ta === 0 ? A[a] - A[b] : lum[a] - lum[b]) || byFreq(a, b);
  }));
  // Transparent entries first (ascending alpha) so tRNS stays short.
  push('trans', [...idx].sort((a, b) => A[a] - A[b] || byFreq(a, b)));
  push('spatial', spatialOrder(width, height, indexData, k, freq, seen));
  const layouts: Layout[] = [];
  for (const { tag, order } of orderings) {
    const remap = new Uint8Array(k);
    for (let p = 0; p < k; p++) remap[order[p]] = p;
    const palette = new Uint8Array(k * 3);
    const alphas = new Uint8Array(k);
    for (let p = 0; p < k; p++) {
      const o = order[p];
      palette[p * 3] = R[o];
      palette[p * 3 + 1] = G[o];
      palette[p * 3 + 2] = B[o];
      alphas[p] = A[o];
    }
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = remap[indexData[i]];
    let trns: Uint8Array | null = null;
    let last = -1;
    for (let p = 0; p < k; p++) if (alphas[p] !== 255) last = p;
    if (last >= 0) trns = alphas.subarray(0, last + 1);
    layouts.push({ colourType: 3, channels: 1, data, palette, trns, tag: 'pal-' + tag });
  }
  return layouts;
}

function buildLayouts(decoded: Decoded, an: Analysis): Layout[] {
  const { width, height, rgba } = decoded;
  const n = width * height;
  if (an.grey) {
    const layouts: Layout[] = [];
    if (an.opaque) {
      // Grey only when every pixel is opaque: a constant alpha below 255
      // must NOT take this path (it would decode back as opaque).
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = rgba[i * 4];
      layouts.push({ colourType: 0, channels: 1, data, palette: null, trns: null, tag: 'grey' });
    } else if (!an.hasPartial && an.transKey >= 0 && !opaqueUsesColour(rgba, an.transKey)) {
      // One transparent grey value, no partial alpha: type 0 + tRNS key.
      const data = new Uint8Array(n);
      for (let i = 0; i < n; i++) data[i] = rgba[i * 4];
      const trns = new Uint8Array(2);
      trns[0] = 0;
      trns[1] = (an.transKey >> 16) & 255;
      layouts.push({ colourType: 0, channels: 1, data, palette: null, trns, tag: 'grey-key' });
    } else {
      const data = new Uint8Array(n * 2);
      for (let i = 0; i < n; i++) {
        data[i * 2] = rgba[i * 4];
        data[i * 2 + 1] = rgba[i * 4 + 3];
      }
      layouts.push({ colourType: 4, channels: 2, data, palette: null, trns: null, tag: 'grey-alpha' });
    }
    // Palette as a rival to grey when the grey levels are few (<= 64: with
    // more levels the PLTE overhead of up to 780 B can never win).
    if (an.paletteable && an.greyLevels <= 64) layouts.push(...paletteLayouts(decoded, an));
    return layouts;
  }

  if (an.paletteable) return paletteLayouts(decoded, an);

  if (an.opaque) {
    const data = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      data[i * 3] = rgba[i * 4];
      data[i * 3 + 1] = rgba[i * 4 + 1];
      data[i * 3 + 2] = rgba[i * 4 + 2];
    }
    return [{ colourType: 2, channels: 3, data, palette: null, trns: null, tag: 'rgb' }];
  }

  if (!an.hasPartial && an.transKey >= 0 && !opaqueUsesColour(rgba, an.transKey)) {
    // One transparent colour, no partial alpha: RGB + tRNS key, no alpha channel.
    const data = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) {
      data[i * 3] = rgba[i * 4];
      data[i * 3 + 1] = rgba[i * 4 + 1];
      data[i * 3 + 2] = rgba[i * 4 + 2];
    }
    const trns = new Uint8Array(6);
    trns[0] = 0;
    trns[1] = (an.transKey >> 16) & 255;
    trns[2] = 0;
    trns[3] = (an.transKey >> 8) & 255;
    trns[4] = 0;
    trns[5] = an.transKey & 255;
    return [{ colourType: 2, channels: 3, data, palette: null, trns, tag: 'rgb-key' }];
  }

  return [{ colourType: 6, channels: 4, data: rgba, palette: null, trns: null, tag: 'rgba' }];
}

// ---------------------------------------------------------------- Filtering
// Build the five fixed-filter streams plus two adaptive ones (minimum
// signed sum, fewest distinct byte pairs) for one layout, in a single pass.
function buildFilterStreams(layout: Layout, width: number, height: number): Uint8Array[] {
  const ch = layout.channels;
  const data = layout.data;
  const stride = width * ch;
  const rowLen = stride + 1;
  const streams: Uint8Array[] = [];
  for (let f = 0; f < 7; f++) streams.push(new Uint8Array(height * rowLen));
  // Distinct-pair stamps, shared across the five filters: mark y*5+f+1.
  const pairSeen = new Uint32Array(65536);
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const prv = y === 0 ? null : data.subarray((y - 1) * stride, y * stride);
    const sums = [0, 0, 0, 0, 0];
    const pairCount = [0, 0, 0, 0, 0];
    const markBase = y * 5;
    let p0 = 0;
    let p1 = 1;
    let p2 = 2;
    let p3 = 3;
    let p4 = 4;
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
      let key = (p0 << 8) | f0;
      if (pairSeen[key] !== markBase + 1) {
        pairSeen[key] = markBase + 1;
        pairCount[0]++;
      }
      p0 = f0;
      key = (p1 << 8) | f1;
      if (pairSeen[key] !== markBase + 2) {
        pairSeen[key] = markBase + 2;
        pairCount[1]++;
      }
      p1 = f1;
      key = (p2 << 8) | f2;
      if (pairSeen[key] !== markBase + 3) {
        pairSeen[key] = markBase + 3;
        pairCount[2]++;
      }
      p2 = f2;
      key = (p3 << 8) | f3;
      if (pairSeen[key] !== markBase + 4) {
        pairSeen[key] = markBase + 4;
        pairCount[3]++;
      }
      p3 = f3;
      key = (p4 << 8) | f4;
      if (pairSeen[key] !== markBase + 5) {
        pairSeen[key] = markBase + 5;
        pairCount[4]++;
      }
      p4 = f4;
    }
    let bestSum = 0;
    for (let f = 1; f < 5; f++) if (sums[f] < sums[bestSum]) bestSum = f;
    let bestPairs = 0;
    for (let f = 1; f < 5; f++) if (pairCount[f] < pairCount[bestPairs]) bestPairs = f;
    for (let f = 0; f < 5; f++) streams[f][y * rowLen] = f;
    streams[5][y * rowLen] = bestSum;
    streams[5].set(streams[bestSum].subarray(y * rowLen + 1, (y + 1) * rowLen), y * rowLen + 1);
    streams[6][y * rowLen] = bestPairs;
    streams[6].set(streams[bestPairs].subarray(y * rowLen + 1, (y + 1) * rowLen), y * rowLen + 1);
  }
  return streams;
}

// Filter one row with filter `f` into `out` (length stride+1, out[0] = f).
function filterRowInto(row: Uint8Array, prev: Uint8Array | null, ch: number, f: number, out: Uint8Array): void {
  out[0] = f;
  for (let i = 0; i < row.length; i++) {
    const a = i >= ch ? row[i - ch] : 0;
    const b = prev ? prev[i] : 0;
    const c = i >= ch && prev ? prev[i - ch] : 0;
    const v = row[i];
    let r = v;
    if (f === 1) r = v - a;
    else if (f === 2) r = v - b;
    else if (f === 3) r = v - ((a + b) >> 1);
    else if (f === 4) r = v - paeth(a, b, c);
    out[1 + i] = r & 255;
  }
}

// Brute-force filter choice: each band of `bandRows` rows is tried with every
// filter, each trial deflated at level 6 with the 32 KiB written before it as
// the dictionary; the smallest trial wins the band. bandRows = 1 is the
// per-row brute force; larger bands trade myopia for speed.
function bruteStream(layout: Layout, width: number, height: number, bandRows: number): Uint8Array {
  const ch = layout.channels;
  const data = layout.data;
  const stride = width * ch;
  const rowLen = stride + 1;
  const out = new Uint8Array(height * rowLen);
  const band = new Uint8Array(bandRows * rowLen);
  let pos = 0;
  for (let y0 = 0; y0 < height; y0 += bandRows) {
    const rows = Math.min(bandRows, height - y0);
    let bestF = 0;
    let bestLen = Infinity;
    for (let f = 0; f < 5; f++) {
      for (let r = 0; r < rows; r++) {
        const y = y0 + r;
        filterRowInto(
          data.subarray(y * stride, (y + 1) * stride),
          y === 0 ? null : data.subarray((y - 1) * stride, y * stride),
          ch,
          f,
          band.subarray(r * rowLen, (r + 1) * rowLen),
        );
      }
      const dict = pos > 0 ? out.subarray(Math.max(0, pos - DICT_BYTES), pos) : undefined;
      const trial = band.subarray(0, rows * rowLen);
      const len = dict
        ? deflateSync(trial, { level: 6, memLevel: 6, dictionary: dict }).length
        : deflateSync(trial, { level: 6, memLevel: 6 }).length;
      if (len < bestLen) {
        bestLen = len;
        bestF = f;
      }
    }
    for (let r = 0; r < rows; r++) {
      const y = y0 + r;
      filterRowInto(
        data.subarray(y * stride, (y + 1) * stride),
        y === 0 ? null : data.subarray((y - 1) * stride, y * stride),
        ch,
        bestF,
        out.subarray(pos + r * rowLen, pos + (r + 1) * rowLen),
      );
    }
    pos += rows * rowLen;
  }
  return out;
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
interface Candidate {
  stream: Uint8Array;
  layout: Layout;
  total: number;
  seq: number;
}

function squeezeOne(inputPath: string, outputPath: string): void {
  const input = readFileSync(inputPath);
  let png: Buffer;
  try {
    const decoded = decodePng(input);
    const an = analyse(decoded);
    const layouts = buildLayouts(decoded, an);

    // Keep the three best candidates by TOTAL file bytes; the rest are
    // discarded, so at most three filtered streams are held at once.
    const pool: Candidate[] = [];
    let seq = 0;
    const offer = (stream: Uint8Array, layout: Layout, knownTotal?: number): void => {
      const total = knownTotal ?? totalBytes(layout, deflateSync(stream, { level: 6 }).length);
      const cand: Candidate = { stream, layout, total, seq: seq++ };
      if (pool.length < 3) {
        pool.push(cand);
        return;
      }
      let worst = 0;
      for (let i = 1; i < pool.length; i++) {
        if (pool[i].total > pool[worst].total || (pool[i].total === pool[worst].total && pool[i].seq > pool[worst].seq)) {
          worst = i;
        }
      }
      if (total < pool[worst].total || (total === pool[worst].total && cand.seq < pool[worst].seq)) {
        pool[worst] = cand;
      }
    };

    let cheapBestLayout: Layout | null = null;
    let cheapBestTotal = Infinity;
    for (const layout of layouts) {
      const streams = buildFilterStreams(layout, decoded.width, decoded.height);
      for (const stream of streams) {
        const total = totalBytes(layout, deflateSync(stream, { level: 6 }).length);
        if (total < cheapBestTotal) {
          cheapBestTotal = total;
          cheapBestLayout = layout;
        }
        offer(stream, layout, total);
      }
    }
    // Deterministic "heavy image" flag from the cheap level-6 totals: no
    // clock, no randomness. Heavy images get fewer brute bands and fewer
    // level-9 calls, where one call costs ~1 s of CPU for ~100 points.
    const heavy = cheapBestTotal > 220000;
    // Brute force on the cheapest layout only (a second brute target never
    // won a byte in practice): per-row and per-band. The per-row brute
    // force costs one deflate per row per filter, which only pays on narrow
    // non-palette grey rows; wide layouts (RGB/RGBA) get the band brute
    // forces alone. Two band widths are tried: 8-row bands won some images,
    // 16-row bands others (less myopic); heavy images skip the 8-row bands.
    if (cheapBestLayout) {
      const layout = cheapBestLayout;
      const stride = decoded.width * layout.channels;
      if (stride <= 2048 && layout.colourType !== 3 && !heavy) {
        offer(bruteStream(layout, decoded.width, decoded.height, 1), layout);
      }
      if (!heavy) offer(bruteStream(layout, decoded.width, decoded.height, BRUTE_BAND_ROWS), layout);
      offer(bruteStream(layout, decoded.width, decoded.height, BRUTE_BAND_ROWS_WIDE), layout);
    }
    if (pool.length === 0) throw new Error('no candidate stream');
    pool.sort((a, b) => a.total - b.total || a.seq - b.seq);

    // Final deflate: screen the three surviving candidates cheaply first
    // (level 7, or 6 when the image is heavy, at the memLevel that wins for
    // the candidate's channel count: 5 for 1-channel, 6 otherwise), then
    // level 9 only on the screening winner — 3 calls normally, 1 call plus
    // a level-8 check on the alternate memLevel when heavy. A level-9 call
    // on a big photo costs ~1 s of CPU, and memLevel 8 never won, so the old
    // 10-call sweep (6 at memLevel 8, then 4 at 5/6) was pure waste.
    // (Cutting the final to the top two cost 288 bytes on practice i005,
    // whose winner was the third candidate, so all three stay in the pool.)
    let bestBuf: Buffer | null = null;
    let bestTotal = Infinity;
    let bestLayout: Layout | null = null;
    const consider = (
      stream: Uint8Array,
      layout: Layout,
      level: number,
      memLevel: number,
      strategy: number,
    ): number => {
      const buf = deflateSync(stream, { level, memLevel, strategy });
      const total = totalBytes(layout, buf.length);
      if (total < bestTotal) {
        bestTotal = total;
        bestBuf = buf;
        bestLayout = layout;
      }
      return total;
    };
    const screenLevel = heavy ? 6 : 7;
    let screenBest: { stream: Uint8Array; layout: Layout; ml: number; strategy: number } | null = null;
    let screenBestTotal = Infinity;
    for (const cand of pool) {
      const ml = cand.layout.channels === 1 ? 5 : 6;
      for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_FILTERED]) {
        const total = consider(cand.stream, cand.layout, screenLevel, ml, strategy);
        if (total < screenBestTotal) {
          screenBestTotal = total;
          screenBest = { stream: cand.stream, layout: cand.layout, ml, strategy };
        }
      }
    }
    if (screenBest) {
      const alt = screenBest.ml === 5 ? 6 : 5;
      if (!heavy) {
        consider(screenBest.stream, screenBest.layout, 9, screenBest.ml, constants.Z_DEFAULT_STRATEGY);
        consider(screenBest.stream, screenBest.layout, 9, screenBest.ml, constants.Z_FILTERED);
        consider(screenBest.stream, screenBest.layout, 9, alt, screenBest.strategy);
      } else {
        consider(screenBest.stream, screenBest.layout, 9, screenBest.ml, screenBest.strategy);
        consider(screenBest.stream, screenBest.layout, 8, alt, screenBest.strategy);
      }
    }
    if (!bestBuf || !bestLayout) throw new Error('no candidate stream');
    png = writePng(bestLayout, decoded.width, decoded.height, bestBuf);
    // Sanity: the answer must decode back to the same pixels. If anything is
    // off, fall back to the input file (a valid, if large, answer).
    const check = decodePng(png);
    const asBuf = (u: Uint8Array): Buffer => Buffer.from(u.buffer, u.byteOffset, u.byteLength);
    if (
      check.width !== decoded.width ||
      check.height !== decoded.height ||
      Buffer.compare(asBuf(check.rgba), asBuf(decoded.rgba)) !== 0
    ) {
      throw new Error('round-trip mismatch');
    }
    if (png.length > MAX_BYTES) throw new Error('answer over 4 MiB');
  } catch {
    // Fallback: copy the input (stored PNG, always in the accepted format).
    png = input;
  }
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
