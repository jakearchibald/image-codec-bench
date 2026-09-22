// Codec registry. Adding a codec is one file plus one line here (plan.md §8).

import * as avif from './avif.js';
import * as jxl from './jxl.js';
import * as webp from './webp.js';

export const codecs = { avif, jxl, webp };

/** Codecs that take part in the lossy quality x effort sweep. */
export const lossyCodecs = [avif, jxl];

/** Codecs in the lossless table. */
export const losslessCodecs = [jxl, webp, avif];

export function getCodec(name) {
  const codec = codecs[name];
  if (!codec) {
    throw new Error(`Unknown codec '${name}'. Known: ${Object.keys(codecs).join(', ')}`);
  }
  return codec;
}

export { avif, jxl, webp };
