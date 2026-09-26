// ColorVideoVDP (gfxdisp): an optional second quality metric, from a lab with
// no stake in either codec. Opt-in with --cvvdp, because it is a Python +
// PyTorch install (~1 GB) rather than a single binary.
//
// Two things about the tool shape how it is driven:
//  - It interprets pixels by the *display model's* colour space and ignores
//    the files' own colour tags. So each run writes a display model whose
//    colour space matches the reference -- and since a custom display file
//    replaces the built-in list rather than extending it, the config written
//    here is self-contained.
//  - It reads every .png through FreeImage, whose downloadable build is x86
//    only. TIFF goes through tifffile (pure Python) instead, so images are
//    handed over as TIFF.
//
// Scores are JOD ("just-objectionable differences"): 10 means no visible
// difference, and each unit down is a difference 75% of observers would pick.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from './exec.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CVVDP_DIR = path.join(ROOT, 'tools', 'cvvdp');
const VENV_BIN = path.join(CVVDP_DIR, '.venv', 'bin');

export const INSTALL_HINT =
  'Install it into a venv in tools/cvvdp:\n' +
  '  python3 -m venv tools/cvvdp/.venv\n' +
  '  tools/cvvdp/.venv/bin/pip install -r tools/cvvdp/requirements.txt';

/** Locate cvvdp and read its package version, or say why it isn't usable. */
export async function probeCvvdp() {
  const bin = path.join(VENV_BIN, 'cvvdp');
  const version = await run(path.join(VENV_BIN, 'python'), [
    '-c',
    "import importlib.metadata as m; print(m.version('cvvdp')); import tifffile",
  ], { allowFailure: true });
  if (version.code !== 0) {
    return { present: false, reason: version.code === 'ENOENT' ? 'not installed' : version.stderr.trim() };
  }
  return { present: true, path: bin, version: version.stdout.trim().split('\n')[0] };
}

// Colour spaces the metric may need, defined here in full (see above). Only
// RGB->XYZ is required; values are the standard D65 matrices.
const COLOUR_SPACES = {
  'bench-sRGB': {
    EOTF: 'sRGB', whitepoint: 'D65',
    RGB2X: [0.4124564, 0.3575761, 0.1804375],
    RGB2Y: [0.2126729, 0.7151522, 0.072175],
    RGB2Z: [0.0193339, 0.119192, 0.9503041],
  },
  'bench-BT.709-PQ': {
    EOTF: 'PQ', whitepoint: 'D65',
    RGB2X: [0.4124564, 0.3575761, 0.1804375],
    RGB2Y: [0.2126729, 0.7151522, 0.072175],
    RGB2Z: [0.0193339, 0.119192, 0.9503041],
  },
  'bench-P3-PQ': {
    EOTF: 'PQ', whitepoint: 'D65',
    RGB2X: [0.4865709, 0.2656677, 0.1982173],
    RGB2Y: [0.2289746, 0.6917385, 0.0792869],
    RGB2Z: [0.0, 0.0451134, 1.0439444],
  },
  'bench-BT.2020-PQ': {
    EOTF: 'PQ', whitepoint: 'D65',
    RGB2X: [0.637, 0.1446, 0.1689],
    RGB2Y: [0.2627, 0.678, 0.0593],
    RGB2Z: [0.0, 0.0281, 1.061],
  },
};

const PQ_COLOUR_SPACE = { 1: 'bench-BT.709-PQ', 12: 'bench-P3-PQ', 9: 'bench-BT.2020-PQ' };

/**
 * The display the scores assume: cvvdp's own `standard_4k` for SDR and
 * `standard_hdr_pq` for HDR, with the colour space set to match the
 * reference. The viewing conditions decide how visible artefacts are, so the
 * description is carried into the results and the report.
 */
export function displayModel(hdr) {
  const common = {
    resolution: [3840, 2160],
    viewing_distance_meters: 0.7472,
    diagonal_size_inches: 30,
    source: 'none',
  };
  if (hdr) {
    return {
      id: `standard_hdr_pq-${hdr.primaries}`,
      model: {
        ...common,
        name:
          '30-inch 4K HDR monitor, peak luminance 1500 cd/m^2, viewed under low light levels ' +
          '(10 lux), seen from 2 x display height (cvvdp standard_hdr_pq)',
        colorspace: PQ_COLOUR_SPACE[hdr.primaries],
        max_luminance: 1500,
        contrast: 1000000,
        E_ambient: 10,
      },
    };
  }
  return {
    id: 'standard_4k',
    model: {
      ...common,
      name:
        '30-inch 4K monitor, peak luminance 200 cd/m^2, viewed under office light levels ' +
        '(250 lux), seen from 2 x display height (cvvdp standard_4k)',
      colorspace: 'bench-sRGB',
      max_luminance: 200,
      contrast: 1000,
      E_ambient: 250,
    },
  };
}

/**
 * Everything a scoring job needs: the tool, the display, and the config files
 * that define it (written to `dir`). `id` identifies the measurement, so a
 * stored JOD is only reused if it came from the same version and display.
 */
export async function prepareCvvdp({ probe, hdr, dir }) {
  const display = displayModel(hdr);
  const displayFile = path.join(dir, 'display_models_bench.json');
  const coloursFile = path.join(dir, 'color_spaces_bench.json');
  await writeFile(displayFile, JSON.stringify({ [display.id]: display.model }, null, 2));
  await writeFile(coloursFile, JSON.stringify(COLOUR_SPACES, null, 2));
  return {
    bin: probe.path,
    version: probe.version,
    display: display.id,
    displayName: display.model.name,
    configPaths: [displayFile, coloursFile],
    id: `${probe.version}|${display.id}`,
  };
}

/** Is a stored measurement from this exact setup? */
export function isCurrent(stored, cvvdp) {
  return Boolean(stored && stored.id === cvvdp.id && typeof stored.jod === 'number');
}

/**
 * PNG -> TIFF at the same depth, pixel values untouched. -strip matters: with
 * no profile ImageMagick converts nothing, so PQ codes stay PQ codes.
 */
export async function toTiff(png, tif) {
  await run('magick', [png, '-strip', '-compress', 'none', tif]);
}

/** Parse cvvdp's score: a bare number with --quiet, `cvvdp=9.9682 [JOD]` without. */
export function parseJod(stdout) {
  const match = stdout.trim().match(/^(?:cvvdp=)?(-?\d+(?:\.\d+)?)/m);
  if (!match) throw new Error(`Could not parse a ColorVideoVDP score from: ${JSON.stringify(stdout.trim())}`);
  return Number(match[1]);
}

/**
 * Score one test TIFF against the reference TIFF. Only one runs at a time
 * (`limit`): each call already uses the GPU or every core, so running them
 * alongside each other just contends.
 */
export async function scoreCvvdp({ cvvdp, test, reference }) {
  return limit(async () => {
    const { stdout, ms } = await run(cvvdp.bin, [
      '--test', test, '--ref', reference,
      '--display', cvvdp.display,
      '--config-paths', ...cvvdp.configPaths,
      '--quiet',
    ]);
    return { jod: parseJod(stdout), id: cvvdp.id, ms };
  });
}

let queue = Promise.resolve();
function limit(task) {
  const result = queue.then(task);
  queue = result.catch(() => {});
  return result;
}
