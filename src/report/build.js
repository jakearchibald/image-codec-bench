// results.json -> report.html. The report is a pure function of the results
// file (plan.md §6), so it can be rebuilt without re-running the benchmark.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'template.html');

/** Score targets for the visual comparison (plan.md §7). */
export const SCORE_TARGETS = [60, 70, 80, 90];

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
export function pickVariants({ results, lossless, referenceRelPath, targets = SCORE_TARGETS }) {
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

  // The slowest configured effort per codec, since that's the quality ceiling.
  // avifenc -s counts down (0 is slowest); cjxl -e counts up.
  const slowestEffort = new Map();
  for (const codec of codecs) {
    const efforts = results.filter((r) => r.codec === codec).map((r) => r.effort);
    slowestEffort.set(codec, codec === 'avif' ? Math.min(...efforts) : Math.max(...efforts));
  }

  for (const target of targets) {
    for (const codec of codecs) {
      const effort = slowestEffort.get(codec);
      const candidates = results.filter((r) => r.codec === codec && r.effort === effort);
      if (candidates.length === 0) continue;

      const best = candidates.reduce((a, b) =>
        Math.abs(a.score - target) <= Math.abs(b.score - target) ? a : b,
      );

      // Skip a target the series can't get near -- a "target 60" entry that
      // actually scores 91 would misrepresent the comparison.
      if (Math.abs(best.score - target) > 5) continue;
      if (variants.some((v) => v.key === best.key)) continue;

      variants.push({
        name: `${codec.toUpperCase()} ~${target} (${best.effortLabel} q${best.quality})`,
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

  // JXL lossless, per the plan's variant list.
  const jxlLossless = lossless.find((row) => row.codec === 'jxl' && !row.skipped);
  if (jxlLossless?.bitstream) {
    variants.push({
      name: 'JXL lossless',
      detail: `${formatBytes(jxlLossless.bytes)} · bit-exact · scores 100.00`,
      src: jxlLossless.bitstream,
      codec: 'jxl',
    });
  }

  return variants;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Caveats rendered into the report so the numbers are never read bare (§10). */
export function buildCaveats({ run, results }) {
  const hasAlpha = run.reference.hasAlpha;
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
        ]
      : [
          '<strong>No encode times were measured.</strong> This run used ' +
            '<code>--timing none</code>, so each configuration was encoded exactly once and ' +
            'the cost chart is omitted. The quality numbers are unaffected — encoder output is ' +
            'deterministic, so a file encoded once is the same file a timed run would produce.',
        ]),
    '<strong><code>avifenc -q</code> and <code>cjxl -q</code> are different scales</strong> and ' +
      'are never compared directly. The quality axis only generates points; every comparison ' +
      'happens against measured SSIMULACRA2 on the x-axis.',
  ];

  if (hasAlpha) {
    caveats.splice(2, 0,
      '<strong>This image has an alpha channel, which inflates scores.</strong> Fully ' +
        'transparent pixels are scored free — two images with completely different RGB content ' +
        'under full transparency score exactly 100 — so absolute scores here are higher than ' +
        'they would be for an opaque image. Curves remain valid <em>within</em> this run, but ' +
        'absolute values should not be compared across images.');
  }

  caveats.push(
    '<strong>Lossless rows are verified, not asserted by the encoder.</strong> Each is decoded ' +
      'and checked bit-exact against the reference <em>and</em> checked to score exactly ' +
      '100.00. With decode depth matched to the reference, a lossless round-trip must score ' +
      'exactly 100 — decoding wider would cost a flat ~1.66 points — so this doubles as a ' +
      'self-check that the depth matching is still correct.');

  return caveats;
}

export const NON_GOALS = [
  'Decode-time measurement.',
  'Subsampling modes beyond the configurable --avif-yuv.',
  'Lossy WebP and JPEG baseline curves (lossless WebP is already included).',
  'BD-rate aggregation across a corpus.',
];

/** Render report.html into `runDir`. Returns the path written. */
export async function buildReport({ runDir, data, results, lossless, warnings = [] }) {
  const template = await readFile(TEMPLATE, 'utf8');

  const variants = pickVariants({
    results,
    lossless: lossless ?? [],
    referenceRelPath: data.run.reference.path,
  });

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
      timings: r.timings,
      bitstream: r.bitstream,
    })),
    lossless: lossless ?? [],
    warnings,
    caveats: buildCaveats({ run: data.run, results }),
    nonGoals: NON_GOALS,
    targets: SCORE_TARGETS,
    variants,
    jxlProbe: JXL_PROBE,
  };

  const html = template
    .replace('__IMAGE_NAME__', escapeHtml(path.basename(data.run.input)))
    // Guard against a `</script>` sequence inside the JSON terminating the
    // data block early.
    .replace('__DATA__', JSON.stringify(payload).replaceAll('</script>', '<\\/script>'));

  const outPath = path.join(runDir, 'report.html');
  await writeFile(outPath, html);
  return outPath;
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
