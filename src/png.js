// Minimal PNG chunk handling. No dependencies: we only need to read IHDR and
// drop colour-management chunks, both of which are a flat walk over the chunk
// list. See plan.md §2 finding 1 -- avifdec writes a cICP chunk that libjxl's
// PNG reader rejects outright, so stripping it is load-bearing, not cosmetic.

import { readFile, writeFile } from 'node:fs/promises';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Colour-management chunks. Dropping these stops any downstream tool applying
// its own transform to the decoded image before scoring (plan.md §3 step 1).
export const COLOUR_CHUNKS = new Set(['cICP', 'cHRM', 'gAMA', 'iCCP', 'sRGB']);

const COLOUR_TYPE_CHANNELS = {
  0: 1, // greyscale
  2: 3, // truecolour
  3: 1, // indexed
  4: 2, // greyscale + alpha
  6: 4, // truecolour + alpha
};

export function isPng(buffer) {
  return buffer.length >= 8 && buffer.subarray(0, 8).equals(SIGNATURE);
}

/**
 * Walk the chunk list. Yields `{ type, length, start, end }` where the range
 * covers the whole chunk including length, type and CRC.
 */
export function* chunks(buffer) {
  if (!isPng(buffer)) throw new Error('Not a PNG file (bad signature)');
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length) {
      throw new Error(`Truncated PNG: chunk ${type} claims ${length} bytes`);
    }
    yield { type, length, start: offset, end };
    if (type === 'IEND') return;
    offset = end;
  }
  // Falling out of the loop means we ran off the end without seeing IEND, so
  // the file is truncated. Returning quietly here would let a half-written
  // decode reach the scorer and be reported as a real measurement.
  throw new Error('Truncated PNG: no IEND chunk');
}

/** Parse IHDR into `{ width, height, depth, colourType, channels, interlaced }`. */
export function readHeader(buffer) {
  for (const chunk of chunks(buffer)) {
    if (chunk.type !== 'IHDR') continue;
    const d = buffer.subarray(chunk.start + 8, chunk.end - 4);
    const colourType = d.readUInt8(9);
    const channels = COLOUR_TYPE_CHANNELS[colourType];
    if (channels === undefined) {
      throw new Error(`Unsupported PNG colour type ${colourType}`);
    }
    return {
      width: d.readUInt32BE(0),
      height: d.readUInt32BE(4),
      depth: d.readUInt8(8),
      colourType,
      channels,
      interlaced: d.readUInt8(12) === 1,
    };
  }
  throw new Error('PNG has no IHDR chunk');
}

export async function readPngHeader(path) {
  // IHDR is always the first chunk, so the first 64 bytes are plenty; but
  // reading the file whole keeps this simple and these are small files.
  return readHeader(await readFile(path));
}

/**
 * Remove the named chunks. Returns `{ buffer, removed }` so callers can report
 * what was actually dropped rather than assuming.
 */
export function stripChunks(buffer, types = COLOUR_CHUNKS) {
  const keep = [buffer.subarray(0, 8)];
  const removed = [];
  for (const chunk of chunks(buffer)) {
    if (types.has(chunk.type)) {
      removed.push(chunk.type);
      continue;
    }
    keep.push(buffer.subarray(chunk.start, chunk.end));
  }
  return { buffer: Buffer.concat(keep), removed };
}

/** Strip colour chunks from `path` in place. Returns the chunk types removed. */
export async function stripColourChunks(path) {
  const { buffer, removed } = stripChunks(await readFile(path));
  if (removed.length > 0) await writeFile(path, buffer);
  return removed;
}
