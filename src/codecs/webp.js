// WebP via cwebp/dwebp -- lossless only (plan.md §11: it has no comparable
// quality/effort grid against AVIF and JXL at 4:4:4, so it appears in the
// lossless table but not the lossy sweep).
//
// Finding 6: `-exact` is non-negotiable. Without it cwebp rewrites RGB values
// under fully-transparent pixels to compress better and the round-trip is not
// bit-exact -- which would make a "lossless" claim false. Costs ~0.16%.

export const name = 'webp';
export const extension = 'webp';
export const label = 'WebP (libwebp)';

/** WebP is 8-bit only and caps at 16,383px per side. */
export const MAX_DIMENSION = 16383;

export const losslessOnly = true;

/**
 * cwebp's lossless effort axis is `-z 0..9` ("lossless preset level"), where 9
 * implies method 6. It is the counterpart of avifenc `-s` and cjxl `-e`, but a
 * separate flag, hence its own option.
 */
export const defaults = {
  effort: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
};

export const effortFlag = 'z';
/** cwebp -z: higher is slower/smaller. */
export const effortLabel = (value) => `z${value}`;

/** WebP is 8-bit only: no depth to choose, so no axis. */
export const hasDepthAxis = false;

export const encoder = 'cwebp';
export const decoder = 'dwebp';

export function buildEncodeArgs({ input, output, effort = 9, threads = 'multi' }) {
  // -exact per finding 6: without it cwebp rewrites RGB under transparent
  // pixels and the round-trip is not bit-exact.
  const args = [input, '-lossless', '-z', String(effort), '-exact', '-quiet'];
  if (threads === 'multi') args.push('-mt');
  args.push('-o', output);
  return args;
}

export function buildDecodeArgs({ input, output }) {
  return [input, '-o', output];
}

/** dwebp writes a clean PNG -- no chunk surgery needed. */
export function fixDecoded(buffer) {
  return { buffer, removed: [] };
}

/** One lossless point per configured `-z` level. */
export function losslessConfigs(efforts = defaults.effort) {
  return efforts.map((effort) => ({
    effort,
    effortLabel: effortLabel(effort),
    lossless: true,
    label: `cwebp -lossless -z ${effort} -exact`,
  }));
}

/**
 * Guard the dimension cap. The run skips WebP with a warning above the limit
 * rather than failing the whole grid (plan.md §7).
 */
export function checkSupport({ width, height }) {
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    return {
      supported: false,
      warnings: [
        `WebP skipped: ${width}x${height} exceeds the ${MAX_DIMENSION}px per-side limit.`,
      ],
    };
  }
  return { supported: true, warnings: [] };
}
