// Input -> canonical reference PNG. Everything downstream (both encoders and
// the scorer) reads this one file, so no encoder gets to interpret an embedded
// ICC profile differently (plan.md §3 step 1).
//
// Finding 4 is why the depth assertion exists: `magick plasma:` writes 16-bit
// PNG silently, which made cwebp look like it was winning on lossless when it
// was actually quantising. Getting this wrong invalidates every number, so we
// assert rather than trust.

import { readFile, writeFile } from 'node:fs/promises';

import { run } from './exec.js';
import { readHeader, stripChunks } from './png.js';

/**
 * Normalise `input` to an 8-bit sRGB PNG at `output`.
 *
 * - converts to sRGB and strips metadata, so no downstream colour transform
 * - preserves alpha (plan.md §3: both codecs carry it through correctly)
 * - optional Lanczos downscale via `maxPixels`
 */
export async function normalise(input, output, { maxPixels = 0 } = {}) {
  const source = await sourceInfo(input);
  const args = [input, '-auto-orient', '-colorspace', 'sRGB', '-strip'];

  if (maxPixels > 0) {
    // `@` means "fit within this many pixels", preserving aspect ratio. Only
    // shrink, never enlarge (`>` would need the area form; magick's @ already
    // scales down only when the source is larger, but we guard anyway below).
    args.push('-filter', 'Lanczos', '-resize', `${maxPixels}@>`);
  }

  // -depth 8 after the resize so the filter works at full precision, and
  // PNG24/PNG32 to pin the output format rather than let magick choose.
  args.push('-depth', '8');

  args.push(source.hasAlpha ? `PNG32:${output}` : `PNG24:${output}`);

  await run('magick', args);

  // Strip colour chunks so nothing re-interprets the reference, then assert.
  const stripped = stripChunks(await readFile(output));
  if (stripped.removed.length > 0) await writeFile(output, stripped.buffer);

  const header = readHeader(await readFile(output));
  assertReference(header);

  return {
    path: output,
    width: header.width,
    height: header.height,
    depth: header.depth,
    channels: header.channels,
    hasAlpha: header.channels === 4,
    megapixels: (header.width * header.height) / 1e6,
    strippedChunks: stripped.removed,
    // Did a resize actually happen? Comparing against the source dimensions,
    // rather than just "was --max-pixels set", keeps this honest when the
    // source already fitted within the budget.
    resized: header.width !== source.width || header.height !== source.height,
    source,
  };
}

/** Source dimensions and whether it carries a meaningful alpha channel. */
async function sourceInfo(input) {
  const { stdout } = await run('magick', [
    'identify',
    '-format',
    '%w %h %[opaque]',
    `${input}[0]`,
  ]);
  const [width, height, opaque] = stdout.trim().split(/\s+/);
  return {
    width: Number(width),
    height: Number(height),
    hasAlpha: opaque.toLowerCase() === 'false',
  };
}

/**
 * The reference must be 8-bit (finding 4) and RGB or RGBA. Anything else means
 * the pipeline's depth-matching assumption (finding 2) no longer holds.
 */
export function assertReference(header) {
  if (header.depth !== 8) {
    throw new Error(
      `Reference image must be 8-bit, got ${header.depth}-bit. ` +
        'A wider reference breaks the depth-matched decode (plan.md §2 finding 2) ' +
        'and silently invalidates the lossless comparison (finding 4).',
    );
  }
  if (header.channels !== 3 && header.channels !== 4) {
    throw new Error(
      `Reference image must be RGB or RGBA, got ${header.channels} channel(s).`,
    );
  }
  if (header.interlaced) {
    throw new Error('Reference image must not be interlaced.');
  }
}
