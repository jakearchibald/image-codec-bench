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

/**
 * JPEG XL has no equivalent of avifenc's `-d`, so depth is not an axis here.
 *
 * The bitstream does declare 8-bit for an 8-bit input (`jxlinfo` reports
 * "8-bit RGB"), but lossy JXL reconstructs in float/XYB and the 8 bits are only
 * the final rounding step -- decoding a q60 file at 16-bit yields 237 distinct
 * low bytes, where true 8-bit coding would yield exactly 1. Printing "8-bit" in
 * the same column as AVIF's swept depth would invite reading the two as
 * like-for-like when JXL simply has no such knob. (`--override_bitdepth` exists
 * but overrides the *declared* depth, not the coding precision.)
 */
export const hasDepthAxis = false;

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

/**
 * HDR mode: the JXL *is* the HDR rendition, stored as PQ, so a 16-bit decode
 * gives PQ values directly (djxl keeps the stored colour space and writes a
 * cICP chunk for it).
 */
export function hdrDecode({ input, output }) {
  return { command: 'djxl', args: [input, output, '--bits_per_sample=16'] };
}

/** djxl writes a clean PNG -- no chunk surgery needed. */
export function fixDecoded(buffer) {
  return { buffer, removed: [] };
}

/** Lossless config for the §7 table: max effort in the default range. */
/** One lossless point per configured `-e` level. */
export function losslessConfigs(efforts = defaults.effort) {
  return efforts.map((effort) => ({
    effort,
    effortLabel: effortLabel(effort),
    lossless: true,
    label: `cjxl -d 0 -e ${effort}`,
  }));
}

export function checkSupport() {
  return { supported: true, warnings: [] };
}
