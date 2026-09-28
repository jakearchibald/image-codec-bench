// AVIF via avifenc/avifdec.
//
// Two plan findings live here:
//  - finding 1: avifdec writes a cICP chunk that libjxl's PNG reader rejects,
//    so `fixDecoded` strips colour chunks. Isolated to this file by design.
//  - finding 2: decode at the reference depth (`-d 8`), never wider. Decoding
//    10-bit AVIF back to 8-bit is also what a browser does for an 8-bit
//    display pipeline.

import { tonemapArgs } from '../hdr.js';
import { stripChunks } from '../png.js';

export const name = 'avif';
export const extension = 'avif';
export const label = 'AVIF (aom)';

/** Quality/effort axes for AVIF. `speed` is avifenc's `-s`: 0 slowest. */
export const defaults = {
  quality: { min: 20, max: 90, step: 5 },
  effort: [0, 1, 2, 3, 4, 5, 6],
  depth: [8],
  yuv: ['444'],
  qalpha: 'match',
};

/**
 * AVIF has a real coded bit depth: `avifenc -d 8|10|12` changes what the
 * encoder quantises, and 10-bit 4:4:4 usually scores better than 8-bit at the
 * same -q by avoiding 8-bit quantisation. It is therefore a swept axis.
 */
export const hasDepthAxis = true;

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
  hdr = null,
  hdrMode = null,
}) {
  if (hdr && hdrMode === 'pq') return buildPqArgs({ input, output, quality, effort, depth, yuv, threads, hdr });
  if (hdr) {
    return buildGainMapArgs({
      input, output, quality, effort, depth, yuv, threads, hdr, hdrBase: hdrMode === 'gainmap-hdr',
    });
  }

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

/**
 * HDR mode: `avifgainmaputil combine` builds the gain-map AVIF from both PNGs.
 * By default the SDR one is the base, with a gain map computed so applying it
 * in full reproduces the HDR one. With `hdrBase` (--avif-hdr gainmap-hdr) it
 * runs the other way: the HDR PNG is the base, as PQ, and the gain map maps
 * down to the SDR one -- the direction JXL's jhgm is meant for. `-d`/`-y`
 * apply to the base; the gain map is libavif's default 8-bit 4:4:4, full size.
 */
function buildGainMapArgs({ input, output, quality, effort, depth, yuv, threads, hdr, hdrBase = false }) {
  const { sdr } = hdr;
  const sdrCicp = `${sdr.primaries}/${sdr.transfer}/6`;
  // An HDR base is YUV-coded PQ: BT.2020 NCL matrix for BT.2020, as HDR10.
  const hdrCicp = `${hdr.primaries}/${hdr.transfer}/${hdrBase ? (hdr.primaries === 9 ? 9 : 6) : 0}`;
  return [
    'combine',
    ...(hdrBase ? [input.hdr, input.sdr] : [input.sdr, input.hdr]),
    output,
    // The gain map defaults to q60 whatever -q is, so it tracks -q.
    '-q', String(quality), '--qgain-map', String(quality),
    '-y', yuv, '-d', String(depth),
    '-s', String(effort),
    '-j', threads === 'single' ? '1' : 'all',
    // combine wants colour as CICP. --ignore-profile is needed for the SDR
    // PNG's ICC, but it also drops the HDR PNG's cICP chunk -- without
    // --cicp-alternate both images read as SDR and the headroom comes out 0.
    // Matrix 6 is what libavif uses for YUV anyway; --cicp takes all three.
    '--ignore-profile',
    '--cicp-base', hdrBase ? hdrCicp : sdrCicp,
    '--cicp-alternate', hdrBase ? `${sdr.primaries}/${sdr.transfer}/0` : hdrCicp,
    '--ignore-exif', '--ignore-xmp',
  ];
}

/**
 * HDR mode, `--avif-hdr pq`: the HDR PNG encoded directly as PQ, the same
 * input JXL gets. Colour goes in as CICP (the reference PNG carries only a
 * cICP chunk); the matrix is BT.2020 NCL for BT.2020 content, as HDR10 does,
 * and BT.601 otherwise, as elsewhere in this file.
 */
function buildPqArgs({ input, output, quality, effort, depth, yuv, threads, hdr }) {
  const matrix = hdr.primaries === 9 ? 9 : 6;
  return [
    input.hdr, output,
    '-q', String(quality),
    '-y', yuv, '-d', String(depth),
    '-s', String(effort),
    '-j', threads === 'single' ? '1' : 'all',
    '--ignore-icc', '--cicp', `${hdr.primaries}/${hdr.transfer}/${matrix}`,
    '--ignore-exif', '--ignore-xmp',
  ];
}

export function buildDecodeArgs({ input, output, referenceDepth = 8 }) {
  // Finding 2: pin the decode to the reference depth. Decoding wider scores
  // *higher* but that gain is a depth-mismatch artefact, not fidelity.
  return ['-d', String(referenceDepth), input, output];
}

/**
 * HDR mode, gain map: render it in full, to a 16-bit PQ PNG in the HDR PNG's
 * primaries, for scoring against it. Only 12-bit precision, the tone mapper's
 * widest -- which costs AVIF points against a 16-bit reference (see the report
 * caveat in report/build.js).
 */
export function hdrDecode({ input, output, hdr, hdrMode = null }) {
  // A PQ AVIF, or a gain map on an HDR base, *is* the HDR image: a plain
  // 16-bit decode of the base (avifdec ignores gain maps), written with the
  // file's cICP. No 12-bit limit here, unlike the tone mapper.
  if (hdrMode === 'pq' || hdrMode === 'gainmap-hdr') {
    return { command: 'avifdec', args: ['-d', '16', input, output] };
  }
  return { command: 'avifgainmaputil', args: tonemapArgs({ input, output, hdr }) };
}

export const encoder = 'avifenc';
/** HDR mode builds gain-map AVIFs with combine; PQ AVIFs are plain avifenc. */
export const hdrEncoderFor = (hdrMode) => (hdrMode === 'pq' ? 'avifenc' : 'avifgainmaputil');
export const decoder = 'avifdec';

/**
 * Post-process a decoded PNG so ssimulacra2 can read it (finding 1).
 *
 * Takes and returns a buffer rather than a path: the caller needs to parse the
 * header out of the same bytes anyway, so doing the surgery in memory saves
 * re-reading a multi-megabyte PNG twice per job.
 */
export function fixDecoded(buffer) {
  return stripChunks(buffer);
}

/** Lossless config for the §7 table: max effort. */
/** One lossless point per configured `-s` level. */
export function losslessConfigs(efforts = defaults.effort) {
  return efforts.map((effort) => ({
    effort,
    effortLabel: effortLabel(effort),
    lossless: true,
    label: `avifenc --lossless -s ${effort}`,
  }));
}

/** AVIF caps at 12-bit; nothing else to guard for our 8-bit references. */
export function checkSupport({ width, height }) {
  return { supported: true, warnings: [] };
}
