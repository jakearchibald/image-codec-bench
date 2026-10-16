# image-codec-bench

Sweeps one image through `avifenc` and `cjxl` across quality × effort, scores every output
with SSIMULACRA2, and emits a console table, CSV, and a self-contained HTML report with
rate-distortion charts and a visual flicker comparison.

Zero runtime dependencies — just Node 22+ and the codec CLIs (plus `cargo` for HDR input).

## Install

```sh
brew install libavif libjxl webp imagemagick oxipng   # avifenc/avifdec, cjxl/djxl/ssimulacra2, cwebp/dwebp, magick, oxipng
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
`--force` to ignore the cache, or `--force-codecs jxl` to ignore it for just those codecs
(lossy and lossless rows) while reusing the rest.

### Encode memory

Every encode runs under `/usr/bin/time` (`-l` on macOS, `-v` on Linux), which reports the
encoder's peak resident set size. The report plots it against SSIMULACRA2 as its own chart,
per threading mode, and the table and CSV gain `single_peak_bytes`/`multi_peak_bytes`.
The lossless suite records it too, with a size-vs-memory chart alongside size-vs-time.
It's recorded even with `--no-timing`, since the one canonical encode is measured too.
Where the worst of several timing runs differs, the worst is kept.

Results cached from before memory was recorded have none, and resuming won't re-encode
just to get it. Use `--force` (or a fresh `--out`) to measure it for an existing run.

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
  200 cd/m², 250 lux office lighting, 2× display height ≈ 75 cm away: about 75 pixels per
  degree, between a 27" 1440p monitor and a Retina laptop). HDR runs assume cvvdp's
  `standard_hdr_pq` monitor (1500 cd/m² peak) in the same 250 lux rather than the preset's
  10 lux, which is a dark grading room and overweights shadow artefacts for a desk.
- cvvdp clips PQ at the display's peak, so differences in highlights brighter than 1500
  cd/m² don't count.
- cvvdp ignores the files' colour tags and reads pixels in the display's colour space, so
  each run writes its own display definition matching the reference (e.g. P3 PQ).
- It has no notion of alpha, so an image with alpha is composited onto flat 10% and 90%
  grey (blending the sRGB-encoded values, as browsers do) and scored on each, keeping the
  worse JOD; both are stored. An error often shows on only one background, so averaging
  would halve it. This doubles the cvvdp time, and isn't supported for HDR.
- It runs one file at a time, about 5 seconds each at 5 MP, alongside the normal scoring.
- Its version and display model are stored with each score, not put in the cache key:
  turning `--cvvdp` on, upgrading it, or changing display only re-scores, never
  re-encodes. Runs without `--cvvdp` keep stored JODs but don't show them.
- Unlike SSIMULACRA2 it has no cliff just below a perfect score: a lossless gain-map AVIF,
  rendered at 12-bit against a 16-bit reference, scores exactly 10.

### A second JPEG XL encoder: jixel (`--codecs …,jixel`)

[jixel](https://github.com/awxkee/jixel) is a Rust JPEG XL encoder ported from
libjxl-tiny. It has no CLI, so `tools/cjixel` wraps it. That crate pins a jixel git rev
and is built with `cargo` the first time `--codecs` names jixel. Its output is an
ordinary `.jxl`, decoded with `djxl` like cjxl's.

```sh
node src/cli.js photo.png --codecs avif,jxl,jixel --cvvdp
node src/cli.js photo.png --codecs jixel --jixel-effort 5 --jixel-quality 30:95:5
node src/cli.js screenshot.png --codecs jxl,jixel --jixel-patches off,on
node src/cli.js illustration.png --codecs jixel --jixel-effort 5,6 --jixel-splines off,on
```

- `--jixel-effort` is speed 1–6: ultrafast, fastest, fast (jixel's default), medium,
  slow, extraslow. Higher is slower, like `cjxl -e`. The default is 3,5,6.
- `--jixel-quality` uses jixel's own `-q`. From q30 to q90 it maps to the same distances
  as `cjxl -q`, but jixel spends fewer bytes at a given distance, so the same q scores
  lower. The default range therefore goes up to 95.
- `--jixel-patches off,on` turns on jixel's patch dictionary (off by default), with each
  setting as its own series, labelled e.g. `slow+patches`. It matters for text and flat
  graphics. Photos find no patches.
- `--jixel-splines off,on` turns on jixel's experimental splines (off by default): thin
  lines (wires, ink, hair) are coded as JPEG XL splines next to the VarDCT image when that
  pays. Like patches, each setting is its own series, e.g. `slow+splines`. It only
  applies to lossy encodes at slow and extraslow. jixel ignores it at lower speeds, so
  "on" there is the same encode as "off" and adds no extra series. On a 1MP illustration
  at slow, q75, splines saved 5% and gained 1.2 SSIMULACRA2. They cost encode time
  (0.04s → 0.3s there) and some decode time. Cache keys only include splines when they're
  on, so earlier jixel results stay cached.
- jixel joins the lossless table when `--codecs` names it: one row per speed and patches
  setting, checked bit-exact like the others.
- HDR runs work as for cjxl: jixel encodes the PQ reference (cICP primaries, 10,000-nit
  intensity target, as cjxl writes) and is decoded by `djxl` to 16-bit PQ.
- `src/target.js` and `src/fixed-quality.js` take `--codecs …,jixel` with
  `--jixel-effort`, `--jixel-patches` and `--jixel-splines` too (`fixed-quality` also
  `--jixel-quality`), as does `src/progressive.js` (`--jixel-splines`, one group per
  setting). The lossless table and `jpeg-transcode` ignore splines: jixel only codes them
  in lossy VarDCT.
- The cache key includes `cjixel --version`, which names the jixel rev. Bumping the pin
  in `tools/cjixel/Cargo.toml` re-encodes jixel's jobs, and only those: other codecs'
  keys leave `cjixel` out, so adding jixel to an earlier run re-encodes nothing else.
- jixel tunes its parameters against SSIMULACRA2. At extraslow it also runs a
  SSIMULACRA2-driven quant-field loop inside the encoder. Read its curves with
  `--cvvdp`: in a six-image sweep, extraslow gained ~5% over slow on SSIMULACRA2 but
  under 1% on cvvdp.
- Gain maps and HLG aren't driven: jixel can write a gain map but doesn't compute one.

In that sweep (Oct 2026, jixel `b45195a`, six 8-bit SDR inputs, both metrics), jixel
at slow was ~16% smaller than `cjxl -e7` at equal score, but ~7% larger than
`avifenc -s6` (10-bit 4:4:4) and ~20% larger than `-s2`. It beat AVIF on one detailed
photo, and lost clearly on the illustration and the screenshot.

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
- **`--avif-hdr`** picks how AVIF carries the HDR, and takes a comma list; each mode is
  its own series:
  - `gainmap` (default): SDR PNG base + gain map up to the HDR PNG.
  - `gainmap-hdr`: HDR PNG base, as PQ, + gain map down to the SDR PNG (the direction
    JXL's gain maps are meant for). Its scored image *is* its base, so it scores exactly
    like `pq`; the difference is the bytes of the gain map, which only serves SDR displays
    and whose quality isn't measured by a run (see below for how its settings were chosen).
  - `pq`: the HDR PNG as PQ, like for like with JXL.

  PQ and HDR-base AVIF want `--avif-depth 10` or 12; the CLI warns at 8, which bands. Both
  decode at 16-bit, so only the SDR-base gain map has the 12-bit scoring penalty.
- **SDR-base gain maps use tuned settings**: 10-bit, 4:4:4, full resolution, quality 5
  below the base's `-q` (`gainMapSettings` in [`src/codecs/avif.js`](src/codecs/avif.js)).
  libavif's defaults are 8-bit at quality 60 whatever `-q` is.

  From a sweep on the neon HDR/SDR pair at `-s 0`, 10-bit base, comparing file size at equal
  quality on the HDR rendition (BD-rate style) against 8-bit, 4:4:4, full size, quality = `-q`:

  | gain map | PU21 SSIMULACRA2 | ColorVideoVDP |
  |---|---|---|
  | **10-bit, 4:4:4, full, `-q` −5** | **−13.1%** | **−4.6%** |
  | 10-bit, 4:4:4, full, `-q` | −7.1% | −6.0% |
  | 10-bit, 4:4:4, full, `-q` −10 | −17.1% | +0.8% |
  | 12-bit, 4:4:4, full, `-q` −5 | −14.5% | +4.0% |
  | 8-bit, 4:4:4, half size, `-q` | −16.9% | +87.3% |
  | 8-bit, 4:2:0, full, `-q` | +1.1% | +83.4% |
  | 8-bit, 4:4:4, full, `-q` +15 | +43.6% | +24.0% |

  4:0:0 (luma-only) gain maps can't carry the colour differences between the renditions and
  score far below everything else. −5 was the only setting better on both metrics, and it
  held in every third of the quality range. One image, so treat the rule as a starting
  point rather than a law.
- **HDR-base gain maps use tuned settings too**: 10-bit, 4:4:4, full resolution, quality 10
  below the base's `-q` (`hdrBaseGainMapSettings` in [`src/codecs/avif.js`](src/codecs/avif.js)).
  Only the SDR rendition depends on this gain map, so the sweep scored that: each file
  tone-mapped to SDR (`--headroom 0`) against the SDR PNG with SSIMULACRA2 and
  ColorVideoVDP, neon pair, `-s 6`, 10-bit PQ base. At base `-q` 70 (145 KB of base; a
  lossless gain map would give SDR 75.2):

  | gain map | gain-map bytes | SDR SSIMULACRA2 | SDR ColorVideoVDP |
  |---|---|---|---|
  | 8-bit, 4:4:4, full, `-q` (the previous setting) | 139 KB | 72.0 | 9.841 |
  | **10-bit, 4:4:4, full, `-q` −10** | **102 KB** | **72.2** | **9.846** |
  | 10-bit, 4:4:4, full, `-q` −20 | 73 KB | 70.1 | 9.834 |
  | 10-bit, 4:4:4, half size, `-q` | — | 59.6 | 9.760 |
  | 10-bit, 4:2:0, full, `-q` | — | 69.9 | 9.827 |

  10-bit was better than 8-bit on both metrics at every quality, for the same bytes or
  fewer. Half size capped the SDR rendition at ~62 even at gain-map quality 90, probably
  because the HDR-to-SDR change is concentrated on the thin neon tubes, and 4:0:0 scored
  below zero, since it can't carry the change from the HDR primaries to sRGB. −10 beat the
  previous setting on both metrics with a smaller gain map; above it ColorVideoVDP gained
  little. The pattern held at base `-q` 50 and 85. Even so, on this image the gain map
  costs about what a standalone SDR AVIF of the same quality would (~85 KB at
  SSIMULACRA2 72).
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

### Encoding to target scores (`src/target.js`)

A separate tool for when you want files rather than curves: for each codec setting it
searches for the lowest quality that reaches each target SSIMULACRA2 score, and keeps
that file.

```sh
node src/target.js photo.png --target 60,70,80,90 --avif-yuv 420,444 --avif-speed 0,6 --jxl-effort 7,9
```

Files go in `out/<image-stem>-targets/`, named like the bench's bitstreams plus the score
the file actually got, e.g. `avif-q28-e0-d8-yuv420-ssimu70.2.avif`, alongside a
`targets.json` summary. It uses the same normalisation, encoder flags and scoring as the
bench, so the scores match a bench run at the same settings.

- AVIF searches integer `-q`; JXL searches `-q` in steps of `--jxl-step` (default 0.1).
- The search interpolates between scores it has already measured, and those are shared
  across targets, so each target after the first usually costs two or three encodes.
- It assumes the score rises with quality. That is close to true, so a file always
  reaches its target but may occasionally be a step above the lowest quality that would.
- A target the setting can't reach even at `-q 100` is reported, not written.
- HDR input works as in the bench: an HDR PNG plus `--sdr`, with `--avif-hdr` picking the
  AVIF modes (each its own setting, with the same gain-map settings). Targets are then
  PU21 SSIMULACRA2 scores, and `--max-pixels` isn't available.

  ```sh
  node src/target.js neon-hdr.png --sdr neon-sdr.png -t 60,70 --avif-depth 10 --avif-hdr gainmap,pq
  ```

- No caching between runs, but an existing `targets.json` is added to rather than
  replaced: rows for settings this run searched are replaced and the rest kept. So
  `--codecs jixel` adds jixel to an earlier AVIF/JXL search without redoing it.
  `node src/target.js --help` lists every flag.

### Score variation at a fixed quality (`src/fixed-quality.js`)

Shows how much the SSIMULACRA2 score moves when only effort/speed or AVIF subsampling
changes. Every image in a directory is encoded at one quality per codec, at each effort
level and yuv mode, and each file is scored.

```sh
node src/fixed-quality.js inputs --avif-quality 60 --avif-speed 0-10 --avif-yuv 420,444 \
  --jxl-quality 75 --jxl-effort 1-10
```

Results go to `out/<dir-name>-fixed-quality.json`: for each image, every setting's score
and size, plus a `spread` per codec × depth × yuv giving the lowest and highest scoring
effort and the range between them. The JSON is rewritten after each image, so an
interrupted run keeps the images it finished. An existing JSON for the same directory is
added to: per image, settings this run encodes replace their old results and the rest are
kept (a codec run at a new quality drops its old results). `--images a.png,b.png`
limits the run to those files. The console prints the same thing as a
table per codec, one column per effort.

- Same normalisation, encoder flags and scoring as the bench, so scores match a bench run.
- The encoded files aren't kept, and nothing is timed, so `--concurrency` is safe to raise.
- HDR images in the directory are skipped. `--max-pixels` applies to every image.
- The defaults include `avifenc -s 0` and `cjxl -e 10`, which are very slow on large
  images; narrow `--avif-speed`/`--jxl-effort` or use `--max-pixels` for a quick look.

### JPEG → JPEG XL transcoding (`src/jpeg-transcode.js`)

What JPEG XL's lossless JPEG transcoding saves, and what the JXL costs to decode compared
with the JPEG it came from. For each image × width × quality × progressive level: resize
(Lanczos, never upscaling), encode with `cjpegli` at 4:2:0, transcode with `cjxl`, then
time `createImageBitmap` for both files in each browser, the same way the bench does.

```sh
node src/jpeg-transcode.js inputs/f1.png -w 400:2000:400 -q 70,85 -p 0,2
```

- **The JPEG has no metadata.** The reference is stripped sRGB, so jpegli writes no APPn
  or COM segments at all (not even JFIF), and the run asserts that.
- **The JXL is the smallest cjxl makes**: `--lossless_jpeg=1 --allow_jpeg_reconstruction=0`
  at every `--jxl-effort` (default 1–10), keeping the smallest, ties to the lower effort.
  Dropping reconstruction data also drops the container: about 350 bytes on a 90 KB file.
  Effort is not monotonic for transcoding: on one 1200px q80 file e5–7 gave 78,661 bytes,
  e8–9 ~78,730 and e10 78,935, and the winner changes with size and quality. Each
  setting's sizes are kept as `jxlByEffort`.
- **`--jixel-effort 1-6` adds jixel** (`tools/cjixel --jpeg`, also without reconstruction
  data), keeping its smallest speed, with sizes in `jixelByEffort` and its own decode
  timings. Both transcodes carry the same coefficients and decode to identical pixels;
  only the entropy coding differs.
- **Progressive matters for decode time.** jpegli's default is `-p 2`; `-p 0` is
  sequential. A progressive JPEG decodes 2–3× slower in Chrome and Firefox, while the JXL
  is the same size whichever it came from. So the JPEG decode baseline depends on `-p`.
- `--decode-browsers` defaults to `all` (Chrome Canary, Firefox Nightly, Safari),
  skipping any that can't be driven. Named browsers are required, but one failing still
  doesn't cost the other browsers' results. A browser session that fails to start is
  retried once.
- `cjpegli` isn't packaged by Homebrew (jpegli left libjxl for
  [google/jpegli](https://github.com/google/jpegli)). It is taken from `$CJPEGLI`, else
  `~/dev/jpegli/build/tools/cjpegli`, else PATH:

  ```sh
  git clone --recursive https://github.com/google/jpegli ~/dev/jpegli
  cmake -S ~/dev/jpegli -B ~/dev/jpegli/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF
  ninja -C ~/dev/jpegli/build cjpegli
  ```

Files go in `out/<image-stem>-jpeg-transcode/<image-stem>/` (`out/jpeg-transcode/` for
several inputs), e.g. `w1200-q80-p2.jpg` and the kept `w1200-q80-p2-e5.jxl`, alongside
`results.json` (sizes, chosen effort, full decode samples, tool and browser versions) and
`results.csv`. A re-run in the same place reuses the earlier one where it can: when the
cjxl efforts and the cjpegli, cjxl and magick versions match, and the JPEG comes out
byte-identical, that row's transcode is kept (jixel's too, if its speeds and version
match), as are decode timings from the same browser build. Files results.json no longer
describes are removed. No scoring: the JXL holds the JPEG's own DCT coefficients.

### Progressive overhead (`src/progressive.js`)

What progressive encoding costs against the same image encoded non-progressively: file
size, encode time and peak memory, browser decode time, and SSIMULACRA2 of the final image.

```sh
node src/progressive.js inputs/f1-large.jpg --preview inputs/f1-preview-frame.avif
```

Files come in groups, one per `--jxl-effort` and one per `--avif-speed` (each takes a
range or comma list, e.g. `--jxl-effort 5,7 --avif-speed 4-8`). Progressive files are
compared with the non-progressive file of the same effort or speed. Each group holds:

- **JXL** at `--jxl-quality` (default 70), and the same with `-p` (progressive AC, plus
  extra DC passes). Non-progressive JXL is still DC-first, so this measures what `-p` adds.
- **jixel**, only with `--jixel-speed` (speeds 1–6, one group each): at `--jixel-quality`
  (default 80), and the same with progressive DC and centre-first groups. Progressive DC
  codes the 1:8 DC image as its own squeezed frame, every level, so it refines from an
  8×8 preview before any AC arrives, like `cjxl --progressive_dc=1 --group_order=1`. The
  AC stays in one pass: jixel can split it too, but this test leaves that out.
  `--jixel-splines off,on` adds a spline group per speed 5–6, compared with its own
  non-progressive spline file.
- **AVIF** at `--avif-quality` (default 50), and a two-layer AVIF (`avifenc --layered`):
  `--preview` as layer 0 at `--scaling-mode 1/8`, then the full image as layer 1, both at
  `--avif-quality` unless `--avif-preview-quality` is given. AV1 spatial layers all have
  the image's dimensions and the encoder does the downscaling, so the preview is first
  Lanczos-upscaled to the image's size (an AVIF preview is decoded with `avifdec`, since
  ImageMagick may not read AVIF). A 662×427 preview of a 5301×3423 image is coded at
  663×428, so it's barely resampled.
- **With `--avif-keyframe-variant`**, a fifth file: the same two-layer AVIF with `-k 1`,
  which makes layer 1 a keyframe rather than an inter frame predicted from layer 0. avifenc
  only documents `-k` for image sequences, so the run reads the frame types out of the
  bitstream (kept as `frames` in `results.json`) and fails if layer 1 isn't a keyframe. On
  f1-large at SSIMULACRA2 80, predicting from the preview cost bytes rather than saving
  them: +8.5% against the non-progressive AVIF, where the keyframe version was −3.4%.

**Each pair is compared at equal final quality.** Qualities are searched with the same
search as `target.js`, for the SSIMULACRA2 closest to a target: cjxl in steps of
`--jxl-step` (0.1), avifenc in whole steps, so AVIF can land a few tenths off. Each search
starts from the `-q` options and took 4–7 encodes on f1-large.

- `--target S` (or `--jxl-target`/`--jixel-target`/`--avif-target`) searches the non-progressive file to
  S, then the progressive one to the score it reached:

  ```sh
  node src/progressive.js inputs/f1-large.jpg --preview inputs/f1-preview-frame.avif -t 80
  ```

- Without a target, the non-progressive file is encoded at its `-q`, and the progressive
  one is searched to its score.
- `--no-match` encodes every file at the `-q` options. That changes the answer a lot: on
  f1-large, JXL `-p` at the same `-q 70` was 4.8% *bigger* but scored 1.7 higher; matched
  (`-q 64.5`) it's 6.8% *smaller*.

The layered AVIF's layer 0 stays at `--avif-preview-quality` (default `--avif-quality`)
throughout; only layer 1 is searched. Every file's `quality` (plus `previewQuality` for the
layered AVIF) is in `results.json`, with a `search` record of the target, the score
reached and every quality tried.

Notes:

- **Encode timing** is round-robin across all the files, `--repeats` rounds (default 5)
  per `--threads` mode (default `single,multi`), after one discarded warm-up round, so
  drift lands evenly. Best of N is the headline; median, mean and samples are in the JSON.
  Peak memory is the worst seen, from `/usr/bin/time`, as in the bench.
- **Decode timing** is the same `createImageBitmap` harness as the bench, in every browser
  that can be driven by default (`--decode-budget` defaults to 5s, since these are large).
- **Each browser's decode is checked to be the final image.** A browser that showed only
  layer 0 would still report full dimensions, so dimensions prove nothing. Instead a
  centre crop (`--crop-size`, default 1024) is drawn to a canvas, sent back as PNG, and
  scored against the same crop of the reference. It has to come within 10 of the libavif/
  libjxl decode's crop score; layer 0 alone scores below zero.
- The AVIF's layer 0 is scored on its own too (as `avifdec` upscales it), to show what the
  preview looks like before layer 1 arrives.
- libavif comes from `$LIBAVIF_BUILD`, else `~/dev/libavif/build`, else PATH.

Files go in `out/<image-stem>-progressive/`: `reference.png`, the bitstreams (named by group, e.g. `avif-s6-progressive.avif`), and
`results.json` (argv, sizes, scores, every encode and decode sample, tool and browser
versions). Each run replaces the previous one. No caching.

### Animation (`src/animation.js`)

File size at equal quality for an animated AVIF (an AV1 image sequence) against an animated
JPEG XL, plus the cost of each encode. The input is a lossless video, anything ffmpeg reads.

```sh
node src/animation.js inputs/clip.mkv -t 9,9.5
```

- **Reference**: every frame is extracted once to an 8-bit sRGB PNG with no colour chunks.
  YUV sources are converted with their own matrix and range. An untagged source is taken as
  BT.709 limited range, rather than swscale's BT.601 default. HDR and alpha are refused.
  cjxl gets an APNG of the frames.
- **AVIF comes from two AV1 encoders** (`--avif-encoder`, default `aom,svt`). Each writes a
  bare AV1 stream, which ffmpeg's `avif` muxer puts into an AVIF sequence without
  re-encoding.
  - **aomenc** (libaom, the reference encoder). It's used directly rather than through
    avifenc because libavif only drives libaom in one pass, and `--avif-passes` (default
    `2`; `1,2` for both) needs aomenc. The encode otherwise matches what avifenc does for a
    sequence: good-quality usage, `end-usage=q`, `tune=ssim`, `--cpu-used` = avifenc's
    `-s` (`--avif-speed`, default `6,0`, the good-quality range 0–6 only), and libaom's
    defaults for lookahead and keyframes. Quality is `--cq-level` (0–63, lower is better;
    avifenc's `-q` maps to it as `(100 − q) × 63 / 100`).
  - **SvtAv1EncApp** (SVT-AV1, the production video encoder). It uses `--rc 0 --crf`
    (1–70, searched in 0.25 steps), `--preset` from `--svt-preset` (default `8,0`, its
    default and its slowest non-debug preset), and `--tune` from `--svt-tune` (default `0`,
    VQ; `0,2` compares it with SSIM). SVT-AV1 only does multi-pass for VBR, so it's always
    one pass. Its default of a keyframe every ~5 seconds is replaced with `--keyint -1`,
    leaving keyframes to the encoder as with libaom. It only does 4:2:0 at 8 and 10-bit, so
    other `--avif-yuv`/`--avif-depth` settings run aomenc alone.
  - `--svt-variant NAME=ARGS` and `--aom-variant NAME=ARGS` (repeatable) add extra encoder
    arguments as settings of their own, for trying encoder options at equal quality:

    ```sh
    node src/animation.js clip.mov --avif-encoder svt --svt-variant default= --svt-variant "notf=--enable-tf 0"
    ```

    With none, each encoder runs once as configured; once any are given, `default=` keeps
    the plain run in the comparison.
  - Tunes for still images (`iq`, `ssimulacra2`, SVT-AV1's IQ and MS-SSIM) are left out,
    and so is SVT-AV1's VMAF tune, which tunes for a metric rather than viewers.
- **The AV1 input is full-range YUV**, converted once per subsampling and depth by ffmpeg
  from the reference PNGs: BT.601 matrix (avifenc's default for RGB input), chroma sited
  at the centre, tagged as BT.709 primaries and sRGB transfer, as avifenc tags its files.
  aomenc takes full range from the Y4M header, SVT-AV1 from `--color-range 1`, and the AV1
  sequence header and the AVIF's `colr` box both say so. The conversion isn't part of the
  encode time. Near-lossless encodes (aomenc `--cq-level 1`, SVT-AV1 `--crf 1`) both decode
  to SSIMULACRA2 92.7, against 93.3 from avifenc `-q 99`, so the colour path matches
  avifenc's.
- **Settings**: each AV1 encoder's efforts × `--avif-yuv` (default `420`) ×
  `--avif-depth` (default `8,10`; 10-bit coding of an 8-bit source often compresses
  better), plus aomenc passes and SVT-AV1 tunes, and `--jxl-effort` (default `7,10`). The
  effort defaults are each encoder's own default and its slowest. `--avif-keyframe` sets
  a maximum keyframe interval for both AV1 encoders. At the default of 0, the encoder
  places keyframes itself.
- **Metric: ColorVideoVDP**, scoring the whole clip as video at the source frame rate,
  with the same `standard_4k` display as `--cvvdp`. It models temporal sensitivity, so
  flicker counts, and that is where the formats differ most: AV1 predicts frames from each
  other, while libjxl codes every frame on its own. Decoded frames (`avifdec`, `djxl`) and
  the reference are passed to it as lossless RGB FFV1 videos (checked to give the same
  score as a TIFF frame sequence). Each decode is checked to have the reference's size and frame
  count, since cvvdp would otherwise score the shorter of the two.
- **`--ppd`: match the viewing model to how the video will be shown.** By default the
  scores assume cvvdp's `standard_4k`: each video pixel on one pixel of a 30" 4K monitor
  at about 75 cm, which is 75.4 video pixels per degree of visual angle. `--ppd` replaces
  that geometry (cvvdp's `--pix-per-deg`), keeping the luminance and lighting. Work it out
  as the viewing distance spanned by one degree, divided by the physical size of one video
  pixel on screen. For example, a 1598 px video at 742.5 CSS px on a 2× 14" MacBook Pro
  (254 ppi, so 0.1 mm device pixels) is 0.93 device pixels per video pixel, 0.093 mm. At
  50 cm one degree is 8.7 mm, so `--ppd 94`. A 27" 5K display at 65 cm gives ~105. On a 1×
  screen the video is halved, which hides most artefacts, so 2× screens are the case that
  decides the target. Higher ppd means artefacts are smaller, so the same file scores
  higher.
- **Search**: for each setting, quality is searched for the JOD closest to each
  `--target` (or, with `--tolerance 0.1`, the first within 0.1 of it, for a quick look). The search shares probes across targets and starts from the previous
  setting's answer, with encodes multi-threaded. **Compare the "at target" column**: size
  interpolated to exactly the target JOD (log size, linear in JOD) between the quality steps
  either side. Whole-number `--cq-level` can land a few hundredths of a JOD off.
- **Encode time**: the chosen file is encoded once more, single-threaded by default
  (`--threads multi` for all cores, `--no-timing` to skip), with peak memory. For AVIF
  that's the AV1 encoder alone (both passes, for aomenc), not the mux. Single-threaded is
  `--threads=1` for aomenc and `--lp 1` for SVT-AV1 (a parallelism level, checked to keep
  to one core). aomenc doesn't give identical bytes single- and multi-threaded (1–4% apart
  on a test clip), so a file that differs from its search probe is rescored. "at target"
  still comes from the multi-threaded probes. SVT-AV1 gave identical bytes.
- **SSIMULACRA2** per frame is reported for the kept files: mean, worst frame, every
  frame's score in `results.json`, and **flicker**, the mean change in score from one frame
  to the next. Quality can pulse with the encoder's frame hierarchy without moving the
  ColorVideoVDP score much: SVT-AV1 preset 8 on `euro-truck.mov`, at 9.5 JOD, scored ~25–30
  on every 16th frame, 15–20 on every 8th and 3–8 between (flicker 7.1, against a mean of
  8.5). Whether a given pulse is visible is a separate question; on that clip the visible
  problem was something else (background dragged along with the moving truck). Nothing is
  chosen by SSIMULACRA2.
- Needs aomenc (Homebrew's `aom`), SvtAv1EncApp (`svt-av1`), ffmpeg/ffprobe and the cvvdp venv (see `--cvvdp` above).
  Each probe is a full encode, decode and cvvdp run of the clip. `--cpu-used 0` on video
  is very slow, so keep clips short.

Files go in `out/<video-stem>-animation/`:

- each kept bitstream, e.g. `avif-aom-s6-420-d10-p2-cq31.avif`,
  `avif-svt-p8-420-d10-t0-crf40.5.avif`, `jxl-e7-q42.5.jxl`
- for each AVIF, the same AV1 stream as an MP4 (`+faststart`, same colour tags), for
  comparison with serving it as `<video>`
- `viewer.html`, which flips between the original and each kept file in the same place.
  Each AVIF is followed by its MP4 in `<video>`, so an artefact that only shows in one is
  the browser's rendering rather than the encode. It shows them `--view-width` CSS px wide
  (editable on the page), or by default at one video pixel per device pixel. The original
  is the input video. If browsers can't play it (FFV1, say), the run writes `original.mov`,
  a ProRes 4444 XQ copy of the reference frames tagged with the sRGB transfer like the
  AVIFs, and shows that instead. ProRes only plays in Safari. To compare runs on one page:

  ```sh
  node src/animation-viewer.js out/a/clip-animation out/b/clip-animation --width 742.5 --out compare.html
  ```
- `results.json`: every probe's setting, JOD and bytes, the chosen files (and MP4 sizes)
  with the commands that made them, encode times, tool versions and the display

Each run replaces the previous one. No caching.

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
4. **Lossless sweep** for JXL, WebP, PNG and AVIF across effort levels — `avifenc -s` and
   `cjxl -e` reuse the lossy ranges, `cwebp -z` uses `--webp-effort` (default 0-9),
   `oxipng -o` uses `--png-effort` (default 0-6). Every point is asserted bit-exact *and*
   asserted to score exactly 100.00. The "source PNG" row is the normalised reference as
   ImageMagick wrote it, which is not an optimised PNG (3-44% larger than `oxipng -o 6`
   on the test inputs); the oxipng rows are the fair PNG comparison. oxipng runs with
   `--force`, so a level that can't beat ImageMagick's file reports its own output
   rather than a copy of the input.
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

Otherwise a re-run opens one short session per browser to read its version, and times
only files with no measurement from that version. Adding a codec to a run therefore
times just the new files, while a browser update re-times everything.

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
- **cjxl keeps alpha lossless by default** (`-a 0`) whatever `-q` is, while `avifenc
  --qalpha` tracks `-q` here. So `--jxl-alpha-distance` defaults to `match`: `-a` gets the
  distance libjxl maps `-q` to (`JxlEncoderDistanceFromQuality`). Only images with alpha
  get `-a`, so opaque results keep their cache keys. jixel has no alpha setting and always
  encodes it losslessly.
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
