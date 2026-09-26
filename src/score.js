// Phase 2: decode + score. Runs in parallel across cores (plan.md §3).
//
// Each decoded PNG is deleted immediately after scoring: decoded PNGs of a 2MP
// image are several MB each, so a 500-job grid would run to gigabytes. Nothing
// needs retaining -- the report links the encoded bitstreams directly.

import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { run } from './exec.js';
import { PRIMARIES_BY_CICP, assertHdrImage, readCicp } from './hdr.js';
import { readHeader } from './png.js';

/** Parse the float ssimulacra2 prints on stdout. */
export function parseScore(stdout) {
  const text = stdout.trim();
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    throw new Error(`Could not parse SSIMULACRA2 score from output: ${JSON.stringify(text)}`);
  }
  return Number.parseFloat(match[0]);
}

/**
 * Decode a bitstream and score it against the reference.
 *
 * Asserts the decoded image matches the reference's depth and channel count
 * before scoring -- a mismatch costs a flat ~1.66 points (finding 2) and would
 * quietly shift every number in the run.
 */
export async function decodeAndScore({
  codec,
  bitstream,
  reference,
  referenceHeader,
  workDir,
  keepDecoded = false,
  hdr = null,
}) {
  if (hdr) {
    return decodeAndScoreHdr({ codec, bitstream, reference, referenceHeader, workDir, keepDecoded, hdr });
  }

  const decodedPath = path.join(
    workDir,
    `${path.basename(bitstream, path.extname(bitstream))}.decoded.png`,
  );

  try {
    const decodeArgs = codec.buildDecodeArgs({
      input: bitstream,
      output: decodedPath,
      referenceDepth: referenceHeader.depth,
    });
    const decode = await run(codec.decoder, decodeArgs);

    // One read, three uses: codec-specific fixups (AVIF's cICP strip, finding
    // 1), the header assertion, and the write-back. Decoded PNGs run to
    // several MB each and scoring is the parallel phase, so re-reading the
    // same file for each step was the hottest avoidable I/O in the run.
    const raw = await readFile(decodedPath);
    const { buffer: fixed, removed: strippedChunks } = codec.fixDecoded(raw);
    if (strippedChunks.length > 0) await writeFile(decodedPath, fixed);

    const decodedHeader = readHeader(fixed);
    assertComparable(referenceHeader, decodedHeader, codec.name);

    const { stdout, ms } = await run('ssimulacra2', [reference, decodedPath]);
    const score = parseScore(stdout);

    return {
      score,
      decodeMs: decode.ms,
      scoreMs: ms,
      strippedChunks,
      decodedDepth: decodedHeader.depth,
      decodedChannels: decodedHeader.channels,
      decodedPath: keepDecoded ? decodedPath : null,
    };
  } finally {
    if (!keepDecoded) await rm(decodedPath, { force: true });
  }
}

/**
 * HDR mode: render the bitstream as 16-bit PQ and score it with fast-ssim2's
 * PU21 SSIMULACRA2 (tools/hdr-ssim2). No chunk stripping here -- the cICP chunk
 * is what proves the decode came out as PQ in the right primaries.
 */
async function decodeAndScoreHdr({ codec, bitstream, reference, referenceHeader, workDir, keepDecoded, hdr }) {
  const decodedPath = path.join(
    workDir,
    `${path.basename(bitstream, path.extname(bitstream))}.decoded.png`,
  );

  try {
    const { command, args } = codec.hdrDecode({ input: bitstream, output: decodedPath, hdr });
    const decode = await run(command, args);

    const raw = await readFile(decodedPath);
    const decodedHeader = readHeader(raw);
    assertComparable(referenceHeader, decodedHeader, codec.name);
    assertHdrImage({ header: decodedHeader, cicp: readCicp(raw), hdr, what: `${codec.name} decode` });

    const { stdout, ms } = await run('hdr-ssim2', [
      reference, decodedPath,
      '--primaries', PRIMARIES_BY_CICP.get(hdr.primaries),
    ]);

    return {
      score: parseScore(stdout),
      decodeMs: decode.ms,
      scoreMs: ms,
      strippedChunks: [],
      decodedDepth: decodedHeader.depth,
      decodedChannels: decodedHeader.channels,
      decodedPath: keepDecoded ? decodedPath : null,
    };
  } finally {
    if (!keepDecoded) await rm(decodedPath, { force: true });
  }
}

/**
 * The decoded image must match the reference in depth and geometry, or the
 * score is not a fidelity measurement (finding 2).
 */
export function assertComparable(reference, decoded, codecName) {
  if (decoded.depth !== reference.depth) {
    throw new Error(
      `${codecName}: decoded at ${decoded.depth}-bit but reference is ${reference.depth}-bit. ` +
        'A depth mismatch costs a flat ~1.66 SSIMULACRA2 points regardless of codec ' +
        '(plan.md §2 finding 2), so this would corrupt every score in the run.',
    );
  }
  if (decoded.width !== reference.width || decoded.height !== reference.height) {
    throw new Error(
      `${codecName}: decoded ${decoded.width}x${decoded.height} but reference is ` +
        `${reference.width}x${reference.height}.`,
    );
  }
  if (decoded.channels !== reference.channels) {
    // An *opaque* alpha channel costs nothing (finding 5), so this is a
    // warning-level fact rather than fatal -- but a silent channel change
    // means the codec dropped or invented alpha, which we do want to catch.
    throw new Error(
      `${codecName}: decoded ${decoded.channels} channel(s) but reference has ` +
        `${reference.channels}. Alpha was added or dropped in the round-trip.`,
    );
  }
}

/**
 * Self-check from finding 2: with depths matched, a lossless round-trip must
 * score exactly 100.00. Any drift means the depth-matching regressed.
 */
export const LOSSLESS_SCORE_EPSILON = 1e-6;

export function assertLosslessScore(score, configLabel) {
  if (Math.abs(score - 100) > LOSSLESS_SCORE_EPSILON) {
    throw new Error(
      `${configLabel}: lossless round-trip scored ${score.toFixed(8)}, expected exactly 100.00. ` +
        'This is the depth-match self-check (plan.md §2 finding 2) -- a value near 98.335 ' +
        'means the decode widened the bit depth.',
    );
  }
}

/**
 * Run `tasks` with at most `concurrency` in flight. Used for the scoring phase,
 * which is safe to parallelise because nothing is being timed.
 */
export async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Bytes on disk, for size/bpp columns. */
export async function fileSize(filePath) {
  const info = await stat(filePath);
  return info.size;
}
