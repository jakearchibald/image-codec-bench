// PNG via oxipng -- lossless only, like WebP.
//
// The "source PNG" row is the normalised reference, which ImageMagick wrote
// with its default zlib settings: 3-44% larger than the same pixels through
// `oxipng -o 6` on the test inputs. That makes it a poor stand-in for "PNG",
// since any PNG served on the web has usually been through an optimiser.
//
// oxipng's lossless reductions (palette, greyscale, bit depth, dropping an
// opaque alpha) change the PNG's header but not its pixels, so the decode
// re-expands to the reference's layout before scoring and the bit-exact check.

export const name = 'png';
export const extension = 'png';
export const label = 'PNG (oxipng)';

export const losslessOnly = true;

/** oxipng -o 0..6. 6 is also what `-o max` currently aliases. */
export const defaults = {
  effort: [0, 1, 2, 3, 4, 5, 6],
};

export const effortFlag = 'o';
/** oxipng -o: higher is slower/smaller. */
export const effortLabel = (value) => `o${value}`;

export const hasDepthAxis = false;

export const encoder = 'oxipng';
export const decoder = 'magick';

export function buildEncodeArgs({ input, output, effort = 6, threads = 'multi' }) {
  // --force: without it oxipng writes the input unchanged whenever it can't
  // beat it, so low levels would report ImageMagick's encode, not oxipng's.
  const args = ['-q', '-o', String(effort), '--force'];
  if (threads === 'single') args.push('-t', '1');
  args.push('--out', output, input);
  return args;
}

/**
 * Re-expand to the reference's depth and channel count, since oxipng may have
 * written a palette or greyscale PNG. PNG24/PNG32 pin the layout, as in
 * normalise.js.
 */
export function buildDecodeArgs({ input, output, referenceDepth = 8, referenceChannels = 3 }) {
  return [
    input,
    '-depth',
    String(referenceDepth),
    `${referenceChannels === 4 ? 'PNG32' : 'PNG24'}:${output}`,
  ];
}

/** magick may add gAMA/cHRM; nothing downstream should re-interpret colour. */
export { stripChunks as fixDecoded } from '../png.js';

/** One lossless point per configured `-o` level. */
export function losslessConfigs(efforts = defaults.effort) {
  return efforts.map((effort) => ({
    effort,
    effortLabel: effortLabel(effort),
    lossless: true,
    label: `oxipng -o ${effort}`,
  }));
}

/** PNG has no practical dimension cap at these sizes. */
export function checkSupport() {
  return { supported: true, warnings: [] };
}
