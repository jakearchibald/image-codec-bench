// Configuration resolution: CLI flags, optional --config bench.json, defaults.
// Everything that affects runtime is configurable per run (plan.md §4).

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_TARGETS, parseDropTargets, parseTargets } from './browsers.js';
import { avif, jxl, webp } from './codecs/index.js';
import { parseRange } from './schedule.js';

export const OPTIONS = {
  config: { type: 'string' },
  out: { type: 'string', default: 'out' },

  'avif-quality': { type: 'string' },
  'avif-speed': { type: 'string' },
  'avif-depth': { type: 'string' },
  'avif-yuv': { type: 'string' },
  'avif-qalpha': { type: 'string' },

  'jxl-quality': { type: 'string' },
  'jxl-effort': { type: 'string' },

  'webp-effort': { type: 'string' },

  codecs: { type: 'string' },
  timing: { type: 'string' },
  'no-timing': { type: 'boolean' },
  repeats: { type: 'string' },
  'repeat-budget': { type: 'string' },
  'max-pixels': { type: 'string' },
  sdr: { type: 'string' },
  cvvdp: { type: 'boolean' },
  'score-concurrency': { type: 'string' },
  'decode-browsers': { type: 'string' },
  'drop-decode': { type: 'string' },
  'no-decode-timing': { type: 'boolean' },
  'decode-repeats': { type: 'string' },
  'decode-budget': { type: 'string' },
  chrome: { type: 'string' },
  firefox: { type: 'string' },
  chromedriver: { type: 'string' },
  geckodriver: { type: 'string' },
  safaridriver: { type: 'string' },

  lossless: { type: 'boolean' },
  'no-lossless': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  force: { type: 'boolean' },
  'keep-decoded': { type: 'boolean' },
  'no-report': { type: 'boolean' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

/** Parse a duration like `2s`, `500ms`, `1.5s`, or a bare number of seconds. */
export function parseDuration(spec) {
  const text = String(spec).trim().toLowerCase();
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/);
  if (!match) throw new Error(`Bad duration '${spec}' (try '2s', '500ms')`);
  const value = Number(match[1]);
  switch (match[2]) {
    case 'ms':
      return value;
    case 'm':
      return value * 60_000;
    case 's':
    case undefined:
    default:
      return value * 1000;
  }
}

/** Parse `--max-pixels` which accepts `0`, a count, or `12MP`/`2.5mp`. */
export function parsePixels(spec) {
  const text = String(spec).trim().toLowerCase();
  const mp = text.match(/^(\d+(?:\.\d+)?)\s*mp$/);
  if (mp) return Math.round(Number(mp[1]) * 1e6);
  const value = Number(text);
  if (Number.isNaN(value) || value < 0) throw new Error(`Bad --max-pixels '${spec}'`);
  return Math.round(value);
}

/** Subsampling modes avifenc accepts, in canonical order. */
export const YUV_MODES = ['444', '422', '420', '400'];

/**
 * Parse `--avif-yuv`: one mode or a comma list, e.g. `444,420`. Each mode is a
 * separate series, so this multiplies the AVIF grid the same way `--avif-depth`
 * does.
 */
export function parseYuvModes(spec) {
  const modes = String(spec)
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);

  if (modes.length === 0) throw new Error('--avif-yuv needs at least one mode');
  for (const mode of modes) {
    if (!YUV_MODES.includes(mode)) {
      throw new Error(`--avif-yuv must be one of ${YUV_MODES.join(', ')} (got ${mode})`);
    }
  }
  // Canonical order and deduped, so series order and cache keys don't depend on
  // the order they were typed in.
  return YUV_MODES.filter((m) => modes.includes(m));
}

function parseTiming(spec) {
  const modes = String(spec)
    .split(',')
    .map((m) => m.trim().toLowerCase())
    .filter((m) => m.length > 0);

  // `none` skips timing entirely: each job is encoded exactly once, with no
  // repeats and no threading sweep. Much faster when you only want the
  // quality curve -- the default config spends most of its time re-encoding
  // the same job to get a stable measurement.
  if (modes.includes('none')) {
    if (modes.length > 1) {
      throw new Error("--timing 'none' cannot be combined with other modes");
    }
    return [];
  }

  for (const mode of modes) {
    if (mode !== 'single' && mode !== 'multi') {
      throw new Error(`Bad --timing '${mode}' (expected 'single', 'multi' or 'none')`);
    }
  }
  if (modes.length === 0) throw new Error('--timing needs at least one mode');
  // Deterministic order so column layout and cache keys are stable.
  return ['single', 'multi'].filter((m) => modes.includes(m));
}

/**
 * Resolve the final config from parsed CLI values and an optional JSON file.
 * CLI flags win over the file; the file wins over defaults.
 */
export async function resolveConfig(values, positionals) {
  const fileConfig = values.config
    ? JSON.parse(await readFile(values.config, 'utf8'))
    : {};

  const input = positionals[0] ?? fileConfig.input;
  if (!input) throw new Error('No input image given.');

  const pick = (flag, fileKey, fallback) =>
    values[flag] ?? fileConfig[fileKey] ?? fallback;

  const codecNames = String(pick('codecs', 'codecs', 'avif,jxl'))
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0);

  for (const name of codecNames) {
    if (name !== 'avif' && name !== 'jxl') {
      throw new Error(
        `Codec '${name}' is not part of the lossy sweep (plan.md §11: WebP is lossless-only).`,
      );
    }
  }

  const losslessRequested = values.lossless === true || fileConfig.lossless === true;
  const losslessDisabled = values['no-lossless'] === true || fileConfig.lossless === false;

  const config = {
    input: path.resolve(input),
    out: path.resolve(String(pick('out', 'out', 'out'))),
    codecs: codecNames,

    avif: {
      quality: parseRange(pick('avif-quality', 'avifQuality', rangeSpec(avif.defaults.quality)), { integer: true }),
      effort: parseRange(pick('avif-speed', 'avifSpeed', avif.defaults.effort.join(',')), { integer: true }),
      depth: parseRange(pick('avif-depth', 'avifDepth', avif.defaults.depth.join(',')), { integer: true }),
      yuv: parseYuvModes(pick('avif-yuv', 'avifYuv', avif.defaults.yuv)),
      qalpha: String(pick('avif-qalpha', 'avifQalpha', avif.defaults.qalpha)),
    },

    jxl: {
      quality: parseRange(pick('jxl-quality', 'jxlQuality', rangeSpec(jxl.defaults.quality)), { integer: true }),
      effort: parseRange(pick('jxl-effort', 'jxlEffort', jxl.defaults.effort.join(',')), { integer: true }),
      depth: [8],
    },

    // WebP appears in the lossless suite only, so it has an effort axis and
    // nothing else.
    webp: {
      effort: parseRange(pick('webp-effort', 'webpEffort', webp.defaults.effort.join(',')), { integer: true }),
    },

    timing: parseTiming(
      values['no-timing'] ? 'none' : pick('timing', 'timing', 'single,multi'),
    ),
    repeats: Number(pick('repeats', 'repeats', 3)),
    repeatBudgetMs: parseDuration(pick('repeat-budget', 'repeatBudget', '2s')),
    maxPixels: parsePixels(pick('max-pixels', 'maxPixels', 0)),
    // HDR mode (src/hdr.js): the input is a PQ PNG and this is the SDR
    // rendition of the same image, used as the AVIF gain map's base.
    sdr: (values.sdr ?? fileConfig.sdr) ? path.resolve(values.sdr ?? fileConfig.sdr) : null,
    // Score with ColorVideoVDP as well as SSIMULACRA2 (src/cvvdp.js). The
    // prepared setup replaces this with an object once the run has a reference.
    useCvvdp: values.cvvdp === true || fileConfig.cvvdp === true,
    cvvdp: null,
    scoreConcurrency: Number(pick('score-concurrency', 'scoreConcurrency', defaultConcurrency())),

    // Browser decode timing. The default set is best-effort: a browser that
    // isn't installed costs a note, not a failed run. Naming browsers
    // explicitly makes them required, since asking for Safari and silently
    // getting nothing is worse than an error.
    decodeBrowsers: values['no-decode-timing'] === true || fileConfig.decodeTiming === false
      ? []
      : parseTargets(pick('decode-browsers', 'decodeBrowsers', DEFAULT_TARGETS.join(','))),
    decodeBrowsersExplicit: Boolean(values['decode-browsers'] ?? fileConfig.decodeBrowsers),
    browserPaths: {
      chrome: values.chrome ?? fileConfig.chrome ?? null,
      firefox: values.firefox ?? fileConfig.firefox ?? null,
    },
    driverPaths: {
      chrome: values.chromedriver ?? fileConfig.chromedriver ?? null,
      firefox: values.geckodriver ?? fileConfig.geckodriver ?? null,
      safari: values.safaridriver ?? fileConfig.safaridriver ?? null,
      'safari-preview': null,
    },
    // Maintenance action rather than part of a run: drop stored decode
    // measurements so the next run re-measures them.
    dropDecode: values['drop-decode'] ? parseDropTargets(values['drop-decode']) : [],
    decodeRepeats: Number(pick('decode-repeats', 'decodeRepeats', 20)),
    decodeBudgetMs: parseDuration(pick('decode-budget', 'decodeBudget', '2s')),

    lossless: losslessDisabled ? false : losslessRequested || fileConfig.lossless !== false,
    dryRun: values['dry-run'] === true,
    force: values.force === true,
    keepDecoded: values['keep-decoded'] === true,
    report: values['no-report'] !== true && fileConfig.report !== false,
    quiet: values.quiet === true,
  };

  validate(config);
  return config;
}

function rangeSpec({ min, max, step }) {
  return `${min}:${max}:${step}`;
}

function defaultConcurrency() {
  // Scoring is CPU-bound; leave a little headroom for the OS.
  return Math.max(1, Math.min(8, os.cpus().length - 2));
}

function validate(config) {
  if (!Number.isInteger(config.repeats) || config.repeats < 1) {
    throw new Error('--repeats must be an integer >= 1');
  }
  if (!Number.isInteger(config.scoreConcurrency) || config.scoreConcurrency < 1) {
    throw new Error('--score-concurrency must be an integer >= 1');
  }
  if (!Number.isInteger(config.decodeRepeats) || config.decodeRepeats < 1) {
    throw new Error('--decode-repeats must be an integer >= 1');
  }
  if (!(config.decodeBudgetMs > 0)) {
    throw new Error('--decode-budget must be greater than zero');
  }
  for (const q of config.avif.quality) {
    if (q < 0 || q > 100) throw new Error(`avifenc -q out of range: ${q} (expected 0..100)`);
  }
  for (const s of config.avif.effort) {
    if (s < 0 || s > 10) throw new Error(`avifenc -s out of range: ${s} (expected 0..10)`);
  }
  for (const d of config.avif.depth) {
    if (![8, 10, 12].includes(d)) throw new Error(`avifenc -d must be 8, 10 or 12, got ${d}`);
  }
  if (config.avif.qalpha !== 'match') {
    const value = Number(config.avif.qalpha);
    if (Number.isNaN(value) || value < 0 || value > 100) {
      throw new Error(`--avif-qalpha must be 'match' or 0..100 (got ${config.avif.qalpha})`);
    }
  }
  for (const q of config.jxl.quality) {
    if (q < 0 || q > 100) throw new Error(`cjxl -q out of range: ${q} (expected 0..100)`);
  }
  for (const e of config.jxl.effort) {
    if (e < 1 || e > 10) throw new Error(`cjxl -e out of range: ${e} (expected 1..10)`);
  }
  for (const z of config.webp.effort) {
    if (z < 0 || z > 9) throw new Error(`cwebp -z out of range: ${z} (expected 0..9)`);
  }
}

export const HELP = `image-codec-bench -- sweep an image through AVIF and JPEG XL,
score with SSIMULACRA2, emit a table and an HTML report.

Usage:
  node src/cli.js <image> [options]

Options:
  --out DIR                  output directory (default: out)
  --config FILE              JSON config; CLI flags override it

  --avif-quality RANGE       avifenc -q  (default 20:90:5)
  --avif-speed RANGE         avifenc -s  (default 0-6; 0 is slowest)
  --avif-depth LIST          avifenc -d  (default 8; e.g. 8,10)
  --avif-yuv LIST            444 | 422 | 420 | 400, comma-separated
                             (default 444; each mode is its own series)
  --avif-qalpha VALUE        'match' to track -q, or 0..100 (default match)

  --jxl-quality RANGE        cjxl -q     (default 15:90:5)
  --jxl-effort RANGE         cjxl -e     (default 7-10)
  --webp-effort RANGE        cwebp -z, lossless only (default 0-9)

  --codecs LIST              lossy sweep codecs (default avif,jxl)
  --timing MODES             single,multi,none (default both)
  --no-timing                same as --timing none: encode each job once and
                             skip timing entirely. Much faster when you only
                             want the quality curve.
  --repeats N                max timed runs per job (default 3)
  --repeat-budget DURATION   stop repeating past this cumulative time (default 2s)
  --max-pixels N             downscale source to fit N pixels (default 0 = off;
                             not available for HDR input)
  --sdr FILE                 HDR mode: the input is an HDR (PQ) PNG and FILE is the
                             SDR rendition, used as the AVIF gain map's base
  --cvvdp                    also score with ColorVideoVDP (needs the venv in
                             tools/cvvdp; see README)
  --score-concurrency N      parallel scoring jobs (default cores-2, max 8)

  --decode-browsers LIST     chrome, firefox, safari, safari-preview,
                             all, none (default firefox). Named browsers are
                             required; the default set is best-effort.
  --drop-decode LIST         delete stored decode results for these browsers
                             (or 'all') so the next run re-measures them, then
                             exit without running anything
  --no-decode-timing         skip browser decode timing
  --decode-repeats N         createImageBitmap runs per image (default 20;
                             the mean is reported, warm-up runs discarded)
  --decode-budget DURATION   stop repeating an image past this cumulative
                             time, min 5 runs (default 2s)
  --chrome PATH              Chrome binary (default: Canary, which is required
                             for JPEG XL -- stable Chrome cannot decode it)
  --firefox PATH             Firefox binary (default: Nightly, required for JXL)
  --chromedriver PATH        driver override; otherwise a version-matched
                             chromedriver is downloaded and cached
  --geckodriver PATH         driver override; otherwise downloaded and cached
  --safaridriver PATH        driver override (default /usr/bin/safaridriver)

  --no-lossless              skip the lossless suite
  --dry-run                  calibrate, print job count and ETA, then stop
  --force                    ignore cached results
  --keep-decoded             keep decoded PNGs (large; debugging only)
  --no-report                skip report.html
  --quiet                    suppress the progress bar
  -h, --help                 this text

Ranges accept 'min:max:step', 'a-b', or an explicit comma list.

Examples:
  node src/cli.js photo.png --dry-run
  node src/cli.js photo.png --no-timing        # quality only, fastest
  node src/cli.js photo.png --avif-speed 4,6 --jxl-effort 7 --timing multi
  node src/cli.js photo.png --max-pixels 2MP --out results/
  node src/cli.js photo-hdr.png --sdr photo-sdr.png   # HDR: gain-map AVIF vs PQ JXL
`;
