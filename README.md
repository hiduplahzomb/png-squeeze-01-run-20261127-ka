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
   8-bit, non-interlaced).
2. **Reduce the colour model** when it is exact: palette (colour type 3, at
   most 256 distinct colours, tried in first-occurrence and
   most-frequent-first order, with `tRNS` when any alpha is below 255),
   grey / grey+alpha (when R==G==B everywhere), RGB (when fully opaque),
   otherwise RGBA.
3. **Filter search**: for each layout, every row is filtered with all five
   PNG filters, plus a sum-of-absolute-values adaptive choice; the streams
   are ranked with zlib level 6 and the best one wins. (On these
   screenshots a fixed filter — often None, which keeps whole repeated rows
   matchable — beats the usual adaptive heuristic.)
4. **Compress** the winner with zlib level 9, trying both the default and
   the `Z_FILTERED` strategies, keeping the smaller stream.
5. **Write** a minimal PNG: `IHDR`, `PLTE`/`tRNS` only when needed, a
   single `IDAT`, `IEND`. A round-trip decode check runs per instance; on
   any failure the program falls back to copying the (valid) input file,
   so every instance stays answered.

Deterministic: fixed work only — no clock, no randomness, no environment
input besides the input/output directory paths. A run takes ~6 s for all
eight practice instances (limit 60 s).

## Run

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Practice result

Score **700,915** (baseline fixed-paeth: 420,399), all 8 instances answered
exactly. See the run report for the per-instance table.
