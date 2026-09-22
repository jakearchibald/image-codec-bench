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

export const encoder = 'cwebp';
export const decoder = 'dwebp';

export function buildEncodeArgs({ input, output, threads = 'multi' }) {
  // -z 9 is max lossless effort (implies method 6). -exact per finding 6.
  const args = [input, '-lossless', '-z', '9', '-exact', '-quiet'];
  if (threads === 'multi') args.push('-mt');
  args.push('-o', output);
  return args;
}

export function buildDecodeArgs({ input, output }) {
  return [input, '-o', output];
}

export async function fixDecoded() {
  return [];
}

export function losslessConfig() {
  return { lossless: true, label: 'cwebp -lossless -z 9 -exact' };
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
