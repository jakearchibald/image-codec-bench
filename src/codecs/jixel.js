// JPEG XL via jixel (https://github.com/awxkee/jixel), a Rust encoder ported
// from libjxl-tiny. It has no CLI of its own, so tools/cjixel wraps it; the
// output is a normal .jxl, decoded with djxl exactly like libjxl's.
//
// jixel's own tuning harness scores with SSIMULACRA2, and its slowest speed
// (6, ExtraSlow) runs a SSIMULACRA2-driven quant-field loop inside the
// encoder. That speed gains noticeably more on SSIMULACRA2 than on cvvdp, so
// read its curve with --cvvdp alongside.

import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from '../exec.js';
import * as jxl from './jxl.js';

export const name = 'jixel';
export const extension = 'jxl';
export const label = 'JPEG XL (jixel)';

/** Speeds 1..6 as jixel names them; higher is slower, like cjxl -e. */
export const SPEEDS = ['ultrafast', 'fastest', 'fast', 'medium', 'slow', 'extraslow'];

export const defaults = {
  // To 95, not cjxl's 90: q30..q90 map to the same distances as cjxl, but jixel
  // spends fewer bytes per distance, so q90 (d1.0) is only ~SSIMULACRA2 84.
  // Above 90 its scale falls faster than cjxl's: q95 is d0.28, not d0.55.
  quality: { min: 15, max: 95, step: 5 },
  // Fast is jixel's default; Slow is where it overtakes cjxl -e7.
  effort: [3, 5, 6],
  depth: [8],
  // jixel's patch dictionary (EncodeConfig::patches), off by default. Each
  // setting is its own series; it matters for text and flat graphics.
  patches: [false],
  // Experimental spline coding of thin lines (EncodeConfig::splines), lossy
  // only and off by default; likewise one series per setting.
  splines: [false],
};

/** jixel only codes splines at Slow and ExtraSlow; below, they change nothing. */
export const SPLINES_MIN_SPEED = 5;
export const splinesApply = (speed) => speed >= SPLINES_MIN_SPEED;

/** Like cjxl: no coded-depth knob, so depth is not an axis. */
export const hasDepthAxis = false;

export const effortFlag = 'speed';
/** The speed's name, plus `+patches`/`+splines` for a series with them on. */
export const effortLabel = (value, { patches = false, splines = false } = {}) =>
  `${SPEEDS[value - 1] ?? `s${value}`}${patches ? '+patches' : ''}${splines ? '+splines' : ''}`;

export const encoder = 'cjixel';
export const decoder = jxl.decoder;

const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools/cjixel');
export const ENCODER_PATH = path.join(TOOL_DIR, 'target/release/cjixel');

/**
 * Build tools/cjixel if needed and return its path. cargo is a no-op when it's
 * up to date, so this runs every time: a changed pin rebuilds before the
 * version (and with it the cache key) is read.
 */
export async function ensureEncoder({ log = () => {} } = {}) {
  const built = await access(ENCODER_PATH, constants.X_OK).then(() => true, () => false);
  if (!built) log('Building the jixel encoder (tools/cjixel, one-off)...');
  try {
    await run('cargo', ['build', '--release', '--quiet', '--manifest-path', path.join(TOOL_DIR, 'Cargo.toml')]);
  } catch (error) {
    throw new Error(
      `Could not build tools/cjixel (needs cargo): ${error.message}\n` +
        `Build it by hand with: cargo build --release --manifest-path ${path.relative(process.cwd(), path.join(TOOL_DIR, 'Cargo.toml'))}`,
    );
  }
  return ENCODER_PATH;
}

/**
 * In HDR mode the input is the PQ reference PNG, as for cjxl; cjixel reads its
 * cICP chunk and declares the same colour encoding in the JXL.
 */
export function buildEncodeArgs({
  input, output, quality, effort, threads = 'multi', lossless = false, patches = false, splines = false,
  progressiveDc = false, groupOrder = null,
}) {
  const args = [input, output, ...(lossless ? ['--lossless'] : ['-q', String(quality)]), '-s', String(effort)];
  if (patches) args.push('--patches');
  // Lossy only: cjixel refuses it with --lossless.
  if (splines && !lossless) args.push('--splines');
  // Lossy only (src/progressive.js): a squeezed DC frame first, and the
  // groups' order (scanline, center or diagonals).
  if (progressiveDc) args.push('--progressive-dc');
  if (groupOrder) args.push('--group-order', groupOrder);
  // -j 0 is every core; jixel's own default is a single thread.
  args.push('-j', threads === 'single' ? '1' : '0');
  return args;
}

export const buildDecodeArgs = jxl.buildDecodeArgs;
export const fixDecoded = jxl.fixDecoded;
export const hdrDecode = jxl.hdrDecode;

/** One lossless point per configured speed and patches setting. */
export function losslessConfigs(efforts = defaults.effort, { patches = defaults.patches } = {}) {
  return efforts.flatMap((effort) =>
    patches.map((withPatches) => ({
      effort,
      patches: withPatches,
      effortLabel: effortLabel(effort, { patches: withPatches }),
      lossless: true,
      label: `jixel --lossless -s ${effort}${withPatches ? ' --patches' : ''}`,
    })),
  );
}

export function checkSupport() {
  return { supported: true, warnings: [] };
}
