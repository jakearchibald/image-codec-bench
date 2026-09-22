// AVIF via avifenc/avifdec.
//
// Two plan findings live here:
//  - finding 1: avifdec writes a cICP chunk that libjxl's PNG reader rejects,
//    so `fixDecoded` strips colour chunks. Isolated to this file by design.
//  - finding 2: decode at the reference depth (`-d 8`), never wider. Decoding
//    10-bit AVIF back to 8-bit is also what a browser does for an 8-bit
//    display pipeline.

import { stripColourChunks } from '../png.js';

export const name = 'avif';
export const extension = 'avif';
export const label = 'AVIF (aom)';

/** Quality/effort axes for AVIF. `speed` is avifenc's `-s`: 0 slowest. */
export const defaults = {
  quality: { min: 20, max: 90, step: 5 },
  effort: [0, 1, 2, 3, 4, 5, 6],
  depth: [8],
  yuv: '444',
  qalpha: 'match',
};

export const effortFlag = 'speed';
/** avifenc -s: 0 is slowest/best, so lower effort number = more work. */
export const effortLabel = (value) => `s${value}`;

export function buildEncodeArgs({
  input,
  output,
  quality,
  effort,
  depth = 8,
  yuv = '444',
  qalpha = 'match',
  threads = 'multi',
  lossless = false,
}) {
  const args = [input, output, '--ignore-exif', '--ignore-xmp'];

  if (lossless) {
    args.push('--lossless');
  } else {
    args.push('-q', String(quality));
    // Alpha quality tracks -q by default (plan.md §11). avifenc's own default
    // is 100 for alpha, which would spend bits unevenly versus colour.
    const alphaQuality = qalpha === 'match' ? quality : Number(qalpha);
    args.push('--qalpha', String(alphaQuality));
    args.push('-y', yuv);
    args.push('-d', String(depth));
  }

  args.push('-s', String(effort));
  // Finding 3: -j 1 pins single-threaded encoding. avifenc only *warns* about
  // unknown -a keys, but -j is a real flag so this is safe.
  args.push('-j', threads === 'single' ? '1' : 'all');
  return args;
}

export function buildDecodeArgs({ input, output, referenceDepth = 8 }) {
  // Finding 2: pin the decode to the reference depth. Decoding wider scores
  // *higher* but that gain is a depth-mismatch artefact, not fidelity.
  return ['-d', String(referenceDepth), input, output];
}

export const encoder = 'avifenc';
export const decoder = 'avifdec';

/**
 * Post-process the decoded PNG so ssimulacra2 can read it (finding 1).
 * Returns the chunk types removed, for the record.
 */
export async function fixDecoded(path) {
  return stripColourChunks(path);
}

/** Lossless config for the §7 table: max effort. */
export function losslessConfig() {
  return { effort: 0, lossless: true, label: 'avifenc --lossless -s 0' };
}

/** AVIF caps at 12-bit; nothing else to guard for our 8-bit references. */
export function checkSupport({ width, height }) {
  return { supported: true, warnings: [] };
}
