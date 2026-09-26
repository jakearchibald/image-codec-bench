# image-codec-bench

Sweeps one image through `avifenc` and `cjxl` across quality × effort, scores every output
with SSIMULACRA2, and emits a console table, CSV, and a self-contained HTML report with
rate-distortion charts and a visual flicker comparison.

Zero runtime dependencies — just Node 22+ and the codec CLIs (plus `cargo` for HDR input).

## Install

```sh
brew install libavif libjxl webp imagemagick   # avifenc/avifdec, cjxl/djxl/ssimulacra2, cwebp/dwebp, magick
```

A `doctor` check runs on every invocation and records tool versions into `results.json`,
since scores and timings are only comparable within one toolchain version.

## Use

```sh
node src/cli.js photo.png                  # defaults: AVIF q20:90:5 × s0..6, JXL q15:90:5 × e7..10
node src/cli.js photo.png --dry-run        # print job count and ETA, encode nothing
node src/cli.js photo.png --avif-speed 4,6 --jxl-effort 7,9 --avif-quality 30:90:15
node src/cli.js photo.png --max-pixels 2MP --timing multi
node src/cli.js photo.png --no-timing      # quality only — much faster
```

### Skipping the timing measurement

Timing is the expensive part of a run: by default each job is encoded up to
`--repeats` (3) times *per threading mode*, purely to get a stable number. If you only
care about the quality curve, `--no-timing` (or `--timing none`) encodes each job exactly
once and records no times — measured **3.8× faster** on the same grid (40.9s → 10.7s).

Scores and file sizes are unaffected: encoder output is deterministic, so a file encoded
once is byte-identical to one from a timed run (verified — 12/12 jobs identical). The
report drops the encode-cost chart and the timing columns, and says why.

`--dry-run` is the intended way to size a run before committing: the default grid is
~170 jobs, and `avifenc -s 0` alone is roughly 2.5 minutes per encode at 12MP.

Ranges accept `min:max:step`, `a-b`, or a comma list. `node src/cli.js --help` lists
every flag.

Runs are **resumable**: results are keyed by a hash of (reference bytes, encode params,
tool versions), so re-running skips completed jobs and Ctrl-C is safe at any point. Use
`--force` to ignore the cache.

### Second metric: ColorVideoVDP (`--cvvdp`)

`--cvvdp` also scores every file with [ColorVideoVDP](https://github.com/gfxdisp/ColorVideoVDP),
from a lab with no connection to either codec (SSIMULACRA2 shares authorship with libjxl).
The report then has a second rate/distortion chart with JOD on the x axis
("just-objectionable differences": 10 = no visible difference), and the table and CSV gain
a `cvvdp` column. It works for SDR and HDR runs.

It is optional because it is a Python + PyTorch install (~1 GB):

```sh
python3 -m venv tools/cvvdp/.venv
tools/cvvdp/.venv/bin/pip install -r tools/cvvdp/requirements.txt
```

- **The display model decides the scores.** SDR runs assume cvvdp's `standard_4k` (30" 4K,
  200 cd/m², office lighting, 2× display height away); HDR runs `standard_hdr_pq` (1500 cd/m²,
  10 lux). At that distance fine artefacts are hard to see, so scores cluster near 10.
- cvvdp ignores the files' colour tags and reads pixels in the display's colour space, so
  each run writes its own display definition matching the reference (e.g. P3 PQ).
- It runs one file at a time, about 5 seconds each at 5 MP, alongside the normal scoring.
- Its version and display model are stored with each score, not put in the cache key:
  turning `--cvvdp` on, upgrading it, or changing display only re-scores, never
  re-encodes. Runs without `--cvvdp` keep stored JODs but don't show them.
- Unlike SSIMULACRA2 it has no cliff just below a perfect score: a lossless gain-map AVIF,
  rendered at 12-bit against a 16-bit reference, scores exactly 10.

### HDR input (an HDR PNG plus an SDR PNG)

An HDR PNG (PQ, stated by a `cICP` chunk or an ICC profile's `cicp` tag, as Photoshop
writes) switches the run to HDR mode. It needs the SDR rendition of the same image too:

```sh
node src/cli.js neon-hdr.png --sdr neon-sdr.png --no-timing
```

- **AVIF** is a gain-map image: the SDR PNG as its base, plus a gain map computed by
  `avifgainmaputil combine` so that applying it in full reproduces the HDR PNG. The gain
  map's quality tracks `-q` (its default is 60 whatever `-q` is); it is 8-bit, full
  resolution. `-d`/`-y` apply to the base.
- **JXL** encodes the HDR PNG as PQ. Linear-light JXL looked closer to the gain map in
  Chrome but was wrong in Safari, and much of the difference depended on monitor brightness.
- **Scoring** compares against the HDR PNG at full precision. AVIF gain maps are rendered
  in full by libavif's tone mapper (at most 12-bit), JXL by djxl at 16-bit. The SDR
  rendition is not scored.
- **The metric** is fast-ssim2's experimental PU21 mode (`compute_ssimulacra2_pu_nits`),
  via [`tools/hdr-ssim2`](tools/hdr-ssim2), built with `cargo` as needed. These scores are
  not on the same scale as SDR SSIMULACRA2.
- **The report's original** is the HDR PNG as given, and what the comparison flips back to.

That 12-bit limit matters because SSIMULACRA2 is extremely steep near 100: changing one
value by one code in a 16-bit image scores ~96.7, and rounding a 16-bit image to 15-bit
scores ~89. So an AVIF can't score much above ~89 against the 16-bit reference however
good it is, and near the top of the range the curves aren't directly comparable. The
report says so.

Requirements and limits:

- The libavif tools are taken from `~/dev/libavif/build` when present (override with
  `LIBAVIF_BUILD`), falling back to PATH, all three from the same build.
- Colour goes into the files as CICP. The HDR PNG must be PQ and the SDR PNG must use the
  sRGB curve, each in sRGB, Display P3 or BT.2020 primaries; an ICC profile is accepted
  when it has a `cicp` tag or is recognisably one of those. Anything else is refused
  rather than approximated.
- Both PNGs must be the same size, RGB without alpha; the HDR one 16-bit.
- No lossless suite, and no `--max-pixels`: downscale both PNGs first.
- Gain-map JPEGs are refused rather than run as SDR; export the two PNGs instead.

## Output

Written to `out/<image-stem>-<hash8>/`:

| File | Contents |
|---|---|
| `reference.png` | what everything was measured against: the normalised 8-bit sRGB source, or in HDR mode the HDR PNG's pixels with only a `cICP` chunk |
| `results.json` | this run's grid plus run metadata; what the report is built from |
| `full-results.json` | every job ever measured against this reference; the resume cache |
| `results.csv`, `lossless.csv` | the same numbers, flat (including decode times) |
| `assets/` | one bitstream per job; accumulates, like `full-results.json` |
| `report-assets/` | only the files `report.html` links, including a copy of the input file (the report's "original"); rebuilt each run |
| `report.html` | charts, visual comparison, lossless table, caveats |
| `assets/` | the encoded `.avif`/`.jxl`/`.webp` bitstreams the report links |

The report is a pure function of `results.json`, so it can be rebuilt without re-encoding.

Results accumulate across runs so that resume works, but the outputs only ever show the
grid you asked for. Re-running with a narrower `--avif-speed` reports just those series;
the earlier ones stay in `full-results.json` and are reused rather than re-encoded.

> The report loads Chart.js from a CDN, so viewing it needs network access.

## How it works

1. **Normalise once** to an 8-bit sRGB PNG with colour chunks stripped, so no encoder
   interprets an embedded profile differently. Alpha is preserved.
2. **Phase 1 — encode, strictly serial.** Nothing else runs concurrently, so timings are
   not polluted. Each job is timed in single-thread and/or all-cores mode, up to
   `--repeats` times, bailing early once `--repeat-budget` is spent. Best-of-N is the
   headline figure; the mean is recorded too.
   With `--no-timing` this phase encodes each job once, all cores, untimed.
3. **Phase 2 — score, parallel.** Decode at the reference's bit depth, score with
   SSIMULACRA2, delete the decoded PNG immediately (they are megabytes each).
4. **Lossless sweep** for JXL, WebP and AVIF across effort levels — `avifenc -s` and
   `cjxl -e` reuse the lossy ranges, `cwebp -z` uses `--webp-effort` (default 0-9). Every
   point is asserted bit-exact *and* asserted to score exactly 100.00.
5. **Phase 3 — browser decode timing, serial.** `createImageBitmap` in a real browser,
   driven over classic W3C WebDriver, for the lossy grid and the lossless rows. Mean of up
   to `--decode-repeats` runs after discarded warm-up, with the spread recorded.

Decode targets are chosen with `--decode-browsers` (default `firefox`; `all` for every
one). Firefox Nightly is the default because it is the finer instrument — 0.02ms timer
granularity against Chrome's 0.1ms, which matters when the fastest decodes are around 1ms:

| target | driver | notes |
|---|---|---|
| `chrome` | chromedriver | **Canary required** — stable Chrome cannot decode JPEG XL |
| `firefox` *(default)* | geckodriver | **Nightly required**; sets `image.jxl.enabled` and turns off `privacy.reduceTimerPrecision`, which otherwise clamps the clock to 1ms |
| `safari` | safaridriver (built in) | needs Develop → *Allow Remote Automation* once, by hand; no headless mode, so a window opens |

To discard stored decode results so the next run re-measures them:

```
node src/cli.js <image> --drop-decode safari      # or chrome,firefox / all
```

It edits both `full-results.json` and `results.json`, clears the browser from the run
metadata, and exits without running anything. Scores, encode timings and bitstreams are
left alone, so re-running only re-measures decode.

A version-matched chromedriver and a geckodriver are downloaded and cached under
`~/.cache/image-codec-bench/drivers` if PATH has nothing suitable. Override with
`--chromedriver` / `--geckodriver` / `--safaridriver`. Decode figures are comparable
*within* a browser, not across — each engine has its own decoders and timer resolution — so
Chart 3 has a browser selector rather than putting them on shared axes.

Jobs run in **bisection order** on the quality axis (`min, max, mid, ¼, ¾, …`) and are
**interleaved across series**, so an interrupted run still has a correctly-shaped curve for
every series rather than only the low-quality end. Progress and ETA are weighted by
estimated time rather than job count, refined by an EMA as real measurements arrive.

## Things that are easy to get wrong

These are load-bearing, each verified by running it:

- **`avifdec` output cannot be scored as-is.** It writes a `cICP` chunk that libjxl's PNG
  reader rejects outright (`Could not decode distorted image`). [`src/png.js`](src/png.js)
  strips colour chunks with a dependency-free chunk walk, keeping a second image library
  out of the colour-management path.
- **Decode at the reference's bit depth, never wider.** `avifdec -d 16` scores *higher*
  than `-d 8`, but that gain is an artefact: a bit-exact lossless round-trip scores
  100.00 at 8-bit and 98.33520916 at 16-bit, and that 1.665 penalty is identical for AVIF
  and JXL. So every decode is pinned to the reference depth — which gives a free
  self-check, since lossless must then score *exactly* 100.00. The run asserts it.
- **A 16-bit reference invalidates everything silently.** `magick plasma:` writes 16-bit
  PNG without saying so, which makes 8-bit-only `cwebp` look like it is winning on
  lossless when it is really quantising. The reference is asserted 8-bit.
- **`cwebp` needs `-exact`** or lossless is not lossless: it rewrites RGB under fully
  transparent pixels, and the round-trip is not bit-exact. Costs ~0.16%, non-negotiable.
- **Transparent pixels are scored free.** Two fully-transparent images with completely
  different RGB content score exactly 100.00. Alpha-heavy images therefore show inflated
  absolute scores; the report says so rather than averaging it away.
- **`avifenc -q` and `cjxl -q` are different scales** and are never compared directly. The
  quality axis only generates points; comparison happens against measured SSIMULACRA2. The
  report warns if the two codecs' score ranges fail to overlap.

## Caveats on the numbers

SSIMULACRA2 shares authorship with libjxl, so it is not a neutral referee between JXL and
AVIF — hence the visual comparison, so the metric can be spot-checked by eye. Encode
timings include process spawn overhead (measured and reported, never subtracted). One image
is not a corpus. The full list is rendered into every report.

## Tests

```sh
npm test
```

Covers the PNG chunk walk, bisection/interleave ordering and its span property, range and
duration parsing, codec argv construction, and the scoring assertions.

## Not included

Subsampling beyond `--avif-yuv`, lossy WebP/JPEG baseline curves
(lossless WebP is in), BD-rate aggregation across a corpus.
