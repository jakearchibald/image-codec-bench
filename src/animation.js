#!/usr/bin/env node
// Animated images: file size at equal quality, AVIF image sequence against
// animated JPEG XL, plus what each costs to encode.
//
// From a lossless video:
//  - Every frame is extracted once to 8-bit sRGB PNG, the reference. Both
//    encoders start from those pixels: cjxl gets an APNG of them, and the
//    AV1 encoder a full-range YUV conversion of them (see below).
//  - For each setting (codec x effort, plus AVIF subsampling/depth/passes),
//    quality is searched for the ColorVideoVDP score closest to each target.
//  - The chosen file is encoded once more, timed, and kept.
//
// AVIF comes from two AV1 encoders, each writing a bare AV1 stream that
// ffmpeg muxes into an AVIF image sequence with no re-encoding:
//  - aomenc (libaom, the reference encoder), because libavif only drives
//    libaom in one pass. Otherwise it matches what avifenc does for a
//    sequence: good-quality usage, end-usage=q, tune=ssim, cpu-used =
//    avifenc -s, and libaom's defaults for lookahead and keyframes.
//  - SvtAv1EncApp (SVT-AV1, the production video encoder): CRF, which it
//    only does in one pass (multi-pass is VBR only), with keyframes left to
//    the encoder like libaom rather than its default of one every ~5 seconds.
// Both get the same full-range YUV and declare the same CICP (BT.709
// primaries, sRGB transfer, BT.601 matrix, full range), as avifenc would.
//
// The metric is ColorVideoVDP because it is a video metric: it models
// temporal sensitivity, so flicker and frame-to-frame instability count, and
// those are where the two formats differ most. AV1 predicts frames from each
// other; libjxl codes every frame on its own. A per-frame metric can't see the
// difference between a steady error and one that changes every frame.
// SSIMULACRA2 per frame (mean and worst) is reported alongside, for
// comparison with the still-image runs, but nothing is chosen by it.

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { jxl } from './codecs/index.js';
import { parseYuvModes } from './config.js';
import { INSTALL_HINT, parseJod, prepareCvvdp, probeCvvdp } from './cvvdp.js';
import { canMeasureMemory, measureSpawnOverhead, run } from './exec.js';
import { stripChunks } from './png.js';
import { parseRange } from './schedule.js';
import { fileSize, mapConcurrent, parseScore } from './score.js';
import { viewerHtml } from './animation-viewer.js';
import { searchQuality } from './search.js';

const OPTIONS = {
  target: { type: 'string', short: 't', default: '9.5' },
  'avif-speed': { type: 'string', default: '6,0' },
  'avif-yuv': { type: 'string', default: '420' },
  'avif-depth': { type: 'string', default: '8,10' },
  'avif-passes': { type: 'string', default: '2' },
  'avif-keyframe': { type: 'string', default: '0' },
  'avif-encoder': { type: 'string', default: 'aom,svt' },
  'svt-preset': { type: 'string', default: '8,0' },
  'svt-tune': { type: 'string', default: '0' },
  'svt-variant': { type: 'string', multiple: true },
  'aom-variant': { type: 'string', multiple: true },
  'jxl-effort': { type: 'string', default: '7,10' },
  'jxl-step': { type: 'string', default: '0.1' },
  tolerance: { type: 'string', default: '0' },
  ppd: { type: 'string' },
  'view-width': { type: 'string' },
  threads: { type: 'string', default: 'single' },
  'no-timing': { type: 'boolean' },
  'no-ssimulacra2': { type: 'boolean' },
  out: { type: 'string', default: 'out' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const HELP = `image-codec-bench animation -- animated AVIF against animated JPEG XL:
file size at equal ColorVideoVDP score, and encode time.

The input is a lossless video (anything ffmpeg reads). Every frame becomes the
8-bit sRGB reference. AVIF is encoded by aomenc and/or SVT-AV1, then muxed
without re-encoding. For each setting, quality is searched for the
ColorVideoVDP score closest to each target; that file is encoded once more,
timed, and kept. Settings are compared at the target itself, interpolating
size between the two quality steps either side of it.

Usage:
  node src/animation.js <video> [options]

Options:
  -t, --target LIST       ColorVideoVDP targets in JOD, e.g. 9,9.5 (default
                          9.5; 10 = no visible difference)
  --avif-encoder LIST     aom, svt (default aom,svt)
  --avif-speed RANGE      aomenc --cpu-used 0..6, one setting each (default
                          6,0: avifenc's default -s and its slowest)
  --svt-preset RANGE      SVT-AV1 --preset 0..13, one setting each (default
                          8,0: its default and its slowest non-debug preset)
  --svt-tune LIST         SVT-AV1 --tune, one setting each: 0 VQ, 1 PSNR,
                          2 SSIM (default 0)
  --svt-variant NAME=ARGS, --aom-variant NAME=ARGS
                          extra encoder arguments as a setting of their own,
                          e.g. --svt-variant "notf=--enable-tf 0"; repeat for
                          more. Without any, each encoder runs once as is;
                          with some, add "default=" to keep the plain run too
  --avif-yuv LIST         420, 422 or 444, one setting each (default 420;
                          SVT-AV1 only does 420)
  --avif-depth LIST       8, 10 or 12, one setting each (default 8,10;
                          SVT-AV1 only does 8 and 10)
  --avif-passes LIST      aomenc passes, 1 or 2, one setting each (default 2;
                          SVT-AV1 is always one-pass CRF)
  --avif-keyframe N       max keyframe interval (default 0: the encoder
                          decides, as avifenc does)
  --jxl-effort RANGE      cjxl -e, one setting each (default 7,10: cjxl's
                          default and its slowest lossy), or none
  --jxl-step N            cjxl -q search precision (default 0.1; aomenc
                          --cq-level in whole steps, SVT-AV1 --crf in 0.25s)
  --ppd N                 video pixels per degree of visual angle, for
                          ColorVideoVDP (default: its standard_4k display,
                          75.4). See README for working it out from how the
                          video is displayed.
  --view-width N          CSS px width the viewer page shows the video at
                          (default: one video pixel per device pixel; it can
                          be changed on the page too)
  --tolerance JOD         take the first quality within this of each target
                          (default 0: the closest quality step), for quick
                          looks
  --threads MODE          single or multi, for the timed encode (default
                          single; the search always encodes multi-threaded)
  --no-timing             skip the timed encode; keep the search's file
  --no-ssimulacra2        skip per-frame SSIMULACRA2
  --out DIR               output root (default out)
  --quiet                 only print the results table
  -h, --help              this text

Needs aomenc, SvtAv1EncApp, ffmpeg/ffprobe and ColorVideoVDP (${INSTALL_HINT.split('\n')[0].toLowerCase().replace(/:$/, '')}; see README).

Example:
  node src/animation.js inputs/clip.mkv -t 9,9.5
`;

function int(value, flag, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} must be an integer ${min}..${max}`);
  return n;
}

/** A range (`a-b`, `min:max:step` or a comma list) of integers, deduped, in the order given. */
function intList(value, flag, min, max) {
  const values = [...new Set(parseRange(value, { integer: true }))];
  for (const n of values) int(n, flag, min, max);
  return values;
}

/**
 * `NAME=ARGS` -> { name, args }, args split on whitespace (no quoting: these
 * are encoder flags). None given is one unnamed variant with no extra args.
 */
function parseVariants(specs, flag) {
  if (!specs?.length) return [{ name: null, args: [] }];
  const variants = specs.map((spec) => {
    const match = spec.match(/^([\w.-]+)=(.*)$/s);
    if (!match) throw new Error(`${flag} takes NAME=ARGS (got ${JSON.stringify(spec)})`);
    return { name: match[1], args: match[2].trim().split(/\s+/).filter(Boolean) };
  });
  const names = variants.map((v) => v.name);
  if (new Set(names).size !== names.length) throw new Error(`${flag} names must be unique`);
  return variants;
}

function resolveConfig(values, positionals) {
  if (positionals.length !== 1) throw new Error('Give exactly one input video.');
  const targets = [...new Set(parseRange(values.target))].sort((a, b) => a - b);
  for (const t of targets) {
    if (!(t > 0 && t < 10)) throw new Error('--target values must be JODs between 0 and 10 (10 is unreachable)');
  }
  const config = {
    input: path.resolve(positionals[0]),
    targets,
    // Good-quality mode only goes to 6; avifenc switches to realtime above it.
    avifSpeeds: intList(values['avif-speed'], '--avif-speed', 0, 6),
    avifYuv: parseYuvModes(values['avif-yuv']),
    avifDepths: intList(values['avif-depth'], '--avif-depth', 8, 12),
    avifPasses: intList(values['avif-passes'], '--avif-passes', 1, 2),
    avifKeyframe: int(values['avif-keyframe'], '--avif-keyframe', 0, 100000),
    avifEncoders: [...new Set(values['avif-encoder'].split(',').map((e) => e.trim()).filter(Boolean))],
    svtPresets: intList(values['svt-preset'], '--svt-preset', 0, 13),
    // 3 (IQ) and 4 (MS-SSIM/SSIMULACRA2) are tuned for stills, and 5 tunes
    // for VMAF, a metric rather than viewers.
    svtTunes: intList(values['svt-tune'], '--svt-tune', 0, 2),
    svtVariants: parseVariants(values['svt-variant'], '--svt-variant'),
    aomVariants: parseVariants(values['aom-variant'], '--aom-variant'),
    jxlEfforts: values['jxl-effort'] === 'none' ? [] : intList(values['jxl-effort'], '--jxl-effort', 1, 10),
    jxlStep: Number(values['jxl-step']),
    tolerance: Number(values.tolerance),
    ppd: values.ppd == null ? null : Number(values.ppd),
    viewWidth: values['view-width'] == null ? null : Number(values['view-width']),
    threads: values.threads,
    timing: values['no-timing'] !== true,
    ssimulacra2: values['no-ssimulacra2'] !== true,
    out: path.resolve(values.out),
    quiet: values.quiet === true,
  };
  for (const d of config.avifDepths) {
    if (![8, 10, 12].includes(d)) throw new Error('--avif-depth must be 8, 10 or 12');
  }
  if (config.avifYuv.includes('400')) throw new Error('--avif-yuv 400 is not supported');
  for (const e of config.avifEncoders) {
    if (!['aom', 'svt'].includes(e)) throw new Error(`--avif-encoder takes aom, svt (got ${e})`);
  }
  if (!(config.jxlStep > 0 && config.jxlStep <= 10)) throw new Error('--jxl-step must be in (0, 10]');
  if (!(config.tolerance >= 0 && config.tolerance < 10)) throw new Error('--tolerance must be a JOD difference, 0 or more');
  if (config.ppd != null && !(config.ppd > 0 && config.ppd < 1000)) throw new Error('--ppd must be a positive number');
  if (config.viewWidth != null && !(config.viewWidth > 0)) throw new Error('--view-width must be a positive number');
  if (!['single', 'multi'].includes(config.threads)) throw new Error('--threads takes single or multi');
  return config;
}

async function toolchain() {
  const line = async (cmd, args) => (await run(cmd, args, { allowFailure: true })).stdout.split('\n')[0].trim();
  return {
    aomenc: (await run('aomenc', ['--help'], { allowFailure: true })).stdout.match(/AV1 Encoder (\S+)/)?.[1] ?? null,
    svtav1: (await line('SvtAv1EncApp', ['--version'])).match(/v(\S+)/)?.[1] ?? null,
    avifdec: await line('avifdec', ['--version']),
    cjxl: (await line('cjxl', ['--version'])).match(/v?(\d+\.\d+\.\d+)/)?.[1] ?? null,
    ffmpeg: (await line('ffmpeg', ['-version'])).match(/version (\S+)/)?.[1] ?? null,
    cvvdp: null,
  };
}

/** `30000/1001` -> { num, den, fps }. */
function parseRate(text) {
  const [num, den = 1] = text.split('/').map(Number);
  if (!(num > 0 && den > 0)) throw new Error(`Can't read the frame rate '${text}'`);
  return { num, den, fps: num / den, text: `${num}/${den}` };
}

async function probeVideo(input) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', input,
  ]);
  const stream = JSON.parse(stdout).streams?.[0];
  if (!stream) throw new Error(`No video stream in ${input}`);
  if (['smpte2084', 'arib-std-b67'].includes(stream.color_transfer)) {
    throw new Error(`The video is HDR (${stream.color_transfer}); only SDR is supported`);
  }
  return {
    codec: stream.codec_name,
    width: stream.width,
    height: stream.height,
    pixFmt: stream.pix_fmt,
    colourSpace: stream.color_space ?? null,
    colourRange: stream.color_range ?? null,
    rate: parseRate(stream.r_frame_rate),
  };
}

// Codecs Safari plays, so the viewer can show the input itself as the original.
const PLAYABLE = new Set(['prores', 'h264', 'hevc', 'av1', 'vp9']);

/**
 * A copy of the reference the viewer can play, for inputs browsers can't
 * (FFV1, say): ProRes 4444 XQ, 10-bit 4:4:4, which is visually lossless and
 * plays in Safari. Tagged with the sRGB transfer like the AVIFs, so Safari
 * renders both the same way rather than treating it as BT.709 camera video.
 */
async function writePlayableOriginal({ reference, output }) {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', reference.rate.text, '-i', path.join(reference.frameDir, '%06d.png'),
    '-vf', 'scale=out_color_matrix=bt709:out_range=limited:flags=accurate_rnd+full_chroma_int,format=yuv444p10le',
    '-c:v', 'prores_ks', '-profile:v', '5',
    '-color_range', 'tv', '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-colorspace', 'bt709',
    output,
  ]);
}

/**
 * Every frame as an 8-bit sRGB PNG with no colour chunks, like the stills'
 * reference. YUV is converted with the stream's own matrix and range; an
 * untagged stream is taken as BT.709 limited range, since swscale's default
 * for untagged input is BT.601, which would shift every colour.
 */
async function extractFrames({ input, video, dir, log }) {
  const isRgb = /^(gbr|rgb|bgr|argb|abgr|rgba|bgra|0rgb|rgb0|0bgr|bgr0)/.test(video.pixFmt);
  if (/^(yuva|gbrap|argb|abgr|rgba|bgra|ya)/.test(video.pixFmt)) throw new Error(`The video has alpha (${video.pixFmt}); only opaque video is supported`);
  const notes = [];
  let filter = 'format=rgb24';
  if (!isRgb) {
    const matrix = video.colourSpace && video.colourSpace !== 'unknown' ? video.colourSpace : 'bt709';
    const range = video.colourRange === 'pc' ? 'full' : 'limited';
    if (matrix !== video.colourSpace) notes.push('untagged YUV matrix: assumed BT.709');
    if (!video.colourRange || video.colourRange === 'unknown') notes.push('untagged YUV range: assumed limited');
    filter = `scale=in_color_matrix=${matrix}:in_range=${range}:flags=accurate_rnd+full_chroma_int,${filter}`;
  }
  if (/p(9|1[0-6])/.test(video.pixFmt) || /(48|64)/.test(video.pixFmt)) {
    notes.push(`${video.pixFmt} source reduced to 8-bit RGB`);
  }
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', input, '-map', '0:v:0',
    '-vf', filter, '-fps_mode', 'passthrough', '-an', '-sn',
    path.join(dir, '%06d.png'),
  ]);
  const frames = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort().map((f) => path.join(dir, f));
  for (const frame of frames) {
    const stripped = stripChunks(await readFile(frame));
    if (stripped.removed.length > 0) await writeFile(frame, stripped.buffer);
  }
  for (const note of notes) log(`  note: ${note}`);
  return { frames, notes };
}

/** PNG frames -> lossless RGB video, the form ColorVideoVDP reads. */
async function framesToVideo({ pattern, rate, output, startNumber = 1 }) {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', rate.text, '-start_number', String(startNumber), '-i', pattern,
    '-c:v', 'ffv1', '-pix_fmt', 'gbrp', output,
  ]);
}

/**
 * The reference frames as full-range YUV Y4M, one per subsampling and depth,
 * for aomenc. Converted with avifenc's default matrix for RGB input (BT.601),
 * chroma sited at the centre, as libavif's own conversion averages. aomenc
 * takes full range from the Y4M's XCOLORRANGE=FULL; it has no flag for it.
 * Made once, before any timing: the encode times are aomenc's alone.
 */
async function prepareY4m({ reference, yuv, depth, dir }) {
  const output = path.join(dir, `reference-${yuv}-d${depth}.y4m`);
  const format = `yuv${yuv}p${depth === 8 ? '' : `${depth}le`}`;
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', reference.rate.text, '-i', path.join(reference.frameDir, '%06d.png'),
    '-vf',
    `scale=out_color_matrix=bt601:out_range=full:out_chroma_loc=center:flags=accurate_rnd+full_chroma_int,format=${format}`,
    '-color_range', 'pc', '-strict', '-1', output,
  ]);
  return output;
}

// The CICP the AVIF declares, in the AV1 sequence header and the container.
// The matrix is 6 (BT.601), as avifenc writes for RGB input. aomenc takes
// the range from the Y4M; SVT-AV1 needs telling.
const AOM_COLOUR = ['--color-primaries=bt709', '--transfer-characteristics=srgb', '--matrix-coefficients=bt601'];
const SVT_COLOUR = [
  '--color-range', '1', '--color-primaries', '1', '--transfer-characteristics', '13', '--matrix-coefficients', '6',
];
const MUX_COLOUR = [
  '-color_range', 'pc', '-color_primaries', 'bt709', '-color_trc', 'iec61966-2-1', '-colorspace', 'smpte170m',
];

const MUX_ARGS = (ivf, output) => [
  '-hide_banner', '-loglevel', 'error', '-y', '-i', ivf, '-c', 'copy', ...MUX_COLOUR, '-f', 'avif', output,
];
// The same stream as a video, for comparison with serving AV1 in <video>.
const MP4_ARGS = (ivf, output) => [
  '-hide_banner', '-loglevel', 'error', '-y', '-i', ivf, '-c', 'copy', ...MUX_COLOUR,
  '-movflags', '+faststart', '-f', 'mp4', output,
];

/**
 * An AVIF setting: `args(threads, ivf, q)` runs the AV1 encoder to a bare
 * stream, which is then muxed, and also into `mp4` if given. Only the
 * encoder is timed.
 */
function av1Setting({ id, command, args, workDir, ...rest }) {
  return {
    id, codec: 'avif', extension: 'avif', command, ...rest,
    async encode(threads, output, q, { measureMemory = false, mp4 = null } = {}) {
      const ivf = path.join(workDir, `${id}.ivf`);
      try {
        const { ms, peakBytes } = await run(command, args(threads, ivf, q), { measureMemory });
        await run('ffmpeg', MUX_ARGS(ivf, output));
        if (mp4) await run('ffmpeg', MP4_ARGS(ivf, mp4));
        return {
          ms,
          peakBytes,
          argv: [
            [command, ...args(threads, ivf, q)],
            ['ffmpeg', ...MUX_ARGS(ivf, output)],
            ...(mp4 ? [['ffmpeg', ...MP4_ARGS(ivf, mp4)]] : []),
          ],
        };
      } finally {
        await rm(ivf, { force: true });
        await rm(`${ivf}.stats`, { force: true });
      }
    },
  };
}

const SVT_TUNES = ['VQ', 'PSNR', 'SSIM'];

/**
 * The settings. Each has `param(q)` for display, and `encode(threads, output,
 * q)`, which resolves to the timing of the encoder alone and every command it
 * ran. The searched value has to rise with quality, so for AVIF it is the
 * encoder's quantiser scale upside down: 63 - cq-level for aomenc, 70 - crf
 * for SVT-AV1.
 */
function settings({ config, reference, y4m, workDir, log }) {
  const list = [];
  const cpus = Math.min(os.cpus().length, 64);
  const aom = config.avifEncoders.includes('aom');
  const svt = config.avifEncoders.includes('svt');
  for (const yuv of config.avifYuv) {
    for (const depth of config.avifDepths) {
      const input = y4m.get(`${yuv}-d${depth}`);
      for (const speed of aom ? config.avifSpeeds : []) {
        for (const [passes, variant] of config.avifPasses.flatMap((p) => config.aomVariants.map((v) => [p, v]))) {
          // Profile 0 is 4:2:0 at 8/10-bit, 1 is 4:4:4, and 2 takes 4:2:2 and 12-bit.
          const profile = depth === 12 || yuv === '422' ? 2 : yuv === '444' ? 1 : 0;
          list.push(av1Setting({
            id: `avif-aom-s${speed}-${yuv}-d${depth}-p${passes}${variant.name ? `-${variant.name}` : ''}`,
            label: `AVIF aom s${speed} ${yuv} ${depth}-bit ${passes}-pass${variant.name ? ` ${variant.name}` : ''}`,
            encoder: 'aom', effort: speed, yuv, depth, passes, workDir,
            ...(variant.name ? { variant: variant.name, extraArgs: variant.args } : {}),
            command: 'aomenc',
            grid: { min: 0, max: 63, step: 1 },
            seed: 30,
            param: (q) => `cq ${63 - q}`,
            fileParam: (q) => `cq${63 - q}`,
            args: (threads, ivf, q) => [
              '--quiet', '--good',
              `--passes=${passes}`, ...(passes === 2 ? [`--fpf=${ivf}.stats`] : []),
              `--cpu-used=${speed}`, '--end-usage=q', `--cq-level=${63 - q}`, '--tune=ssim',
              `--profile=${profile}`, `--bit-depth=${depth}`, `--input-bit-depth=${depth}`,
              ...(config.avifKeyframe > 0 ? [`--kf-max-dist=${config.avifKeyframe}`] : []),
              `--threads=${threads === 'single' ? 1 : cpus}`,
              ...AOM_COLOUR,
              ...variant.args,
              '--ivf', '-o', ivf, input,
            ],
          }));
        }
      }
      if (svt && (yuv !== '420' || depth === 12)) {
        log(`  note: SVT-AV1 skipped for ${yuv} ${depth}-bit (it only does 4:2:0 at 8 and 10-bit)`);
        continue;
      }
      for (const preset of svt ? config.svtPresets : []) {
        for (const [tune, variant] of config.svtTunes.flatMap((t) => config.svtVariants.map((v) => [t, v]))) {
          list.push(av1Setting({
            id: `avif-svt-p${preset}-${yuv}-d${depth}-t${tune}${variant.name ? `-${variant.name}` : ''}`,
            label: `AVIF svt p${preset} ${yuv} ${depth}-bit ${SVT_TUNES[tune]}${variant.name ? ` ${variant.name}` : ''}`,
            encoder: 'svt', effort: preset, yuv, depth, passes: 1, tune: SVT_TUNES[tune], workDir,
            ...(variant.name ? { variant: variant.name, extraArgs: variant.args } : {}),
            command: 'SvtAv1EncApp',
            grid: { min: 0, max: 69, step: 0.25 },
            seed: 35,
            param: (q) => `crf ${70 - q}`,
            fileParam: (q) => `crf${70 - q}`,
            args: (threads, ivf, q) => [
              '--progress', '0',
              '-i', input, '-b', ivf,
              '--preset', String(preset), '--rc', '0', '--crf', String(70 - q), '--tune', String(tune),
              '--input-depth', String(depth),
              // "Infinite": keyframes only where the encoder decides, as with libaom.
              '--keyint', String(config.avifKeyframe > 0 ? config.avifKeyframe : -1),
              // --lp is a parallelism level, not a thread count; 1 runs on one core.
              '--lp', threads === 'single' ? '1' : '0',
              ...SVT_COLOUR,
              ...variant.args,
            ],
          }));
        }
      }
    }
  }
  for (const effort of config.jxlEfforts) {
    const args = (threads, output, q) => [
      ...jxl.buildEncodeArgs({ input: reference.apng, output, quality: q, effort, threads }),
      '--quiet',
    ];
    list.push({
      id: `jxl-e${effort}`,
      codec: 'jxl', extension: 'jxl', effort,
      label: `JXL e${effort}`,
      seed: 75,
      grid: { min: 1, max: 100, step: config.jxlStep },
      param: (q) => `-q ${q}`,
      fileParam: (q) => `q${q}`,
      async encode(threads, output, q, { measureMemory = false } = {}) {
        const { ms, peakBytes } = await run('cjxl', args(threads, output, q), { measureMemory });
        return { ms, peakBytes, argv: [['cjxl', ...args(threads, output, q)]] };
      },
    });
  }
  return list;
}

/**
 * Decode every frame at 8-bit into `dir` as 000001.png..., stripping avifdec's
 * colour chunks (ssimulacra2 rejects its cICP). djxl writes each frame to its
 * own file with --output_frames, composited, as PPM, which avoids reading
 * APNG frame timing back.
 */
async function decodeFrames({ setting, bitstream, dir }) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  if (setting.codec === 'avif') {
    // Uncompressed: libpng's default compression is ~90% of the decode time.
    await run('avifdec', ['-d', '8', '--png-compress', '0', '--index', 'all', bitstream, path.join(dir, 'f.png')]);
  } else {
    await run('djxl', [bitstream, path.join(dir, 'f.ppm'), '--output_frames', '--bits_per_sample=8', '--quiet']);
  }
  const index = (name) => Number(name.match(/(\d+)\.(png|ppm)$/)[1]);
  const names = (await readdir(dir)).filter((f) => /\d+\.(png|ppm)$/.test(f)).sort((a, b) => index(a) - index(b));
  const ext = setting.codec === 'avif' ? 'png' : 'ppm';
  const frames = [];
  for (const [i, name] of names.entries()) {
    const frame = path.join(dir, `${String(i + 1).padStart(6, '0')}.${ext}`);
    await rename(path.join(dir, name), frame);
    if (ext === 'png') {
      const stripped = stripChunks(await readFile(frame));
      if (stripped.removed.length > 0) await writeFile(frame, stripped.buffer);
    }
    frames.push(frame);
  }
  return { frames, pattern: path.join(dir, `%06d.${ext}`) };
}

/**
 * ColorVideoVDP on two lossless RGB videos. `--ffmpeg-cc` because its default
 * GPU colour conversion only takes YUV. It exits 0 on its own errors, so a
 * missing score is the failure signal, and its stderr says why.
 */
async function cvvdpVideo({ cvvdp, test, reference, ppd }) {
  const { stdout, stderr } = await run(cvvdp.bin, [
    '--test', test, '--ref', reference,
    '--display', cvvdp.display,
    '--config-paths', ...cvvdp.configPaths,
    // Replaces the display's size and distance; luminance and lighting stay.
    ...(ppd != null ? ['--pix-per-deg', String(ppd)] : []),
    '--ffmpeg-cc', '--quiet',
  ], { allowFailure: true });
  try {
    return parseJod(stdout);
  } catch {
    throw new Error(`ColorVideoVDP failed: ${stderr.trim() || stdout.trim()}`);
  }
}

/**
 * Decode and score one bitstream: the frame count is checked against the
 * reference (cvvdp would otherwise quietly score the shorter of the two).
 * Returns the decoded frames too when `keep` is set, for SSIMULACRA2.
 */
async function measure({ setting, bitstream, reference, cvvdp, workDir, keep = false }) {
  const dir = path.join(workDir, `${setting.id}-decoded`);
  const started = performance.now();
  const decoded = await decodeFrames({ setting, bitstream, dir });
  if (decoded.frames.length !== reference.frames.length) {
    throw new Error(
      `${setting.label}: decoded ${decoded.frames.length} frames, the reference has ${reference.frames.length}`,
    );
  }
  const video = path.join(workDir, `${setting.id}-decoded.mkv`);
  await framesToVideo({ pattern: decoded.pattern, rate: reference.rate, output: video });
  if (!keep) await rm(dir, { recursive: true, force: true });
  try {
    // Encoders pad odd or unaligned sizes internally; the decode must not.
    const { width, height } = await probeVideo(video);
    if (width !== reference.width || height !== reference.height) {
      throw new Error(`${setting.label}: decoded ${width}x${height}, the reference is ${reference.width}x${reference.height}`);
    }
    const decodeMs = performance.now() - started;
    const jod = await cvvdpVideo({ cvvdp, test: video, reference: reference.video, ppd: cvvdp.ppd });
    return { jod, decoded: keep ? decoded : null, decodeMs, scoreMs: performance.now() - started - decodeMs };
  } finally {
    await rm(video, { force: true });
  }
}

/**
 * Size at exactly `target` JOD, from the two grid steps either side of it:
 * log size interpolated linearly in JOD, as BD-rate does between points. Null
 * when the target isn't bracketed.
 */
function bytesAtTarget(probes, target) {
  const sorted = [...probes].sort((a, b) => a.quality - b.quality);
  const above = sorted.find((p) => p.jod >= target);
  const below = sorted.filter((p) => p.jod < target && p.quality < (above?.quality ?? -Infinity)).at(-1);
  if (!above || !below) return null;
  if (above.jod === below.jod) return above.bytes;
  const t = (target - below.jod) / (above.jod - below.jod);
  return Math.round(Math.exp(Math.log(below.bytes) + t * (Math.log(above.bytes) - Math.log(below.bytes))));
}

/**
 * Search one setting's -q for each target. Probes are shared across targets
 * (and seeded from the previous setting of the same codec, which is usually
 * close), and every one is kept with its bytes and score.
 */
async function searchSetting({ setting, targets, seed, reference, cvvdp, workDir, log, tolerance = 0 }) {
  const probeFile = path.join(workDir, `${setting.id}-probe.${setting.extension}`);
  const probes = new Map();
  const probe = async (quality) => {
    const started = performance.now();
    const { ms: encodeMs } = await setting.encode('multi', probeFile, quality);
    const bytes = await fileSize(probeFile);
    const { jod, decodeMs, scoreMs } = await measure({ setting, bitstream: probeFile, reference, cvvdp, workDir });
    probes.set(quality, { quality, param: setting.param(quality), jod, bytes });
    const s = (ms) => `${(ms / 1000).toFixed(1)}s`;
    log(
      `  ${setting.param(quality)}: ${jod.toFixed(4)} JOD, ${formatBytes(bytes)} ` +
        `(encode ${s(encodeMs)}, decode ${s(decodeMs)}, cvvdp ${s(scoreMs)})`,
    );
    return jod;
  };
  // searchQuality wants quality -> score.
  const known = new Map();
  const scoreOf = async (quality) => {
    if (!known.has(quality)) known.set(quality, await probe(quality));
    return known.get(quality);
  };
  const { grid } = setting;
  const results = [];
  try {
    await scoreOf(seed);
    for (const target of targets) {
      const hit = await searchQuality({ ...grid, target, probe, known, tolerance });
      if (!hit) {
        results.push({ target, unreachable: true });
        log(`  ${target} JOD is out of reach even at ${setting.param(grid.max)}`);
        continue;
      }
      // The lowest -q reaching the target, and the step below, which falls
      // short but may be closer. Both are needed to interpolate anyway.
      const candidates = [hit.quality];
      const below = Math.round((hit.quality - grid.step) * 1e6) / 1e6;
      if (below >= grid.min && !tolerance) candidates.push(below);
      let best = null;
      for (const quality of candidates) {
        const jod = await scoreOf(quality);
        if (!best || Math.abs(jod - target) < Math.abs(best.jod - target)) best = probes.get(quality);
      }
      results.push({ target, quality: best.quality, param: best.param, jod: best.jod, bytes: best.bytes, bytesAtTarget: null });
    }
  } finally {
    await rm(probeFile, { force: true });
  }
  const sortedProbes = [...probes.values()].sort((a, b) => a.quality - b.quality);
  for (const r of results) {
    if (!r.unreachable) r.bytesAtTarget = bytesAtTarget(sortedProbes, r.target);
  }
  return { results, probes: sortedProbes };
}

async function ssimulacra2Frames({ reference, decoded }) {
  const scores = await mapConcurrent(reference.frames, os.cpus().length, async (frame, i) =>
    parseScore((await run('ssimulacra2', [frame, decoded.frames[i]])).stdout),
  );
  let change = 0;
  for (let i = 1; i < scores.length; i += 1) change += Math.abs(scores[i] - scores[i - 1]);
  return {
    mean: scores.reduce((a, b) => a + b, 0) / scores.length,
    min: Math.min(...scores),
    worstFrame: scores.indexOf(Math.min(...scores)),
    // Mean change from one frame to the next. ColorVideoVDP can rate a clip
    // highly while its quality pulses with the encoder's frame hierarchy
    // (sharp every 16th frame, soft between), which reads as flicker; this
    // shows it. Steady quality is near 0.
    flicker: change / (scores.length - 1),
    frames: scores.map((score) => Number(score.toFixed(2))),
  };
}

async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }
  const config = resolveConfig(values, positionals);
  const log = (message) => {
    if (!config.quiet) process.stdout.write(`${message}\n`);
  };

  const cvvdpProbe = await probeCvvdp();
  if (!cvvdpProbe.present) throw new Error(`ColorVideoVDP is needed (${cvvdpProbe.reason}).\n${INSTALL_HINT}`);
  const versions = await toolchain();
  versions.cvvdp = cvvdpProbe.version;
  log(`aomenc ${versions.aomenc}, SVT-AV1 ${versions.svtav1}, ${versions.avifdec}, cjxl ${versions.cjxl}, ffmpeg ${versions.ffmpeg}, cvvdp ${versions.cvvdp}`);

  const stem = path.basename(config.input, path.extname(config.input));
  const runDir = path.join(config.out, `${stem}-animation`);
  // Cleared so the directory holds exactly what results.json describes.
  await rm(runDir, { recursive: true, force: true });
  const workDir = path.join(runDir, 'work');
  const frameDir = path.join(workDir, 'reference');
  await mkdir(frameDir, { recursive: true });

  const video = await probeVideo(config.input);
  log(`${video.width}x${video.height} ${video.pixFmt}, ${video.rate.fps.toFixed(3)} fps`);
  const { frames, notes } = await extractFrames({ input: config.input, video, dir: frameDir, log });
  if (frames.length < 2) throw new Error(`The video has ${frames.length} frame(s); an animation needs at least 2`);
  const reference = {
    frames,
    frameDir,
    width: video.width,
    height: video.height,
    rate: video.rate,
    video: path.join(workDir, 'reference.mkv'),
    apng: path.join(workDir, 'reference.apng'),
  };
  await framesToVideo({ pattern: path.join(frameDir, '%06d.png'), rate: reference.rate, output: reference.video });
  const playableOriginal = PLAYABLE.has(video.codec) ? null : path.join(runDir, 'original.mov');
  if (playableOriginal) await writePlayableOriginal({ reference, output: playableOriginal });
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', reference.rate.text, '-i', path.join(frameDir, '%06d.png'),
    '-plays', '0', '-f', 'apng', reference.apng,
  ]);
  log(`${frames.length} frames (${(frames.length / reference.rate.fps).toFixed(2)}s)`);

  const cvvdp = { ...(await prepareCvvdp({ probe: cvvdpProbe, hdr: null, dir: workDir })), ppd: config.ppd };
  if (cvvdp.ppd != null) cvvdp.displayName += `, but at ${cvvdp.ppd} video pixels per degree`;

  const y4m = new Map();
  for (const yuv of config.avifYuv) {
    for (const depth of config.avifDepths) {
      y4m.set(`${yuv}-d${depth}`, await prepareY4m({ reference, yuv, depth, dir: workDir }));
    }
  }

  // 1. Search. Multi-threaded and untimed; nothing else runs alongside.
  const list = settings({ config, reference, y4m, workDir, log });
  // Each search starts from the previous setting of the same encoder's answer.
  const seeds = {};
  for (const setting of list) {
    log(`\nSearching ${setting.label} for ${config.targets.join(', ')} JOD...`);
    const key = setting.encoder ?? setting.codec;
    const seed = seeds[key] ?? setting.seed;
    Object.assign(setting, await searchSetting({
      setting, targets: config.targets, seed, reference, cvvdp, workDir, log, tolerance: config.tolerance,
    }));
    const first = setting.results.find((r) => !r.unreachable);
    if (first) seeds[key] = first.quality;
  }

  // 2. The kept files: one encode each, timed unless --no-timing, strictly
  // serial. Encoders aren't guaranteed to give the same bytes single- and
  // multi-threaded, so a file that differs from its search probe is rescored.
  const spawnOverhead = config.timing ? await measureSpawnOverhead() : null;
  const threads = config.timing ? config.threads : 'multi';
  log(`\nEncoding the chosen files${config.timing ? `, timed (${threads}-threaded)` : ''}...`);
  const kept = [];
  for (const setting of list) {
    for (const r of setting.results) {
      if (r.unreachable) continue;
      const file = path.join(runDir, `${setting.id}-${setting.fileParam(r.quality)}.${setting.extension}`);
      const existing = kept.find((k) => k.path === file);
      if (existing) {
        const { encode, argv, mp4 } = existing.result;
        Object.assign(r, { file: path.basename(file), encode, argv, ...(mp4 ? { mp4 } : {}) });
        continue;
      }
      const mp4 = setting.codec === 'avif' ? file.replace(/\.avif$/, '.mp4') : null;
      const { ms, peakBytes, argv } = await setting.encode(threads, file, r.quality, { measureMemory: true, mp4 });
      const bytes = await fileSize(file);
      r.file = path.basename(file);
      if (mp4) r.mp4 = { file: path.basename(mp4), bytes: await fileSize(mp4) };
      r.encode = config.timing ? { threads, ms, peakBytes: canMeasureMemory ? peakBytes : null } : null;
      r.argv = argv.map((command) => command.map((a) => a.replaceAll(`${runDir}${path.sep}`, '')));
      const what = `${setting.label} ${setting.param(r.quality)}`;
      if (bytes !== r.bytes) {
        log(`  ${what}: ${bytes} bytes ${threads}-threaded, ${r.bytes} in the search; rescoring`);
        r.bytes = bytes;
        r.jod = (await measure({ setting, bitstream: file, reference, cvvdp, workDir })).jod;
        r.rescored = true;
      }
      if (config.timing) log(`  ${what}: ${(ms / 1000).toFixed(2)}s`);
      kept.push({ path: file, setting, result: r, encode: r.encode });
    }
  }

  // 3. SSIMULACRA2 per frame, in parallel now nothing is being timed.
  if (config.ssimulacra2) {
    log('\nSSIMULACRA2 per frame...');
    for (const k of kept) {
      const dir = path.join(workDir, `${k.setting.id}-decoded`);
      const decoded = await decodeFrames({ setting: k.setting, bitstream: k.path, dir });
      k.result.ssimulacra2 = await ssimulacra2Frames({ reference, decoded });
      await rm(dir, { recursive: true, force: true });
    }
    for (const setting of list) {
      for (const r of setting.results) {
        if (!r.ssimulacra2 && r.file) r.ssimulacra2 = kept.find((k) => path.basename(k.path) === r.file)?.result.ssimulacra2;
      }
    }
  }

  await rm(workDir, { recursive: true, force: true });

  const output = {
    settings: {
      input: path.relative(process.cwd(), config.input),
      targets: config.targets,
      avif: { speeds: config.avifSpeeds, yuv: config.avifYuv, depths: config.avifDepths, passes: config.avifPasses,
        encoders: config.avifEncoders, svtPresets: config.svtPresets, svtTunes: config.svtTunes,
        svtVariants: config.svtVariants, aomVariants: config.aomVariants, keyframe: config.avifKeyframe },
      jxl: { efforts: config.jxlEfforts, step: config.jxlStep },
      timing: config.timing ? config.threads : null,
    },
    versions,
    cvvdp: { version: cvvdp.version, display: cvvdp.display, displayName: cvvdp.displayName, ppd: cvvdp.ppd },
    machine: { cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length, node: process.version },
    video: { ...video, frames: frames.length, notes },
    // A ProRes copy of the reference for the viewer, when the input won't play in a browser.
    ...(playableOriginal ? { original: path.basename(playableOriginal) } : {}),
    spawnOverhead,
    results: list.map((s) => ({
      id: s.id,
      label: s.label,
      codec: s.codec,
      // cjxl -e, aomenc --cpu-used or SVT-AV1 --preset.
      effort: s.effort,
      ...(s.codec === 'avif'
        ? {
            encoder: s.encoder, yuv: s.yuv, depth: s.depth, passes: s.passes,
            ...(s.tune ? { tune: s.tune } : {}),
            ...(s.variant ? { variant: s.variant, extraArgs: s.extraArgs } : {}),
          }
        : {}),
      // Per target: the quality chosen (closest JOD), as the encoder setting
      // in `param`, its JOD and bytes, and the interpolated bytes at exactly
      // the target, which is what to compare.
      targets: s.results,
      // Every quality tried in the search.
      probes: s.probes,
    })),
  };
  const jsonPath = path.join(runDir, 'results.json');
  await writeFile(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
  await writeFile(path.join(runDir, 'viewer.html'), viewerHtml({ runs: [{ output, dir: runDir }], pageDir: runDir, input: config.input, width: config.viewWidth }));

  process.stdout.write(`\n${formatTable(output)}\n`);
  process.stdout.write(
    `\nScores: ColorVideoVDP ${cvvdp.version}, ${cvvdp.displayName}.\n` +
      `"at target" is size interpolated to exactly the target JOD; "vs" compares that with the first row.\n` +
      (config.timing
        ? `Encode times are one ${config.threads}-threaded run and include process spawn ` +
          `(~${spawnOverhead.medianMs.toFixed(1)}ms).\n`
        : '') +
      `Results: ${jsonPath}\nTo look at them: ${path.join(runDir, 'viewer.html')} (Safari plays the original)\n`,
  );
  return 0;
}

function formatBytes(bytes) {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(2)} MB` : `${(bytes / 1e3).toFixed(1)} KB`;
}

const pct = (value, base) => `${value >= base ? '+' : ''}${(((value - base) / base) * 100).toFixed(1)}%`;

/** One block per target, a row per setting. */
function formatTable(output) {
  const timed = output.settings.timing != null;
  const header = [
    'setting', 'quality', 'JOD', 'size', 'at target', 'vs',
    'SSIMU2 mean', 'SSIMU2 min', 'flicker',
    ...(timed ? [`enc ${output.settings.timing} s`, 'peak'] : []),
  ];
  const rows = [];
  for (const target of output.settings.targets) {
    rows.push([`${target} JOD`, ...header.slice(1).map(() => '')]);
    rows.push(header);
    let base = null;
    for (const s of output.results) {
      const r = s.targets.find((t) => t.target === target);
      if (r.unreachable) {
        rows.push([s.label, 'unreachable', ...header.slice(2).map(() => '')]);
        continue;
      }
      base ??= r.bytesAtTarget;
      rows.push([
        s.label,
        r.param,
        r.jod.toFixed(3),
        formatBytes(r.bytes),
        r.bytesAtTarget == null ? '--' : formatBytes(r.bytesAtTarget),
        r.bytesAtTarget == null || base == null ? '--' : pct(r.bytesAtTarget, base),
        r.ssimulacra2 ? r.ssimulacra2.mean.toFixed(2) : '--',
        r.ssimulacra2 ? r.ssimulacra2.min.toFixed(2) : '--',
        r.ssimulacra2 ? r.ssimulacra2.flicker.toFixed(2) : '--',
        ...(timed
          ? [
              (r.encode.ms / 1000).toFixed(2),
              r.encode.peakBytes == null ? '--' : `${(r.encode.peakBytes / 1048576).toFixed(0)} MB`,
            ]
          : []),
      ]);
    }
    rows.push(header.map(() => ''));
  }
  rows.pop();
  const isTitle = (row) => row.slice(1).every((c) => c === '') && row[0] !== '';
  const widths = header.map((_, i) => Math.max(...rows.filter((r) => !isTitle(r)).map((r) => r[i].length)));
  return rows
    .map((row) =>
      isTitle(row)
        ? row[0]
        : row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ').trimEnd(),
    )
    .join('\n');
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`\nError: ${error.message}\n`);
  process.exitCode = 1;
}
