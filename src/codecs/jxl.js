// JPEG XL via cjxl/djxl.
//
// Finding 3: `--num_threads=0` means no multithreading. The flag only shows up
// in `cjxl -v -v --help`, but it is real -- and cjxl errors on unknown
// arguments, so there is no silent-ignore risk here.

export const name = 'jxl';
export const extension = 'jxl';
export const label = 'JPEG XL (libjxl)';

export const defaults = {
  quality: { min: 15, max: 90, step: 5 },
  effort: [7, 8, 9, 10],
  depth: [8],
};

export const effortFlag = 'effort';
/** cjxl -e: higher is slower/better. */
export const effortLabel = (value) => `e${value}`;

export const encoder = 'cjxl';
export const decoder = 'djxl';

export function buildEncodeArgs({
  input,
  output,
  quality,
  effort,
  threads = 'multi',
  lossless = false,
}) {
  const args = [input, output, '-e', String(effort)];

  if (lossless) {
    // -d 0 is mathematically lossless for a PNG source.
    args.push('-d', '0');
  } else {
    args.push('-q', String(quality));
  }

  if (threads === 'single') args.push('--num_threads=0');
  return args;
}

export function buildDecodeArgs({ input, output, referenceDepth = 8 }) {
  // Finding 2: pin output depth to the reference. djxl's default already
  // matches an 8-bit source, but being explicit means a 10-bit source can't
  // silently widen the decode later.
  return [input, output, `--bits_per_sample=${referenceDepth}`];
}

/** djxl writes a clean PNG -- no chunk surgery needed. */
export async function fixDecoded() {
  return [];
}

/** Lossless config for the §7 table: max effort in the default range. */
export function losslessConfig() {
  return { effort: 9, lossless: true, label: 'cjxl -d 0 -e 9' };
}

export function checkSupport() {
  return { supported: true, warnings: [] };
}
