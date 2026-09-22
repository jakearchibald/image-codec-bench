# Image Codec Benchmark Plan

Node scripts that take an input image, sweep it through `avifenc` and `cjxl` across
quality × effort, score each output with SSIMULACRA2, and emit a table plus an HTML
report with rate-distortion charts and a visual flicker comparison.

## 1. Verified environment

Probed on this machine (2026-09-22), all present:

| Tool | Version | Notes |
|---|---|---|
| `avifenc` / `avifdec` | 1.4.2 | aom 3.14.1 enc, dav1d 1.5.3 dec, libyuv unavailable |
| `cjxl` / `djxl` | 0.12.0 | NEON, 14 threads by default |
| `ssimulacra2` | libjxl build | `ssimulacra2 original.png distorted.png` → score on stdout |
| `cwebp` / `dwebp` | 1.6.0 | libsharpyuv 0.4.2; 8-bit only, max 16383px per side |
| `magick` | 7 | used only for input normalisation |
| `node` | 24.19.0 | `util.parseArgs`, `node:test` available; no deps needed |

Machine: 14 logical cores (10 performance). A `doctor` step runs these checks on every
invocation and records tool versions into the results file, since scores and timings are
only comparable within one toolchain version.

## 2. Findings from the spike (these drive the design)

Seven things that are easy to get wrong and that I confirmed by running them:

1. **`avifdec` output cannot be scored as-is.** `avifdec` writes a `cICP` PNG chunk, and
   libjxl's PNG reader rejects the file: `Could not decode distorted image: a.png`. The
   fix is to strip the `cICP` chunk from the PNG before scoring — a ~30-line chunk walk in
   Node, no dependencies, no pixel round-trip. Re-encoding through ImageMagick instead
   turns out to be score-identical on an 8-bit pipeline (68.79089283 either way, verified),
   so this is a preference rather than a correctness requirement — but stripping the chunk
   keeps a second image library out of the hot loop and out of the colour-management path.
2. **Decode at the reference's bit depth — never wider.** This one bit me: I initially
   concluded "decode at 16-bit" because `avifdec -d 16` scores slightly *higher* than
   `-d 8` (68.856 vs 68.791 on an 8-bit reference). That extra fraction is an artefact, not
   fidelity. Proof: a **bit-exact lossless** round-trip (`cmp` verified identical) scores
   **100.00 when decoded at 8-bit, but 98.33520916 when decoded at 16-bit** — and that
   1.6648 penalty is *identical* for AVIF and JXL, so it's a pure depth-mismatch artefact
   of comparing a 16-bit distorted image against an 8-bit reference.
   So: `avifdec -d 8` and `djxl` at the reference depth (its default already matches an
   8-bit source). 10-bit AVIF also decodes back to 8-bit — which is what a browser does for
   an 8-bit display pipeline anyway.
   **This gives a free self-check:** with depths matched, every lossless codec must score
   exactly 100.00. The run asserts it, so any future regression in this area is caught
   immediately rather than quietly shifting every number.
3. **Thread control.** `avifenc -j 1` and `cjxl --num_threads=0` (`0` = no
   multithreading; the flag only appears in `cjxl -v -v --help`). `cjxl` errors on unknown
   arguments, so there is no silent-ignore risk; `avifenc` only warns for `-a` keys.
4. **The reference image's bit depth is load-bearing, and easy to get wrong silently.**
   My first spike used `magick plasma:` as a test source, which writes a **16-bit** PNG
   without saying so. Every consequence was misleading: `cwebp` (8-bit only) appeared to
   produce a 339KB "lossless" file against JXL's 925KB — it was quantising, not winning —
   and lossless AVIF wasn't lossless either, since AVIF caps at 12-bit. So the run
   **asserts the normalised reference is 8-bit** and records its depth in `results.json`.
   With a proper 8-bit reference the lossless sizes land in a plausible order (§7).
5. **Transparent pixels are scored free.** Two fully-transparent images with completely
   different RGB content score **exactly 100.00** (verified on clean 8-bit files). Alpha is
   blended onto a fixed backdrop before comparison, so scores for alpha-heavy images are
   inflated and are *not* comparable with scores for opaque images. Reported as a caveat,
   not silently averaged in. An opaque alpha channel, by contrast, costs nothing — RGB vs
   opaque RGBA with identical pixels scores exactly 100.00.
6. **`cwebp` needs `-exact` or lossless isn't lossless.** Without it, cwebp rewrites RGB
   values under fully-transparent pixels to compress better, and the round-trip is not
   bit-exact (verified). `-exact` costs +0.16% (363,796 vs 363,210 bytes) and is
   non-negotiable for a table claiming losslessness.

7. **aom's output depends on thread count, so the timing sweep must not own the
   artefact.** `avifenc -j 1` and `-j all` produce *different bitstreams*: at `-s 0`,
   23,408 vs 22,955 bytes — a 2% gap, the same order as the codec differences being
   measured. `avifenc --lossless` differs too (353,489 vs 353,496). cjxl and cwebp are
   unaffected (byte-identical either way). Consequence: encoding into one path per timing
   mode makes whichever mode ran last silently define every file size and score, so the
   rate-distortion curve would depend on `--timing`. The fix is to encode the measured
   artefact once in a fixed mode (all-cores) and send the timing runs to a scratch path.
   Found while reviewing the implementation, not while writing this plan.

Measured timings at 0.2MP (512×384) to sanity-check cost:

| Config | All cores | Single thread |
|---|---|---|
| `avifenc -s 0` | 2.44s | 6.05s |
| `avifenc -s 2` | 1.05s | 2.58s |
| `avifenc -s 4` | 0.26s | 0.61s |
| `avifenc -s 6` | 0.03s | 0.06s |
| `cjxl -e 7` | 0.03s | 0.07s |
| `cjxl -e 8` | 0.14s | 0.20s |
| `cjxl -e 9` | 0.21s | 0.27s |
| `cjxl -e 10` | 0.21s | 0.28s |
| `ssimulacra2` | 0.03s | — |

`avifenc -s 0` is ~80× `-s 6`, and AVIF dominates the whole grid: one `-s 0` encode costs
more than every `cjxl` effort combined. Cost scales with pixel count, so `-s 0` is roughly
2.5 min per encode at 12MP. Grid size therefore has to be a per-run decision, which is what
§4 covers. Note `cjxl -e 10` is no slower than `-e 9` here, and AVIF's thread scaling is
only ~2.5× on 14 cores — which is exactly why both timing columns are worth having.

## 3. Methodology

Pipeline per benchmark job:

1. **Normalise once.** Convert the input to a canonical reference: 8-bit sRGB PNG, metadata
   stripped, via `magick`. Both encoders and the scorer read this one file, so no encoder
   gets to interpret an embedded ICC profile differently. **Alpha is preserved**, not
   flattened — both codecs carry it through and both decoders round-trip RGBA correctly
   (verified — and an opaque alpha channel costs no score, per finding 5). The reference is
   asserted to be **8-bit sRGB**, its depth and channel count are recorded in
   `results.json`, and every decode is pinned to that depth per finding 2. Colour-related
   PNG chunks are stripped so no downstream tool can apply its own transform. Optional
   `--max-pixels N` Lanczos downscale for keeping big sources tractable.
2. **Encode** from `reference.png` to the codec's bitstream.
3. **Decode** the bitstream to a PNG **at the reference's bit depth** (`avifdec -d 8` +
   strip `cICP`, `djxl --bits_per_sample=8`, `dwebp`) — see finding 2.
4. **Score** `ssimulacra2 reference.png decoded.png`, parse the float from stdout.
5. **Record** codec, quality, effort, depth, subsampling, file size, bpp, score, and both
   timing figures.

Two-phase execution, which matters for timing integrity:

- **Phase 1 — encode (strictly serial).** Nothing else runs concurrently, so timings are
  not polluted. Bitstreams are kept on disk (they are small).
- **Phase 2 — score (parallel).** Decode + score runs across cores; each decoded PNG is
  deleted immediately after scoring. Keeping all of them is not an option — decoded PNGs of
  a 2MP image are several MB each, so a 500-job grid runs to gigabytes. Nothing needs
  retaining: the
  report links the encoded bitstreams directly (§7), so decodes exist only long enough to be
  scored.

Timing details:

- Both `--timing single` and `--timing multi` are collected as separate columns, per the
  decision to measure both.
- Each job is encoded up to `--repeats` times (default 3) but bails early once cumulative
  time for that job exceeds `--repeat-budget` (default 2s), so cheap configs get averaged
  and `-s 0` runs once.
- **`--timing none` / `--no-timing` skips timing entirely** — each job is encoded exactly
  once, all cores, with no repeats and no threading sweep. Timing is the expensive part of a
  run (3 repeats × 2 modes), so this is ~4-8× faster and is the right default when you only
  want the quality curve. Scores and sizes are unchanged, since encoder output is
  deterministic. The report drops chart 2 and the timing columns and states why.
- **Report best-of-N as the primary figure**, with mean also recorded. Benchmark noise is
  one-sided, so the minimum is the cleaner estimate; the mean is kept so the spread is
  visible.
- Timings include process spawn (~5-15ms). Measured once at startup and reported in the
  report's caveats rather than subtracted, so no numbers are silently adjusted.
- The **all-cores encode is the canonical one**: it produces the file that gets sized and
  scored, and it doubles as the first sample of the all-cores timing. Single-thread runs
  write to a scratch path, so for AVIF the single-thread column times the same *settings*
  but not byte-for-byte the same *file* (finding 7). Each recorded timing carries a
  `canonical` flag saying which is which.

## 4. Configuration

Everything that affects runtime is configurable per run, via CLI flags or `--config
bench.json`. Ranges use `min:max:step`, or an explicit comma list.

```
node src/cli.js photo.png \
  --avif-quality 20:90:5 --avif-speed 0-6 --avif-depth 8,10 --avif-yuv 444,420 \
  --avif-qalpha match \
  --jxl-quality 15:90:5  --jxl-effort 7-10 \
  --timing single,multi --repeats 3 --repeat-budget 2s \
  # ...or --no-timing for a fast quality-only run (no encode times) \
  --max-pixels 0 --score-concurrency 8 --lossless --out out/
```

Defaults match the original plan: AVIF `-q 20:90:5` × `-s 0..6` × 4:4:4, JXL `-q 15:90:5`
× `-e 7..10`. `--avif-depth` and `--avif-yuv` both take lists, and each combination is its
own series — so they multiply the AVIF grid, which is already the expensive half. With the
default quality and speed ranges, `--avif-yuv 444,422,420` takes the run from 169 jobs to
379. `--dry-run` calibrates and prints the job count and ETA without running the
full grid — the intended way to size a run before committing to it.

Note that `avifenc -q` and `cjxl -q` are **different scales** and are never compared
directly. The quality axis only exists to generate points; every comparison happens against
measured SSIMULACRA2 on the x-axis. The quality ranges therefore just need to be wide
enough that the two codecs' score ranges overlap — the report emits a warning if they
don't, since non-overlapping curves cannot be read against each other.

## 5. Scheduling, progress, and ETA

To make progress roughly linear and partial runs useful:

- **Calibrate first.** One encode per series (a *series* = codec × effort × depth) at the
  midpoint quality, in both threading modes. This gives a per-series cost estimate up front
  so the very first ETA is meaningful, and it warms the page cache for the reference image.
- **Bisection order on the quality axis.** Each series orders its quality points
  `[min, max, mid, ¼, ¾, …]` rather than ascending. A run aborted halfway still has a
  correctly-shaped curve for every series instead of only the low-quality end.
- **Interleave across series.** Round *r* takes the *r*-th quality point of every series, so
  each round mixes `-s 6` (cheap) with `-s 0` (expensive). Estimation error averages out
  instead of accumulating, and an interrupted run has coverage across the whole grid.
- **Cost-weighted progress.** The progress bar is weighted by *estimated time*, not job
  count, so it advances at a roughly constant rate. Per-series estimates are refined with an
  exponential moving average as real measurements arrive, so the ETA self-corrects.

```
[████████▏          ] 41%  183/520 jobs  elapsed 6m12s  eta 8m51s (done ~14:32)
  now: avif q45 s0 10bit  (run 1/3)
```

- **Resumable.** Results are appended to `full-results.json` keyed by a hash of (reference image
  bytes, codec, all encode params, tool versions). Re-running skips completed jobs;
  `--force` ignores the cache. Ctrl-C is safe at any point. This matters because a
  full-resolution run is a multi-hour commitment.

## 6. Outputs

Written to `out/<image-stem>-<hash8>/`:

- `reference.png` — the normalised source everything was measured against.
- `full-results.json` — every job ever measured against this reference. Accumulates across
  runs, which is what makes resume work; not an output to read.
- `results.json` — **only this run's grid**, plus run metadata: tool versions, machine, core count, config,
  spawn overhead, timestamps. The source of truth; the report is a pure function of it.
- `results.csv` and a console table — codec, quality, effort, depth, size, bpp,
  SSIMULACRA2, encode time (single, best/mean), encode time (multi, best/mean).
- `report.html` — self-contained apart from the chart library (see below).
- `assets/` — the encoded `.avif` / `.jxl` bitstreams, one per job. Accumulates across runs
  alongside `full-results.json`; kilobytes each, not megabytes.
- `report-assets/` — only the files `report.html` actually links: the reference PNG and the
  handful of bitstreams in the visual comparison. Rebuilt each run, so it never carries stale
  picks. `report.html` plus this folder is the whole report and can be moved or published
  on its own.

## 6b. Browser decode timing

Encode cost is only half the story: what a page pays is *decode* cost, and
`avifdec`/`djxl` are not the decoders anyone actually runs. So decode is measured
in a real browser.

- **`createImageBitmap` is the measurement.** It isolates the decode — no layout, no
  paint, no CSS scaling — and resolves only once the image is fully decoded, so awaiting
  it times the decode and nothing else.
- **Driven over classic W3C WebDriver** from Node: a temporary localhost server serves the
  run directory, the browser navigates to it, and one `execute/async` call per batch of 20
  images returns the samples. No Puppeteer, no client library — just `fetch` against the
  driver's HTTP API.
- **Classic WebDriver rather than CDP or BiDi.** The benchmark needs exactly three things
  — navigate, run an async script, get JSON back — and classic WebDriver provides all
  three on every driver that exists. CDP is Chrome-only (Firefox removed it). BiDi works on
  Chrome and Firefox — verified both — but Chrome needs chromedriver for it anyway, and
  Safari's BiDi support is still landing. Classic is the only protocol that reaches all
  three engines today.
- **Three targets**, selected with `--decode-browsers` (default `firefox`, which has the
  finer clock — 0.02ms granularity against Chrome's 0.1ms, on decodes as fast as 1ms):
  - **Chrome Canary** via chromedriver. Canary specifically: verified that Canary 156
    decodes JPEG XL through `createImageBitmap` while stable Chrome 153 fails with *"The
    source image could not be decoded"*. No flag needed — Canary decodes JXL even with
    `--disable-features=JXL`.
  - **Firefox Nightly** (the default) via geckodriver, with two mandatory prefs: `image.jxl.enabled`
    (JXL is behind a flag) and `privacy.reduceTimerPrecision=false`. Without the second,
    Firefox clamps `performance.now()` to 1ms, which is useless for 1-20ms decodes; with
    it off, granularity is 0.02ms — five times finer than Chrome's 0.1ms.
  - **Safari** via the `safaridriver` that ships with macOS. Requires a one-off manual
    step — Develop → *Allow Remote Automation* — which cannot be automated, so the
    resulting session error carries that instruction. Safari has no headless mode, so a
    window opens and its numbers are correspondingly noisier.
- **Drivers are resolved, not assumed.** chromedriver must match Chrome's *major* version
  (verified: chromedriver 156.0.8067.0 drives Chrome 156.0.8068.0) and Canary moves daily,
  so a version-matched build is downloaded and cached under
  `~/.cache/image-codec-bench/drivers` when PATH has nothing suitable. geckodriver is
  fetched the same way. `--chromedriver` / `--geckodriver` / `--safaridriver` override.
- **A named browser is required; the default set is best-effort.** Asking for Safari and
  silently getting nothing would be worse than an error, so `--decode-browsers` failures
  are fatal while a missing browser in the default set costs a note. A decoder that rejects
  a file is reported as a warning rather than left as a gap in the chart.
- **Fetched once, re-wrapped per iteration.** The bytes are fetched into an `ArrayBuffer`
  so the network is never on the clock, then a fresh `Blob` is made for each run. Verified
  that repeat timings stay flat and non-zero this way, i.e. nothing comes from a
  decoded-image cache.
- **Mean of up to 20 runs, after 2 discarded warm-up runs** — deliberately *unlike* the
  encode timings, which use best-of-N. Process-spawn noise is one-sided, so for encoding the
  minimum is the cleanest estimate. Browser decode varies both ways: measured over 60 runs,
  a lossless JXL had a **9.6ms minimum against a 14.1ms median**, a 33% underestimate, so
  best-of-N there reports a decode nobody experiences. Warm-up is discarded rather than
  averaged in (a first sample of 5.1ms against a 2.0ms steady state was observed).
- **The spread is recorded and shown**, not hidden behind one number: median, min, max,
  standard deviation, coefficient of variation and the run count all go into
  `results.json`, the CSV carries sd and n, and the chart tooltip shows `mean ± sd`.
  Measured CV is typically 3-11%, rising to ~30% for the fastest decodes where
  `performance.now()`'s 0.1ms quantisation is itself a few percent of the measurement —
  which is why sub-millisecond differences should be read as noise.
- **A per-image time budget** (`--decode-budget`, default 2s, minimum 5 runs) keeps this
  tractable at full resolution, where a single decode can cost hundreds of milliseconds and
  20 runs across a whole grid would add up to many minutes.
- **Keyed by browser, and stamped with the build.** `decode` is a map of browser name to
  measurement, so the engines never get averaged together — they are different software
  with different costs, which is the whole reason for measuring more than one. Each entry
  records its build and is re-measured when that changes. Putting the build in the job
  cache key would invalidate every *encode* on a browser update and throw away hours of
  work.
- **Figures are comparable within a browser, not across.** Each engine has its own
  decoders and its own timer resolution, so Chart 3 offers a browser selector rather than
  drawing every engine on one set of axes. Compare codecs down a column; don't compare
  browsers across one.
- Runs **serially, after scoring and after the lossless suite, with nothing else in
  flight**, for the same reason the encode phase does. Ordering it after lossless means one
  browser launch covers the lossy grid *and* the lossless rows.
- **The lossless rows are measured too**, including the source PNG as a baseline. Lossless
  size and lossless decode cost pull in different directions and are worth reading together:
  measured on the test image, WebP came within 1.6% of JXL's size while decoding roughly 5×
  faster (2.9ms vs 14ms), and AVIF was both the largest and the slowest (19ms).
- Browser decoding is multi-threaded with no way to pin it, so this is all-cores wall
  clock with no single-thread counterpart.

## 7. HTML report

- **Chart 1 — rate/distortion.** x = SSIMULACRA2, y = file size, one line per series
  (codec + effort + depth). Log-scale y toggle, and a bpp alternative for the y axis. This
  is the main result: lower and further right is better.
- **Chart 2 — encode cost.** x = SSIMULACRA2, y = encode time, same series, with a
  single-thread / all-cores toggle.
- **Chart 3 — decode cost.** x = SSIMULACRA2, y = browser decode time (mean), same series,
  with a browser selector and a log-scale toggle. Hidden entirely when nothing measured it,
  since an empty chart reads as "decode is free".
- Both charts: legend click to isolate series, shared tooltip showing every recorded field,
  crosshair. **Chart.js 4** via CDN — scatter with `showLine: true` handles this directly
  and the report stays a single file. Trade-off: viewing the report needs network access. If
  that's unwanted, say so and I'll vendor the library into `assets/` instead.
- **Visual comparison.** The goal is *how this image would look on a real web page*, not
  pixel-peeping. So: **displayed at half its intrinsic size** (`width: naturalWidth / 2`,
  height auto) — exactly what a site does when serving 2×-density imagery to a
  high-DPR display. **No zoom, no pan.** Radio selection, number-key shortcuts, and
  hold-space to flip back to the original.
  - Swapping **builds a new `<img>`, `await`s `decode()` on it, then replaces the outgoing
    element** — rather than mutating `src` on one long-lived element. Mutating `src` can
    blank or tear the element between the assignment and the new frame; constructing the
    replacement off-document and only attaching it once it is fully decoded means the swap
    is a single clean frame, which is what makes the flicker test trustworthy.
  - Variants are still all fetched and decoded once **up front**, before the UI is enabled,
    so the per-swap `decode()` resolves from cache and the swap is instant.
  - Layered/stacked elements are deliberately avoided: they would composite variants through
    each other whenever the source has an alpha channel.
  - Backdrop selector (checkerboard / white / black) behind the image, since with alpha the
    visibility of artifacts depends entirely on what's composited underneath.
  - Shows the **slowest configured effort** for each codec, plus the original and JXL
    lossless, per the original plan.
  - Variants are chosen by **nearest measured SSIMULACRA2 to a set of score targets**, not
    by quality setting. Matching on the measured metric is the only way to put the two
    codecs genuinely side by side.
  - The targets are **derived from the run**, not fixed: four points evenly spaced across
    the *overlap* of the codecs' achieved score ranges, so each one is reachable by all of
    them. (Where the ranges don't overlap there is nothing to compare, so it falls back to
    the union.) Fixed 60/70/80/90 targets failed at both ends — a low-quality-only run
    matched none of them and produced an empty comparison, while a run clustered near the
    top wasted three of four slots.
  - Labels show the **measured** score, never the target. The target only spreads the picks
    across the range; printing it is what previously required a ±5 tolerance to avoid
    calling a 45 a "~60", and that tolerance was the thing emptying the comparison.
  - Serves the **real encoded files** — `.avif` and `.jxl` linked directly, with the JXL
    lossless variant as an actual `.jxl` — decoded natively by the browser. Targets nightly
    browsers with JPEG XL enabled.
  - Because that's a hard requirement, the report runs a **JXL capability check** on load
    (`img.decode()` against a tiny inline JXL data URI) and shows a prominent banner if the
    browser can't decode it, naming the flag to enable. Otherwise a browser without JXL
    support shows broken images in a comparison whose whole purpose is judging by eye.
  - Caveat to note in the report: the comparison is judged **after** the browser's
    downscale to half size, while SSIMULACRA2 scores the image at **full** resolution. The
    two therefore answer different questions — resampling hides fine-grained artifacts that
    the metric still penalises. That's intentional (half size is the realistic delivery
    case), but the report says so, so the chart and the eye test aren't mistaken for the
    same measurement.
  - Caveat to note in the report: the browser's decode path is not necessarily
    bit-identical to `avifdec`/`djxl` — colour handling for 10-bit AVIF in particular can
    differ — so what's on screen may deviate slightly from what SSIMULACRA2 scored.
- **Lossless table.** Three codecs at max effort, with sizes and both encode times,
  alongside the source PNG for reference:

  | Config | Bytes | Multi | Single | SSIMULACRA2 | Bit-exact |
  |---|---|---|---|---|---|
  | `cjxl -d 0 -e 9` | 333,450 | 0.45s | 0.52s | 100.00 | yes |
  | `cwebp -lossless -z 9 -exact` | 338,794 | 0.91s | 1.69s | 100.00 | yes |
  | source PNG | 343,852 | — | — | — | — |
  | `avifenc --lossless -s 0` | 353,496 | 3.58s | 5.37s | 100.00 | yes |

  Those are real measured figures from the spike (512×384 synthetic plasma, so treat the
  ordering as illustrative — real photos will rank differently). Each output is decoded and
  **asserted bit-exact against the reference** *and* asserted to score exactly 100.00; either
  check failing aborts the run rather than reporting a bogus "lossless" size.
  WebP notes: `-z 9` is max lossless effort (implies method 6), `-exact` is required per
  finding 6, and `-mt` is the multi-threaded variant for the timing column. WebP is 8-bit
  only and caps at **16,383px per side** — the run skips WebP with a warning above that
  rather than failing the whole grid.
- **Caveats section**, rendered into the report itself so the numbers are never read bare —
  contents in §10.

## 8. Project layout

```
package.json            { "type": "module" }, zero runtime deps
src/cli.js              util.parseArgs, config resolution, --dry-run
src/doctor.js           binary presence + version capture
src/normalise.js        input → canonical 8-bit sRGB reference PNG
src/png.js              chunk walk: strip cICP, read depth/dimensions
src/codecs/avif.js      encode/decode argv, quality+effort+depth domain
src/codecs/jxl.js       same shape, so adding a codec is one file
src/codecs/webp.js      lossless-only for now (-z 9 -exact); dimension guard
src/schedule.js         series expansion, bisection order, interleave, cost model
src/run.js              phase 1: serial timed encodes, progress + ETA
src/score.js            phase 2: parallel decode + ssimulacra2, depth-match assert, channel-count assert
src/lossless.js         avif/jxl/webp suite + bit-exact and score==100 assertions
src/cache.js            full-results.json load/append, job hashing
src/report/build.js     results.json → report.html
src/report/template.html
test/                   node:test — png chunk strip, schedule order, arg parsing, range parsing
```

Codecs sit behind one small interface (`buildEncodeArgs`, `buildDecodeArgs`, `fixDecoded`,
`paramSpace`), which is what keeps the `cICP` workaround isolated to `avif.js` and leaves
room for a third codec later.

## 9. Implementation order

1. Skeleton, `doctor`, `normalise`, and a single hardcoded encode→decode→score path — proves
   the `cICP` fix and the 16-bit decode in-repo, on a real image.
2. `schedule.js` + `run.js`: series expansion, interleaved bisection order, calibration,
   cost-weighted progress and ETA, cache/resume.
3. `score.js`: parallel scoring phase.
4. Console table + CSV.
5. Lossless suite (AVIF + JXL + WebP) with the bit-exact and score==100 assertions.
6. Report: both charts.
7. Report: flicker comparison.
8. Polish: `--dry-run`, overlap warning, caveats block, tests.

Checkpoint after step 4 — that's the first point where the numbers are real and worth
eyeballing before I build presentation on top of them.

## 10. Caveats to state in the report, and non-goals

Caveats:

- **SSIMULACRA2 is a proxy, not ground truth.** It also shares authorship with libjxl, so
  treating it as a neutral referee between JXL and AVIF is a known weak point of this
  methodology. The visual flicker comparison is in the report precisely so the metric can be
  spot-checked by eye.
- **One image is not a corpus.** Results are specific to this image's content. Per the scope
  decision this tool is single-image; conclusions shouldn't be generalised from one run.
- **Alpha inflates scores.** Transparent regions are scored free (§2, finding 5), so an
  image with significant transparency will show higher absolute scores than an opaque one.
  Curves remain valid *within* a run; absolute values shouldn't be compared across images.
- All-cores timings depend on machine load and core count. aom at 4:4:4 without tiling
  parallelises poorly, which is why single-thread timings are collected alongside.
- Encode timings include process spawn overhead (reported, not subtracted).

Non-goals for now, easy to add later: other subsampling modes
beyond the configurable `--avif-yuv`, *lossy* WebP/JPEG baseline curves (lossless WebP is
already in, per §7), BD-rate aggregation across a corpus.

## 11. Decisions I made without asking — flag any you disagree with

- Best-of-N as the headline timing, mean also recorded.
- Visual-comparison variants matched on measured score rather than quality setting, with
  the targets derived from the run's achieved range.
- Chart.js 4 from CDN rather than vendored (report needs network to view).
- Report gates the visual comparison behind a JXL capability check rather than failing silently.
- Lossless correctness asserted bit-exact; a failure aborts the run.
- Alpha preserved end to end; `--avif-qalpha` defaults to tracking `-q`.
- Decode depth matched to the reference, with lossless-scores-exactly-100 as a self-check.
- **Depth is presented as an AVIF-only axis.** `avifenc -d` is a real coded-depth setting
  that gets swept; JPEG XL has no analogue. Its bitstream declares 8-bit for an 8-bit
  source, but lossy JXL reconstructs in float/XYB — decoding a q60 file at 16-bit yields
  237 distinct low bytes where true 8-bit coding would yield 1. So JXL rows show `—` in the
  depth column rather than `8`, which would invite reading the two codecs as like-for-like
  on a knob only one of them has. `results.json` still records the reference depth.
- WebP included in the lossless table only, not the lossy sweep (it has no comparable
  quality/effort grid against AVIF and JXL at 4:4:4). Say the word if you want lossy WebP
  as a baseline curve too.
