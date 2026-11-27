# png-squeeze-01-run-20261127-ka

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127/hiduplahzomb/png-squeeze-01-run-20261127-ka/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127/hiduplahzomb/png-squeeze-01-run-20261127-ka/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

Lossless PNG squeezer for the make.fun `png-squeeze-01-run-20261127` bounty:
it reads eight 1280x720 screenshots and rewrites each one as the smallest
lossless PNG it can, every pixel decoding exactly as the original — including
the colour of fully transparent pixels.

## How it works (`main.ts`, Node built-ins only, no installs)

1. **Decode** each input PNG to raw RGBA (inflate + unfilter, any colour type,
   8-bit, non-interlaced). The decoder verifies every chunk CRC, rejects
   filter bytes above 4, and applies `tRNS` for colour types 0, 2 and 3
   (single transparent key for 0/2, per-index alpha for 3).
2. **Reduce the colour model** when it is exact: palette (colour type 3, at
   most 256 distinct colours, in five orderings — first-seen, frequency,
   luminance, transparent-entries-first so `tRNS` stays short, and a
   spatial-neighbour greedy), grey (only when every pixel is opaque) /
   grey+alpha, RGB / RGB + `tRNS` key (when there is exactly one fully
   transparent colour, no partial alpha, and no opaque pixel uses it),
   otherwise RGBA. A palette is also tried as a rival to grey when the grey
   levels are few.
3. **Filter search**: for each layout, every row is filtered with all five
   PNG filters, plus adaptive choices (minimum signed sum, fewest distinct
   byte pairs, and brute force — per row, or per band of 8 / 16 rows, each
   filter deflated against the 32 KiB written before it). Candidates are
   ranked by TOTAL file bytes (deflate stream + `PLTE`/`tRNS` chunk
   overhead), and the best three survive to the final deflate.
4. **Compress**: the surviving candidates at zlib level 9, default and
   `Z_FILTERED` strategies, then a memLevel 5–6 sweep on the winner.
5. **Write** a minimal PNG: `IHDR`, `PLTE`/`tRNS` only when needed, a
   single `IDAT`, `IEND`. A round-trip decode check (`Buffer.compare`) runs
   per instance; on any failure the program falls back to copying the
   (valid) input file, so every instance stays answered.

Deterministic: fixed work only — no clock, no randomness, no environment
input besides the input/output directory paths. A run takes ~28 s for the
practice set (limit 60 s); peak memory ~335 MB (limit 512 MB).

## Run

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Practice result

Score **719,206** (baseline fixed-paeth: 420,399; previous version of this
entry: 700,915), all 8 instances answered exactly:

| instance | theme | bytes | points |
|----------|-------|------:|-------:|
| i001 | flat  |  12,309 | 727.572 |
| i002 | rich  |  48,228 | 749.416 |
| i003 | alpha | 103,069 | 696.468 |
| i004 | grey  | 105,110 | 699.304 |
| i005 | flat  |  16,318 | 750.607 |
| i006 | rich  | 176,625 | 697.859 |
| i007 | alpha |  60,168 | 709.358 |
| i008 | grey  |  24,539 | 723.061 |

Also checked on three extra sets drawn with the kit generator (other seeds):
712,687 / 737,376 / 730,221, all 8 instances exact each time; plus manual
edge cases (grey with constant alpha 128, palette + `tRNS`, RGB + `tRNS`
key, grey + varying alpha) all decode exactly with the kit's own decoder.
