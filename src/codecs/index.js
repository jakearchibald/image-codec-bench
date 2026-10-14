// Codec registry. Adding a codec is one file plus one line here (plan.md §8).

import * as avif from './avif.js';
import * as jixel from './jixel.js';
import * as jxl from './jxl.js';
import * as webp from './webp.js';

export const codecs = { avif, jxl, jixel, webp };

/** Codecs that take part in the lossy quality x effort sweep. */
export const lossyCodecs = [avif, jxl, jixel];

/** Codecs in the lossless table. jixel only joins when --codecs names it. */
export const losslessCodecs = [jxl, jixel, webp, avif];

export function getCodec(name) {
  const codec = codecs[name];
  if (!codec) {
    throw new Error(`Unknown codec '${name}'. Known: ${Object.keys(codecs).join(', ')}`);
  }
  return codec;
}

export { avif, jixel, jxl, webp };
