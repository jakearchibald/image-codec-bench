// results.json -> report.html. The report is a pure function of the results
// file (plan.md §6), so it can be rebuilt without re-running the benchmark.

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { codecs as codecRegistry } from '../codecs/index.js';

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'template.html');

/**
 * Codecs whose bit depth is an actual encoder setting. JXL is excluded: its
 * bitstream declares 8-bit for an 8-bit input, but lossy JXL reconstructs in
 * float/XYB with no analogue of avifenc's `-d`, so printing a depth against it
 * implies a swept setting that does not exist.
 */
export const DEPTH_AXIS_CODECS = Object.entries(codecRegistry)
  .filter(([, codec]) => codec.hasDepthAxis)
  .map(([name]) => name);

/** Folder holding exactly the files report.html links, and nothing else. */
export const REPORT_ASSETS_DIR = 'report-assets';

/**
 * Copy the files the report actually links into `report-assets/`, and rewrite
 * the variant paths to point there.
 *
 * `assets/` accumulates a bitstream for every job of every run, the same way
 * `full-results.json` accumulates rows; the report only ever shows a handful.
 * With this, `report.html` plus `report-assets/` is the whole report and can be
 * moved or published on its own.
 *
 * Returns the rewritten variants, plus the names of any whose source file was
 * missing -- those are dropped rather than left as broken images.
 */
export async function collectReportAssets({ runDir, variants }) {
  const dir = path.join(runDir, REPORT_ASSETS_DIR);
  // Rebuilt from scratch each time: files left over from a previous run's
  // variant picks would defeat the point of a folder holding only what's used.
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const copied = new Map(); // destination basename -> source path
  const kept = [];
  const missing = [];

  for (const variant of variants) {
    if (!variant.src) continue;
    const source = path.join(runDir, variant.src);

    let name = path.basename(variant.src);
    // Two different sources must not land on the same name. Sharing a name with
    // the *same* source is fine and just reuses the copy.
    if (copied.has(name) && copied.get(name) !== source) {
      const ext = path.extname(name);
      name = `${path.basename(name, ext)}-${kept.length}${ext}`;
    }

    try {
      if (copied.get(name) !== source) {
        await copyFile(source, path.join(dir, name));
        copied.set(name, source);
      }
      kept.push({ ...variant, src: `${REPORT_ASSETS_DIR}/${name}` });
    } catch {
      // Don't fail the whole report over one absent file: it is the last step
      // of a run that may have taken hours. Drop the variant and say so.
      missing.push(variant.name);
    }
  }

  return { variants: kept, missing };
}

/** How many lossy variants per codec the comparison aims for. */
export const VARIANT_COUNT = 4;

/**
 * Score targets for the visual comparison, derived from what the run actually
 * achieved rather than fixed.
 *
 * Targets were hardcoded at 60/70/80/90, which broke down at both ends: a
 * low-quality-only run matched none of them and produced an empty comparison,
 * while a run clustered at the top wasted three of the four slots.
 *
 * The range used is the *overlap* of the codecs' score ranges, so every target
 * is reachable by all of them and the flip test compares like with like. Where
 * the ranges don't overlap at all there is nothing meaningful to compare, so it
 * falls back to the union rather than returning nothing -- the report already
 * warns about non-overlapping curves separately.
 */
export function deriveScoreTargets(scoresByCodec, count = VARIANT_COUNT) {
  const ranges = [...scoresByCodec.values()]
    .filter((scores) => scores.length > 0)
    .map((scores) => ({ min: Math.min(...scores), max: Math.max(...scores) }));

  if (ranges.length === 0) return [];

  let low = Math.max(...ranges.map((r) => r.min));
  let high = Math.min(...ranges.map((r) => r.max));
  if (low > high) {
    low = Math.min(...ranges.map((r) => r.min));
    high = Math.max(...ranges.map((r) => r.max));
  }

  if (count <= 1 || high - low < 1) return [Math.round((low + high) / 2)];

  // Evenly spaced across the range, inclusive of both ends. Rounded for
  // readability, then deduped: a narrow range legitimately yields fewer
  // targets rather than several that all land on the same encode.
  const targets = [];
  for (let i = 0; i < count; i += 1) {
    targets.push(Math.round(low + ((high - low) * i) / (count - 1)));
  }
  return [...new Set(targets)];
}

/**
 * A 2x2 red JXL, used to probe browser JPEG XL support. The comparison serves
 * real .jxl files, so without support the whole eye test shows broken images.
 */
const JXL_PROBE = {
  dataUri:
    'data:image/jxl;base64,/woIkAEAEwgBANQAZxMoAQBQoTLKuMHLuZ4vP3RYTNu4ztBW2xaWJIqMY5N0AocksQpsXIA8AAAMMwfN7gCxkgQ=',
  hint:
    'Chrome/Edge: --enable-features=JXL (nightly builds only). ' +
    'Firefox Nightly: set image.jxl.enabled=true in about:config. ' +
    'Safari 17+ supports JPEG XL natively.',
};

/**
 * Pick comparison variants by *nearest measured SSIMULACRA2* to each target,
 * not by quality setting -- matching on the measured metric is the only way to
 * put the two codecs genuinely side by side (plan.md §7).
 */
export function pickVariants({ results, lossless, referenceRelPath, targets }) {
  const variants = [
    {
      name: 'Original (reference PNG)',
      detail: 'the normalised source everything was measured against',
      src: referenceRelPath,
      codec: 'png',
      isOriginal: true,
    },
  ];

  const codecs = [...new Set(results.map((r) => r.codec))].sort();

  // Only name the axes that actually vary. With several subsampling modes or
  // bit depths in one run, two variants at the same effort and quality would
  // otherwise get identical labels and be indistinguishable in the picker.
  const varies = (field, rows = results) => new Set(rows.map((r) => r[field])).size > 1;
  // Only across codecs that really have a depth: JXL's placeholder 8 would
  // otherwise make an 8/10-bit AVIF sweep look like it varied against JXL.
  const showDepth = varies('depth', results.filter((r) => DEPTH_AXIS_CODECS.includes(r.codec)));
  const showYuv = varies('yuv');

  // The slowest configured effort per codec, since that's the quality ceiling.
  // avifenc -s counts down (0 is slowest); cjxl -e counts up.
  const candidatesByCodec = new Map();
  for (const codec of codecs) {
    const forCodec = results.filter((r) => r.codec === codec);
    const efforts = forCodec.map((r) => r.effort);
    const slowest = codec === 'avif' ? Math.min(...efforts) : Math.max(...efforts);
    candidatesByCodec.set(codec, forCodec.filter((r) => r.effort === slowest));
  }

  // Derive targets from the candidates -- the encodes that can actually be
  // picked -- not from every result, which would include efforts that never
  // appear in the comparison.
  const scoreTargets =
    targets ??
    deriveScoreTargets(
      new Map([...candidatesByCodec].map(([codec, list]) => [codec, list.map((r) => r.score)])),
    );

  for (const target of scoreTargets) {
    for (const codec of codecs) {
      const candidates = candidatesByCodec.get(codec) ?? [];
      if (candidates.length === 0) continue;

      const best = candidates.reduce((a, b) =>
        Math.abs(a.score - target) <= Math.abs(b.score - target) ? a : b,
      );

      // Deduped by encode, not by target: with a coarse quality grid two
      // targets can land on the same file, and it should appear once.
      if (variants.some((v) => v.key === best.key)) continue;

      const settings = [best.effortLabel, `q${best.quality}`];
      if (showDepth && DEPTH_AXIS_CODECS.includes(codec)) settings.push(`${best.depth}-bit`);
      if (showYuv && best.yuv) settings.push(best.yuv);

      variants.push({
        // Labelled with the *measured* score, never the target. The target only
        // spreads the picks across the range; printing it was what made a
        // mislabelling guard necessary in the first place.
        name: `${codec.toUpperCase()} ~${Math.round(best.score)} (${settings.join(' ')})`,
        detail:
          `measured ${best.score.toFixed(2)} · ${formatBytes(best.bytes)} · ` +
          `${best.bpp.toFixed(3)} bpp`,
        src: best.bitstream,
        codec,
        key: best.key,
        score: best.score,
        bytes: best.bytes,
      });
    }
  }

  // JXL lossless, per the plan's variant list. This is the *reference* the
  // comparison opens on and that space flips back to: it is pixel-identical to
  // what was scored (the normalised reference, which may differ from the input
  // file in profile, orientation or size), and serving it as .jxl puts it
  // through the same browser decode path as the lossy variants.
  const jxlLossless = lossless.find((row) => row.codec === 'jxl' && !row.skipped);
  if (jxlLossless?.bitstream) {
    variants.push({
      name: 'JXL lossless',
      detail: `${formatBytes(jxlLossless.bytes)} · bit-exact · scores 100.00`,
      src: jxlLossless.bitstream,
      codec: 'jxl',
      isReference: true,
    });
  } else {
    // No lossless JXL row (--no-lossless, skipped, or HDR mode): the original
    // input file serves as the reference instead.
    variants[0].isReference = true;
  }

  return { variants, targets: scoreTargets };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** What the x axis measures: plain SSIMULACRA2, or the PU21 HDR variant. */
export function metricLabel(run) {
  return run.hdr ? 'SSIMULACRA2 (PU21 HDR)' : 'SSIMULACRA2';
}

/** HDR-mode caveats. The comparison is not symmetric, so the report says how. */
export function hdrCaveats(hdr, { timed = false } = {}) {
  const primaries = { srgb: 'sRGB', p3: 'Display P3', bt2020: 'BT.2020' };
  return [
    ...(timed
      ? [
          '<strong>Encode times are not the same kind of work.</strong> The AVIF time includes ' +
            'computing the gain map from both PNGs (<code>avifgainmaputil combine</code>); cjxl ' +
            'reads one PNG. Both are what each format really costs to produce, but the AVIF ' +
            'figure is not a pure encoder speed.',
        ]
      : []),
    '<strong>HDR scores use an experimental metric.</strong> They come from fast-ssim2\u2019s ' +
      '<code>hdr-pu</code> mode, which swaps SSIMULACRA2\u2019s cube-root nonlinearity for PU21 ' +
      'and takes absolute luminance. It has been validated on one HDR dataset (UPIQ) and is ' +
      '<em>not</em> on the same scale as ordinary SSIMULACRA2, so these numbers cannot be read ' +
      'against SDR runs or the usual quality bands.',
    '<strong>AVIF scores carry a precision penalty that JXL scores do not.</strong> AVIF gain ' +
      'maps can only be rendered at 12-bit (libavif\u2019s tone mapper), while JXL decodes at ' +
      '16-bit, like the reference. SSIMULACRA2 is extremely steep near 100: one value changed by ' +
      'one code in a 16-bit image scores ~96.7, and rounding a 16-bit image to 15-bit scores ~89. ' +
      'So an AVIF can\u2019t score much above ~89 however good it is, and near the top of the ' +
      'range the two curves are not directly comparable.',
    '<strong>Only the HDR rendition is scored.</strong> AVIF gain maps are rendered in full by ' +
      'libavif\u2019s tone mapper and compared with the HDR PNG. The SDR rendition, and anything ' +
      'in between that a display with less headroom would show, is not measured.',
    '<strong>The two formats are not encoding the same thing.</strong> The AVIF is a gain-map ' +
      'image: the SDR PNG as its base, plus a gain map libavif computes so that applying it in ' +
      'full reproduces the HDR PNG, at the same quality as the base (<code>--qgain-map</code> = ' +
      '<code>-q</code>; the default is 60 whatever <code>-q</code> is), 8-bit, full resolution. ' +
      'The JXL is the HDR PNG as PQ. That is each format used the way it is meant to be, but on ' +
      'an SDR display the AVIF shows the SDR PNG while the JXL shows whatever tone mapping the ' +
      'browser applies.',
    '<strong>How HDR looks depends on the display.</strong> A gain map scales its boost to the ' +
      'headroom the display has at that moment; PQ states absolute brightness, which the browser ' +
      'fits to the display. So the two can look different even where they score the same, and ' +
      'the difference changes with monitor brightness.',
    `<strong>Colour is signalled as CICP.</strong> The HDR PNG is PQ in ` +
      `${primaries[hdr.primariesName] ?? hdr.primariesName} (from its ${hdr.colourSource}); the ` +
      `SDR PNG is ${primaries[hdr.sdr.primariesName] ?? hdr.sdr.primariesName} with the sRGB ` +
      `curve (from its ${hdr.sdr.colourSource}). Both go into the files as CICP, so neither ` +
      'format pays for an ICC profile.',
    '<strong>Browser decode timings include whatever the browser does with the gain ' +
      'map</strong> for AVIF, and nothing comparable for JXL, which has none.',
  ];
}

/**
 * The original is always the input file, as given. reference.png is only what
 * the scorer reads -- a normalised 8-bit sRGB copy, or in HDR mode the HDR PNG
 * stripped to its pixels and a cICP chunk -- and showing it as "the original"
 * would hide whatever normalising did (colour profile, orientation, downscale).
 */
export function originalVariant(runDir, run) {
  const name = path.basename(run.input);
  let detail;
  if (run.hdr) {
    detail =
      'the HDR input, as given — what everything was scored against; ' +
      `the AVIFs' SDR base is ${path.basename(run.hdr.sdr.input)}`;
  } else {
    detail =
      'the input file — scores are against a normalised 8-bit sRGB copy' +
      (run.reference.resized
        ? `, downscaled to ${run.reference.width}×${run.reference.height} (shown here at the same size)`
        : '');
  }
  return {
    name: `Original (${name})`,
    detail,
    src: path.relative(runDir, run.input),
    codec: path.extname(name).slice(1).toLowerCase() || 'original',
  };
}

/** ColorVideoVDP caveats, when its chart is shown. */
export function cvvdpCaveats(cvvdp) {
  return [
    '<strong>ColorVideoVDP is a second, independent metric.</strong> It comes from the ' +
      'Cambridge graphics group (gfxdisp), with no connection to either codec, so where it and ' +
      'SSIMULACRA2 agree the result is more trustworthy than either alone. It scores in JOD ' +
      '(just-objectionable differences): 10 means no visible difference, and one unit down is a ' +
      'difference 75% of observers would notice. Its scale is not comparable with ' +
      'SSIMULACRA2\u2019s.',
    `<strong>ColorVideoVDP scores assume a specific display:</strong> ${escapeHtml(cvvdp.displayName)}. ` +
      'Viewing conditions decide how visible artefacts are, so the whole curve depends on this ' +
      'choice. At this distance fine artefacts are hard to see, which is why scores cluster ' +
      'close to 10; the differences between curves are still meaningful.',
  ];
}

/** Caveats rendered into the report so the numbers are never read bare (§10). */
export function buildCaveats({ run, results, lossless = [] }) {
  const hasAlpha = run.reference.hasAlpha;
  const decodeBrowsers = new Set();
  for (const r of results) {
    for (const [name, m] of Object.entries(r.decode ?? {})) {
      if (m?.meanMs != null) decodeBrowsers.add(name);
    }
  }
  const hasDecode = decodeBrowsers.size > 0;
  const caveats = [
    '<strong>SSIMULACRA2 is a proxy, not ground truth.</strong> It also shares authorship ' +
      'with libjxl, so treating it as a neutral referee between JXL and AVIF is a known weak ' +
      'point of this methodology. The visual comparison above exists precisely so the metric ' +
      'can be spot-checked by eye.',
    '<strong>One image is not a corpus.</strong> These results are specific to this image’s ' +
      'content. This tool is deliberately single-image; conclusions should not be generalised ' +
      'from one run.',
    '<strong>The eye test and the chart answer different questions.</strong> The comparison is ' +
      'judged <em>after</em> the browser downscales to half size, while SSIMULACRA2 scores at ' +
      '<em>full</em> resolution. Resampling hides fine-grained artifacts that the metric still ' +
      'penalises. Half size is the realistic delivery case, so this is intentional — but the ' +
      'two are not the same measurement.',
    '<strong>The browser’s decode path is not necessarily bit-identical to ' +
      '<code>avifdec</code>/<code>djxl</code></strong> — colour handling for 10-bit AVIF in ' +
      'particular can differ — so what is on screen may deviate slightly from what ' +
      'SSIMULACRA2 scored.',
    ...(run.config.timing.length > 0
      ? [
          `<strong>All-cores timings depend on machine load and core count</strong> ` +
            `(${run.machine.cores} logical cores here). aom at 4:4:4 without tiling ` +
            'parallelises poorly, which is why single-thread timings are collected alongside.',
          `<strong>Encode timings include process spawn overhead</strong> ` +
            `(~${run.spawnOverheadMs.bestMs.toFixed(1)}–${run.spawnOverheadMs.medianMs.toFixed(1)} ms, ` +
            'measured at startup). It is reported here rather than subtracted, so no number has ' +
            'been silently adjusted.',
          '<strong>aom\u2019s output depends on thread count.</strong> ' +
            '<code>avifenc -j 1</code> and <code>-j all</code> produce different bitstreams — ' +
            'measured at <code>-s 0</code> as 23,408 vs 22,955 bytes, a 2% gap, which is the ' +
            'same order as the codec differences being measured. Every file sized and scored ' +
            'here was therefore encoded all-cores; the single-thread column times an encode of ' +
            'the same settings, but for AVIF not byte-for-byte the same file. cjxl is ' +
            'unaffected (identical output either way).',
        ]
      : [
          '<strong>No encode times were measured.</strong> This run used ' +
            '<code>--timing none</code>, so each configuration was encoded exactly once and ' +
            'the cost chart is omitted. The quality numbers are unaffected: the measured file ' +
            'is always encoded all-cores regardless of timing settings, so it is the same file ' +
            'a timed run would have sized and scored.',
        ]),
    '<strong><code>avifenc -q</code> and <code>cjxl -q</code> are different scales</strong> and ' +
      'are never compared directly. The quality axis only generates points; every comparison ' +
      'happens against measured SSIMULACRA2 on the x-axis.',
  ];

  if (run.hdr) caveats.unshift(...hdrCaveats(run.hdr, { timed: run.config.timing.length > 0 }));
  if (run.cvvdp && results.some((r) => r.cvvdp?.jod != null)) caveats.push(...cvvdpCaveats(run.cvvdp));

  if (hasAlpha) {
    caveats.splice(2, 0,
      '<strong>This image has an alpha channel, which inflates scores.</strong> Fully ' +
        'transparent pixels are scored free — two images with completely different RGB content ' +
        'under full transparency score exactly 100 — so absolute scores here are higher than ' +
        'they would be for an opaque image. Curves remain valid <em>within</em> this run, but ' +
        'absolute values should not be compared across images.');
  }

  if (hasDecode) {
    caveats.push(
      '<strong>Decode times come from real browsers, not from <code>avifdec</code>/' +
        '<code>djxl</code>.</strong> They are measured with <code>createImageBitmap</code> ' +
        `in ${escapeHtml([...decodeBrowsers].join(', '))}, which isolates the decode from ` +
        'layout and paint. That makes them representative of what a page actually pays — but ' +
        'they measure <em>those builds\u2019</em> decoders, so they will move as the browsers ' +
        'change and are not a property of the formats themselves.',
      ...(decodeBrowsers.size > 1
        ? [
            '<strong>Decode figures are only comparable within one browser.</strong> Each ' +
              'engine has its own decoders, and its own timer resolution: Firefox reports ' +
              '0.02ms granularity where Chrome reports 0.1ms. Compare codecs down a column, ' +
              'not browsers across one.',
          ]
        : []),
      ...([...decodeBrowsers].includes('safari')
        ? [
            '<strong>Safari cannot run headless.</strong> Its numbers were measured in a ' +
              'visible window, so they include whatever else the compositor was doing. Treat ' +
              'them as slightly noisier than the headless engines.',
          ]
        : []),
      '<strong>Decode timing is all-cores wall clock.</strong> Browser image decoding is ' +
        'multi-threaded with no way to pin it, so unlike the encode columns there is no ' +
        'single-thread counterpart. It was measured serially with nothing else running, but ' +
        'it is still sensitive to machine load and core count.',
      '<strong>Decode is a mean, where encode is a best-of-N.</strong> The difference is ' +
        'deliberate: process-spawn noise is one-sided, so for encoding the minimum is the ' +
        'cleanest estimate. Browser decode varies both ways — over 60 runs the minimum for a ' +
        'lossless JXL came out at 9.6ms against a 14.1ms median, a 33% underestimate — so the ' +
        'mean of many runs is reported instead, after discarding warm-up runs. Hover a point ' +
        'for its standard deviation and run count.',
      '<strong><code>performance.now()</code> is quantised to 0.1ms.</strong> For the ' +
        'fastest decodes here that is a few percent of the measurement on its own, so treat ' +
        'differences between sub-millisecond decodes as noise rather than signal.',
      '<strong>Chrome Canary is required for the JPEG XL half of this chart.</strong> Stable ' +
        'Chrome fails <code>createImageBitmap</code> on <code>.jxl</code> with "The source ' +
        'image could not be decoded", so a run against stable would silently chart AVIF only. ' +
        'Canary needs no flag — it decodes JXL even with <code>--disable-features=JXL</code>.',
    );
  }

  if (lossless.length > 0) caveats.push(
    '<strong>Lossless rows are verified, not asserted by the encoder.</strong> Each is decoded ' +
      'and checked bit-exact against the reference <em>and</em> checked to score exactly ' +
      '100.00. With decode depth matched to the reference, a lossless round-trip must score ' +
      'exactly 100 — decoding wider would cost a flat ~1.66 points — so this doubles as a ' +
      'self-check that the depth matching is still correct.');

  return caveats;
}

export const NON_GOALS = [
  'Subsampling modes beyond the configurable --avif-yuv.',
  'Lossy WebP and JPEG baseline curves (lossless WebP is already included).',
  'BD-rate aggregation across a corpus.',
];

/** Render report.html into `runDir`. Returns the path written. */
export async function buildReport({ runDir, data, results, lossless, warnings = [] }) {
  const template = await readFile(TEMPLATE, 'utf8');

  const { variants: picked, targets: scoreTargets } = pickVariants({
    results,
    lossless: lossless ?? [],
    referenceRelPath: data.run.reference.path,
  });
  Object.assign(picked[0], originalVariant(runDir, data.run));
  const { variants, missing } = await collectReportAssets({ runDir, variants: picked });

  const reportWarnings = missing.length
    ? [
        ...warnings,
        `Visual comparison is missing ${missing.length} variant(s) whose encoded file ` +
          `could not be found: ${missing.join(', ')}. Re-run with --force to re-encode.`,
      ]
    : warnings;

  const payload = {
    run: data.run,
    results: results.map((r) => ({
      key: r.key,
      codec: r.codec,
      seriesId: r.seriesId,
      quality: r.quality,
      effort: r.effort,
      effortLabel: r.effortLabel,
      depth: r.depth,
      yuv: r.yuv,
      qalpha: r.qalpha,
      bytes: r.bytes,
      bpp: r.bpp,
      score: r.score,
      cvvdp: r.cvvdp?.jod ?? null,
      timings: r.timings,
      decode: r.decode ?? null,
      bitstream: r.bitstream,
    })),
    lossless: lossless ?? [],
    warnings: reportWarnings,
    caveats: buildCaveats({ run: data.run, results, lossless: lossless ?? [] }),
    metricLabel: metricLabel(data.run),
    nonGoals: NON_GOALS,
    targets: scoreTargets,
    depthAxisCodecs: DEPTH_AXIS_CODECS,
    variants,
    jxlProbe: JXL_PROBE,
  };

  const json = JSON.stringify(payload).replaceAll('</script>', '<\\/script>');
  // Function replacements, not strings: `$&`, `` $` `` and friends are special
  // in a string replacement, so a filename or path containing one would be
  // silently rewritten into the output. Guard the `</script>` sequence too, or
  // a string inside the JSON could terminate the data block early.
  const html = template
    .replace('__IMAGE_NAME__', () => escapeHtml(path.basename(data.run.input)))
    .replace('__DATA__', () => json);

  const outPath = path.join(runDir, 'report.html');
  await writeFile(outPath, html);
  return outPath;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
