#!/usr/bin/env node
// What progressive encoding costs: bytes, encode time, encode memory, browser
// decode time and SSIMULACRA2 of the final image, against the same image
// encoded non-progressively.
//
// Four or five files from one image:
//  - JXL at -q, and the same with -p (progressive AC and DC passes).
//  - Optionally (--jixel-speed), jixel at -q and the same with progressive
//    DC (a squeezed DC frame, every level) and centre-first groups. Its AC
//    stays in one pass, unlike cjxl -p.
//  - AVIF at -q, and a two-layer AVIF: a preview image as layer 0, coded at
//    1/8 scale, then the full image as layer 1. AV1 spatial layers all have the
//    image's full dimensions (the encoder does the downscale), so the preview
//    is upscaled to full size first and the encoder brings it back to 1/8.
//  - Optionally, the same two-layer AVIF with layer 1 coded as a keyframe
//    (`-k 1`) rather than predicted from layer 0.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { parseTargets, resolveTarget } from './browsers.js';
import { avif, jixel, jxl } from './codecs/index.js';
import { parseDuration, parseSplineModes, parseYuvModes } from './config.js';
import { WARMUP_RUNS, measureDecodeTimes, serveDirectory } from './decode.js';
import { canMeasureMemory, measureSpawnOverhead, run, setToolPath } from './exec.js';
import { LOCAL_LIBAVIF_DIR } from './hdr.js';
import { normalise } from './normalise.js';
import { readHeader, stripChunks } from './png.js';
import { parseRange } from './schedule.js';
import { decodeAndScore, fileSize, parseScore } from './score.js';
import { searchQuality } from './search.js';
import { openSession } from './webdriver.js';

const OPTIONS = {
  preview: { type: 'string' },
  'preview-scale': { type: 'string', default: '8' },
  'jxl-quality': { type: 'string', default: '70' },
  'jxl-effort': { type: 'string', default: '7' },
  'jixel-quality': { type: 'string', default: '80' },
  'jixel-speed': { type: 'string' },
  'jixel-splines': { type: 'string', default: 'off' },
  'avif-quality': { type: 'string', default: '50' },
  'avif-preview-quality': { type: 'string' },
  'avif-speed': { type: 'string', default: '6' },
  'avif-yuv': { type: 'string', default: '444' },
  'avif-depth': { type: 'string', default: '8' },
  'avif-keyframe-variant': { type: 'boolean' },
  target: { type: 'string', short: 't' },
  'jxl-target': { type: 'string' },
  'jixel-target': { type: 'string' },
  'avif-target': { type: 'string' },
  'no-match': { type: 'boolean' },
  'jxl-step': { type: 'string', default: '0.1' },
  repeats: { type: 'string', default: '5' },
  threads: { type: 'string', default: 'single,multi' },
  'decode-browsers': { type: 'string' },
  'no-decode-timing': { type: 'boolean' },
  'decode-repeats': { type: 'string', default: '20' },
  'decode-budget': { type: 'string', default: '5s' },
  'crop-size': { type: 'string', default: '1024' },
  chrome: { type: 'string' },
  firefox: { type: 'string' },
  chromedriver: { type: 'string' },
  geckodriver: { type: 'string' },
  safaridriver: { type: 'string' },
  out: { type: 'string', default: 'out' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const HELP = `image-codec-bench progressive -- what progressive JXL and layered
AVIF cost against the same image encoded non-progressively.

For each --jxl-effort: JXL (-q) and JXL -p. For each --jixel-speed, if given:
jixel (-q) and jixel with progressive DC, centre first. For each --avif-speed: AVIF (-q)
and a two-layer AVIF whose layer 0 is --preview coded at 1/--preview-scale
(plus, with --avif-keyframe-variant, the same with layer 1 as a keyframe).
Progressive files are compared with the non-progressive file of the same
effort or speed. By default each progressive
file's quality (layer 1's, for the AVIF) is first searched to match the
non-progressive file's SSIMULACRA2, so the comparison is at equal final
quality. With a --target, the non-progressive files are searched to it too.
Each is encoded --repeats
times per thread mode, round-robin, for encode time and peak memory; scored
with SSIMULACRA2; and decoded with createImageBitmap in each browser. Each
browser's decode is also checked to be the final image, not the preview layer.

Usage:
  node src/progressive.js <image> --preview <image> [options]

Options:
  --preview FILE             AVIF layer 0 source, any size (upscaled to the
                             image's size, then coded at 1/--preview-scale)
  --preview-scale N          layer 0 scaling denominator (default 8)
  --jxl-quality Q            cjxl -q (default 70)
  --jxl-effort RANGE         cjxl -e, one group each (default 7, cjxl's own)
  --jixel-speed RANGE        jixel speed 1-6, one group each (default none: no
                             jixel; 3 is jixel's own). Built from tools/cjixel
  --jixel-quality Q          jixel -q (default 80)
  --jixel-splines LIST       off | on | off,on: jixel's experimental splines,
                             one group per setting (default off; speed 5-6
                             only, below that "on" is the same encode as off)
  --avif-quality Q           avifenc -q, both layers (default 50)
  --avif-preview-quality Q   avifenc -q for layer 0 (default --avif-quality)
  --avif-speed RANGE         avifenc -s, one group each (default 6, avifenc's own)
  --avif-yuv MODE            avifenc -y (default 444)
  --avif-depth D             avifenc -d (default 8)
  --avif-keyframe-variant    also encode the two-layer AVIF with layer 1 as a
                             keyframe (avifenc -k 1), not predicted from layer 0
  -t, --target S             search every file's -q for the SSIMULACRA2
                             closest to S, instead of starting from the -q
                             options (they become the search's first guess)
  --jxl-target S, --jixel-target S, --avif-target S
                             the same, for one codec (overrides --target)
  --no-match                 no searching: every file at the -q options
  --jxl-step N               cjxl and jixel -q search precision (default 0.1; avifenc -q
                             is searched in whole steps)
  --repeats N                timed encodes per file per thread mode (default 5)
  --threads LIST             single, multi (default single,multi)
  --decode-browsers LIST     chrome, firefox, safari, safari-preview, all, none
                             (default all, skipping any that can't be driven)
  --no-decode-timing         encode and score only
  --decode-repeats N         createImageBitmap runs per file (default 20)
  --decode-budget DURATION   stop repeating a file past this (default 5s)
  --crop-size N              side of the centre crop used to check each
                             browser's decode (default 1024)
  --chrome, --firefox PATH   browser binaries (default Canary / Nightly)
  --chromedriver, --geckodriver, --safaridriver PATH
                             driver overrides
  --out DIR                  output root (default out)
  --quiet                    only print the results table
  -h, --help                 this text

libavif is taken from $LIBAVIF_BUILD, else ~/dev/libavif/build, else PATH.

Example:
  node src/progressive.js inputs/f1-large.jpg --preview inputs/f1-preview-frame.avif
`;

const THREAD_MODES = ['single', 'multi'];

function int(value, flag, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${flag} must be an integer ${min}..${max}`);
  return n;
}

/** A range (`a-b`, `min:max:step` or a comma list) of integers, deduped. */
function intList(value, flag, min, max) {
  const values = [...new Set(parseRange(value, { integer: true }))];
  for (const n of values) int(n, flag, min, max);
  return values;
}

function optionalScore(value, flag) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n > 100) throw new Error(`${flag} must be a SSIMULACRA2 score up to 100`);
  return n;
}

function resolveConfig(values, positionals) {
  if (positionals.length !== 1) throw new Error('Give exactly one input image.');
  if (!values.preview) throw new Error('--preview is required.');
  const avifQuality = int(values['avif-quality'], '--avif-quality', 0, 100);
  const config = {
    input: path.resolve(positionals[0]),
    preview: path.resolve(values.preview),
    previewScale: int(values['preview-scale'], '--preview-scale', 1, 16),
    jxlQuality: Number(values['jxl-quality']),
    jxlEfforts: intList(values['jxl-effort'], '--jxl-effort', 1, 10),
    jixelQuality: Number(values['jixel-quality']),
    jixelSpeeds: values['jixel-speed'] == null ? [] : intList(values['jixel-speed'], '--jixel-speed', 1, 6),
    jixelSplines: parseSplineModes(values['jixel-splines']),
    avifQuality,
    avifPreviewQuality: values['avif-preview-quality'] == null
      ? avifQuality
      : int(values['avif-preview-quality'], '--avif-preview-quality', 0, 100),
    avifSpeeds: intList(values['avif-speed'], '--avif-speed', 0, 10),
    avifYuv: parseYuvModes(values['avif-yuv']),
    avifDepth: int(values['avif-depth'], '--avif-depth', 8, 12),
    avifKeyframeVariant: values['avif-keyframe-variant'] === true,
    match: values['no-match'] !== true,
    targets: {
      jxl: optionalScore(values['jxl-target'] ?? values.target, '--jxl-target'),
      jixel: optionalScore(values['jixel-target'] ?? values.target, '--jixel-target'),
      avif: optionalScore(values['avif-target'] ?? values.target, '--avif-target'),
    },
    jxlStep: Number(values['jxl-step']),
    repeats: int(values.repeats, '--repeats', 1, 1000),
    threads: values.threads.split(',').map((t) => t.trim()).filter(Boolean),
    decodeBrowsers: values['no-decode-timing'] ? [] : parseTargets(values['decode-browsers'] ?? 'all'),
    decodeBrowsersExplicit: Boolean(values['decode-browsers']) && values['decode-browsers'] !== 'all',
    decodeRepeats: int(values['decode-repeats'], '--decode-repeats', 1, 1000),
    decodeBudgetMs: parseDuration(values['decode-budget']),
    cropSize: int(values['crop-size'], '--crop-size', 64, 8192),
    browserPaths: { chrome: values.chrome ?? null, firefox: values.firefox ?? null },
    driverPaths: {
      chrome: values.chromedriver ?? null,
      firefox: values.geckodriver ?? null,
      safari: values.safaridriver ?? null,
    },
    out: path.resolve(values.out),
    quiet: values.quiet === true,
  };
  if (!(config.jxlQuality > 0 && config.jxlQuality <= 100)) throw new Error('--jxl-quality must be in (0, 100]');
  if (!(config.jixelQuality >= 0 && config.jixelQuality <= 100)) throw new Error('--jixel-quality must be 0..100');
  if (!config.match && Object.values(config.targets).some((t) => t != null)) {
    throw new Error('--no-match and a target contradict each other');
  }
  if (!(config.jxlStep > 0 && config.jxlStep <= 10)) throw new Error('--jxl-step must be in (0, 10]');
  if (config.avifYuv.length !== 1) throw new Error('--avif-yuv takes one mode');
  config.avifYuv = config.avifYuv[0];
  if (![8, 10, 12].includes(config.avifDepth)) throw new Error('--avif-depth must be 8, 10 or 12');
  for (const t of config.threads) {
    if (!THREAD_MODES.includes(t)) throw new Error(`--threads takes ${THREAD_MODES.join(', ')} (got ${t})`);
  }
  if (config.threads.length === 0) throw new Error('--threads needs at least one mode');
  return config;
}

/** Layered encoding is recent, so prefer the local libavif build, as HDR mode does. */
async function toolchain({ withJixel = false, log = () => {} } = {}) {
  const local = ['avifenc', 'avifdec'].map((name) => path.join(LOCAL_LIBAVIF_DIR, name));
  const isLocal = (await Promise.all(local.map((p) => run('test', ['-x', p], { allowFailure: true }))))
    .every((r) => r.code === 0);
  if (isLocal) {
    setToolPath('avifenc', local[0]);
    setToolPath('avifdec', local[1]);
  }
  const line = async (cmd, args) => (await run(cmd, args, { allowFailure: true })).stdout.split('\n')[0].trim();
  return {
    avifenc: await line('avifenc', ['--version']),
    avifencPath: isLocal ? local[0] : 'PATH',
    cjxl: (await line('cjxl', ['--version'])).match(/v?(\d+\.\d+\.\d+)/)?.[1] ?? null,
    magick: (await line('magick', ['-version'])).match(/(\d+\.\d+\.\d+(-\d+)?)/)?.[1] ?? null,
    ...(withJixel
      ? { cjixel: await line(setJixelPath(await jixel.ensureEncoder({ log })), ['--version']) }
      : {}),
  };
}

function setJixelPath(encoderPath) {
  setToolPath('cjixel', encoderPath);
  return 'cjixel';
}

/**
 * Layer 0's source, at the reference's size. It's decoded by avifdec when it's
 * an AVIF (this ImageMagick may not read AVIF), then Lanczos-resized to exactly
 * the reference's dimensions; the encoder scales it back down by 1/scale.
 */
async function preparePreview({ preview, reference, scale, dir }) {
  let source = preview;
  if (path.extname(preview).toLowerCase() === '.avif') {
    source = path.join(dir, 'preview-decoded.png');
    await run('avifdec', ['-d', '8', preview, source]);
  }
  const { stdout } = await run('magick', ['identify', '-format', '%w %h', `${source}[0]`]);
  const [width, height] = stdout.trim().split(/\s+/).map(Number);
  const output = path.join(dir, 'preview-upscaled.png');
  await run('magick', [
    source, '-colorspace', 'sRGB', '-strip',
    '-filter', 'Lanczos', '-resize', `${reference.width}x${reference.height}!`,
    '-depth', '8', reference.hasAlpha ? `PNG32:${output}` : `PNG24:${output}`,
  ]);
  const stripped = stripChunks(await readFile(output));
  if (stripped.removed.length > 0) await writeFile(output, stripped.buffer);
  if (source !== preview) await rm(source, { force: true });
  return {
    path: output,
    width,
    height,
    // What the encoder codes layer 0 at, for comparison with the source size.
    codedWidth: Math.ceil(reference.width / scale),
    codedHeight: Math.ceil(reference.height / scale),
  };
}

/**
 * The encodes: a group per JXL effort and per AVIF speed, each holding the
 * non-progressive file and its progressive ones, which are compared within the
 * group. `args(threads, output, quality)` builds the encoder argv; output and
 * quality default to the file's own, and `quality` is the one the quality
 * match searches (layer 1's for the layered AVIF).
 */
function variants({ config, reference, preview, dir }) {
  const file = (name) => path.join(dir, name);
  const list = [];

  for (const effort of config.jxlEfforts) {
    const group = `jxl-e${effort}`;
    const jxlArgs = (extra) => function (threads, output = this.path, quality = this.quality) {
      return [
        ...jxl.buildEncodeArgs({ input: reference.path, output, quality, effort, threads }),
        ...extra,
        '--quiet',
      ];
    };
    list.push(
      {
        id: group, group, effort, codec: jxl, progressive: false, path: file(`${group}.jxl`), command: 'cjxl',
        quality: config.jxlQuality,
        get label() { return `JXL -q ${this.quality} -e ${effort}`; },
        args: jxlArgs([]),
      },
      {
        id: `${group}-progressive`, group, effort, codec: jxl, progressive: true,
        path: file(`${group}-progressive.jxl`), command: 'cjxl',
        quality: config.jxlQuality,
        get label() { return `JXL -q ${this.quality} -e ${effort} -p`; },
        args: jxlArgs(['-p']),
      },
    );
  }

  // Each splines setting is its own group, so a spline file is compared with
  // the non-progressive spline file. Below jixel.SPLINES_MIN_SPEED "on" is the
  // "off" encode, so it folds into that group, as in the main sweep.
  const jixelGroups = config.jixelSpeeds.flatMap((speed) =>
    [...new Set(config.jixelSplines.map((on) => on && jixel.splinesApply(speed)))].map((splines) => ({ speed, splines })),
  );
  for (const { speed, splines } of jixelGroups) {
    const group = `jixel-s${speed}${splines ? '-splines' : ''}`;
    const name = jixel.effortLabel(speed, { splines });
    const jixelArgs = (progressive) => function (threads, output = this.path, quality = this.quality) {
      return jixel.buildEncodeArgs({
        input: reference.path, output, quality, effort: speed, threads, splines,
        ...(progressive ? { progressiveDc: true, groupOrder: 'center' } : {}),
      });
    };
    list.push(
      {
        id: group, group, effort: speed, codec: jixel, progressive: false, path: file(`${group}.jxl`), command: 'cjixel',
        quality: config.jixelQuality,
        get label() { return `jixel -q ${this.quality} ${name}`; },
        args: jixelArgs(false),
      },
      {
        id: `${group}-progressive`, group, effort: speed, codec: jixel, progressive: true,
        path: file(`${group}-progressive.jxl`), command: 'cjixel',
        quality: config.jixelQuality,
        get label() { return `jixel -q ${this.quality} ${name} progressive DC, centre first`; },
        args: jixelArgs(true),
      },
    );
  }

  for (const speed of config.avifSpeeds) {
    const group = `avif-s${speed}`;
    const avifCommon = (threads) => [
      '-s', String(speed),
      '-y', config.avifYuv,
      '-d', String(config.avifDepth),
      '-j', threads === 'single' ? '1' : 'all',
      '--ignore-exif', '--ignore-xmp',
    ];
    // Two-layer AVIF. `extra` goes before the inputs, so applies to both layers.
    const layered = (suffix, extra, labelSuffix) => ({
      id: `${group}-${suffix}`, group, effort: speed, codec: avif, progressive: true, layered: true,
      keyframe: extra.includes('-k'),
      path: file(`${group}-${suffix}.avif`), command: 'avifenc',
      quality: config.avifQuality,
      get label() {
        return `AVIF -q ${config.avifPreviewQuality}@1/${config.previewScale} + -q ${this.quality} -s ${speed}${labelSuffix}`;
      },
      args(threads, output = this.path, quality = this.quality) {
        return [
          ...avifCommon(threads),
          ...extra,
          '--layered',
          // :u options apply to the inputs after them, so each layer gets its own.
          '-q:u', String(config.avifPreviewQuality), '--qalpha:u', String(config.avifPreviewQuality),
          '--scaling-mode:u', `1/${config.previewScale}`,
          preview.path,
          '-q:u', String(quality), '--qalpha:u', String(quality),
          '--scaling-mode:u', '1/1',
          reference.path,
          output,
        ];
      },
    });
    list.push(
      {
        id: group, group, effort: speed, codec: avif, progressive: false, path: file(`${group}.avif`),
        command: 'avifenc',
        quality: config.avifQuality,
        get label() { return `AVIF -q ${this.quality} -s ${speed}`; },
        args(threads, output = this.path, quality = this.quality) {
          return [...avifCommon(threads), '-q', String(quality), reference.path, output];
        },
      },
      layered('progressive', [], ''),
      ...(config.avifKeyframeVariant ? [layered('progressive-keyframe', ['-k', '1'], ' -k 1')] : []),
    );
  }
  return list;
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    bestMs: sorted[0],
    medianMs: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
    meanMs: sorted.reduce((a, b) => a + b, 0) / n,
    worstMs: sorted[n - 1],
    samplesMs: samples.map((ms) => Number(ms.toFixed(2))),
  };
}

/**
 * Timed encodes, strictly serial. Round-robin across the files rather than all
 * of one file's repeats together, so drift (thermals, background work) is
 * spread evenly instead of landing on whichever file ran last. The first round
 * per mode is a discarded warm-up (disk cache, page cache for the inputs).
 */
async function timeEncodes({ list, config, log }) {
  for (const v of list) v.encode = {};
  for (const mode of config.threads) {
    const samples = new Map(list.map((v) => [v.id, []]));
    const peaks = new Map(list.map((v) => [v.id, 0]));
    for (let round = 0; round <= config.repeats; round += 1) {
      for (const v of list) {
        const { ms, peakBytes } = await run(v.command, v.args(mode), { measureMemory: true });
        if (round === 0) continue;
        samples.get(v.id).push(ms);
        if (peakBytes != null) peaks.set(v.id, Math.max(peaks.get(v.id), peakBytes));
      }
      if (round > 0) log(`  ${mode}-threaded: round ${round}/${config.repeats}`);
    }
    for (const v of list) {
      v.encode[mode] = { ...stats(samples.get(v.id)), peakBytes: canMeasureMemory ? peaks.get(v.id) : null };
    }
  }
}

async function cropPng(input, output, crop) {
  await run('magick', [input, '-crop', `${crop.size}x${crop.size}+${crop.x}+${crop.y}`, '+repage', `PNG24:${output}`]);
  const stripped = stripChunks(await readFile(output));
  if (stripped.removed.length > 0) await writeFile(output, stripped.buffer);
}

async function ssimulacra2(reference, distorted) {
  return parseScore((await run('ssimulacra2', [reference, distorted])).stdout);
}

/**
 * Untimed: decode each file with createImageBitmap, draw a centre crop to a
 * canvas and send it back as PNG. A browser that showed only layer 0 of the
 * layered AVIF would still report full dimensions (the layer is upscaled to
 * the image size), so dimensions prove nothing; the crop's score does.
 */
const CROP_SCRIPT = `
  const [url, x, y, size] = arguments;
  const done = arguments[arguments.length - 1];
  (async () => {
    const blob = await (await fetch(url)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.getContext('2d').drawImage(bitmap, -x, -y);
    const width = bitmap.width;
    const height = bitmap.height;
    bitmap.close();
    const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(png);
    });
    return { width, height, png: dataUrl.slice(dataUrl.indexOf(',') + 1) };
  })().then(done, (error) => done({ error: error.name + ': ' + error.message }));
`;

async function browserCrops({ target, runDir, list, crop }) {
  const { server, origin } = await serveDirectory(runDir);
  let session = null;
  try {
    session = await openSession({ driverPath: target.driverPath, capabilities: target.capabilities });
    await session.navigate(`${origin}/`);
    const out = new Map();
    for (const v of list) {
      const value = await session.executeAsync(CROP_SCRIPT, [
        `${origin}/${path.basename(v.path)}`, crop.x, crop.y, crop.size,
      ]);
      out.set(v.id, value);
    }
    return out;
  } finally {
    await session?.quit().catch(() => {});
    server.close();
  }
}

/**
 * The quality on `grid` whose score is closest to `target`. searchQuality finds
 * the lowest quality reaching it; the step below can be closer, which matters
 * for avifenc's whole-number -q. Seeded with the variant's starting quality,
 * which is usually close, so the search starts from a tight bracket.
 */
async function matchQuality({ v, target, score, grid, workDir }) {
  const probeFile = path.join(workDir, `${v.id}-probe.${v.codec.extension}`);
  const known = new Map();
  const probe = async (quality) => {
    await run(v.command, v.args('multi', probeFile, quality));
    return score(v, probeFile);
  };
  const scoreOf = async (quality) => {
    if (!known.has(quality)) known.set(quality, await probe(quality));
    return known.get(quality);
  };
  try {
    await scoreOf(v.quality);
    const hit = await searchQuality({ ...grid, target, probe, known });
    const above = hit?.quality ?? grid.max;
    const candidates = [above];
    const below = Math.round((above - grid.step) * 1e6) / 1e6;
    if (below >= grid.min) candidates.push(below);
    let best = null;
    for (const quality of candidates) {
      const s = await scoreOf(quality);
      if (!best || Math.abs(s - target) < Math.abs(best.score - target)) best = { quality, score: s };
    }
    return {
      target,
      ...best,
      probes: [...known].sort((a, b) => a[0] - b[0]).map(([quality, s]) => ({ quality, score: s })),
    };
  } finally {
    await rm(probeFile, { force: true });
  }
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

  const versions = await toolchain({ withJixel: config.jixelSpeeds.length > 0, log });
  log(
    `${versions.avifenc} (${versions.avifencPath}), cjxl ${versions.cjxl}, magick ${versions.magick}` +
      `${versions.cjixel ? `, ${versions.cjixel}` : ''}`,
  );

  const stem = path.basename(config.input, path.extname(config.input));
  const runDir = path.join(config.out, `${stem}-progressive`);
  // Cleared so the directory holds exactly what results.json describes.
  await rm(runDir, { recursive: true, force: true });
  await mkdir(runDir, { recursive: true });
  const workDir = path.join(runDir, 'work');
  await mkdir(workDir, { recursive: true });

  const reference = await normalise(config.input, path.join(runDir, 'reference.png'));
  const referenceHeader = readHeader(await readFile(reference.path));
  const preview = await preparePreview({
    preview: config.preview, reference, scale: config.previewScale, dir: workDir,
  });
  log(
    `Reference ${reference.width}x${reference.height}; preview ${preview.width}x${preview.height}, ` +
      `coded as layer 0 at ${preview.codedWidth}x${preview.codedHeight}`,
  );
  if (Math.abs(preview.width - preview.codedWidth) > 2 || Math.abs(preview.height - preview.codedHeight) > 2) {
    log(`  note: the preview isn't 1/${config.previewScale} of the image, so layer 0 is a resample of it`);
  }

  const list = variants({ config, reference, preview, dir: runDir });
  const score = async (v, bitstream) =>
    (await decodeAndScore({ codec: v.codec, bitstream, reference: reference.path, referenceHeader, workDir })).score;

  // 0. Choose qualities. With a target for a codec, both its files are
  // searched to it; otherwise the progressive file is searched to the
  // non-progressive file's score at its -q. Either way the pair is compared at
  // (as near as the -q grid allows) equal final quality.
  if (config.match) {
    for (const group of [...new Set(list.map((x) => x.group))]) {
      const base = list.find((x) => x.group === group && !x.progressive);
      const { codec } = base;
      const grid = codec === avif ? { min: 0, max: 100, step: 1 } : { min: 1, max: 100, step: config.jxlStep };
      let target = config.targets[codec.name];
      if (target != null) {
        log(`Searching ${base.id} for SSIMULACRA2 ${target}...`);
        base.search = await matchQuality({ v: base, target, score, grid, workDir });
        base.quality = base.search.quality;
        log(`  -> -q ${base.quality}, SSIMULACRA2 ${base.search.score.toFixed(2)} (${base.search.probes.length} encodes)`);
      } else {
        await run(base.command, base.args('multi'));
        target = await score(base, base.path);
      }
      // Matching the score the non-progressive file actually reached, not the
      // target, so the pair is as close as possible to each other.
      target = base.search?.score ?? target;
      for (const prog of list.filter((x) => x.group === group && x.progressive)) {
        // Progressive needs a similar -q, so start from the one just found.
        prog.quality = base.quality;
        log(`Searching ${prog.id} for ${base.id}'s SSIMULACRA2 ${target.toFixed(2)}...`);
        prog.search = await matchQuality({ v: prog, target, score, grid, workDir });
        prog.quality = prog.search.quality;
        log(`  -> -q ${prog.quality}, SSIMULACRA2 ${prog.search.score.toFixed(2)} (${prog.search.probes.length} encodes)`);
      }
    }
  }

  // 1. One canonical encode each, for the file that's kept, scored and decoded.
  for (const v of list) {
    await run(v.command, v.args('multi'));
    v.bytes = await fileSize(v.path);
    log(`${v.label}: ${formatBytes(v.bytes)}`);
  }

  // 2. Timed encodes. Each run overwrites the kept file with identical bytes
  // (both encoders are deterministic for a given thread count -- checked below).
  const spawnOverhead = await measureSpawnOverhead();
  log(`\nTiming encodes: ${config.repeats} round(s) + 1 warm-up per thread mode (${config.threads.join(', ')})`);
  await timeEncodes({ list, config, log });
  // The last timed run was in the last thread mode; re-encode multi-threaded
  // so the kept file is the canonical one, and confirm nothing moved.
  for (const v of list) {
    await run(v.command, v.args('multi'));
    const bytes = await fileSize(v.path);
    if (bytes !== v.bytes) {
      log(`  warning: ${v.label} re-encoded to ${bytes} bytes, first encode ${v.bytes}; using the re-encode`);
      v.bytes = bytes;
    }
  }

  // 3. Score.
  log('\nScoring...');
  const crop = {
    size: Math.min(config.cropSize, reference.width, reference.height),
  };
  crop.x = Math.floor((reference.width - crop.size) / 2);
  crop.y = Math.floor((reference.height - crop.size) / 2);
  const refCrop = path.join(workDir, 'reference-crop.png');
  await cropPng(reference.path, refCrop, crop);

  for (const v of list) {
    const result = await decodeAndScore({
      codec: v.codec, bitstream: v.path, reference: reference.path, referenceHeader, workDir, keepDecoded: true,
    });
    v.ssimulacra2 = result.score;
    // The same crop from the reference decoder, to judge the browsers' crops by.
    const nativeCrop = path.join(workDir, `${v.id}-native-crop.png`);
    await cropPng(result.decodedPath, nativeCrop, crop);
    v.nativeCropScore = await ssimulacra2(refCrop, nativeCrop);
    await rm(result.decodedPath, { force: true });
    await rm(nativeCrop, { force: true });
  }
  // Layer 0 on its own: what the progressive AVIF shows before layer 1 arrives
  // (avifdec upscales it to full size).
  for (const v of list.filter((x) => x.layered)) {
    const layer0 = path.join(workDir, `${v.id}-layer0.png`);
    await run('avifdec', ['-d', '8', '--progressive', '--index', '0', v.path, layer0]);
    const { buffer } = stripChunks(await readFile(layer0));
    await writeFile(layer0, buffer);
    v.layer0Ssimulacra2 = await ssimulacra2(reference.path, layer0);
    await rm(layer0, { force: true });
    // `-k` is only documented for image sequences, so check it did what it's
    // here for, rather than trusting it.
    v.frames = av1Frames(await readFile(v.path));
    const finalType = v.frames.at(-1)?.type;
    if (v.keyframe && finalType !== 'KEY') {
      throw new Error(`${v.label}: layer 1 is ${finalType ?? 'missing'}, not a keyframe`);
    }
  }

  // 4. Browser decode timing, plus the crop check.
  const browsersUsed = {};
  const skippedBrowsers = [];
  const problems = [];
  for (const v of list) v.decode = {};
  for (const name of config.decodeBrowsers) {
    const target = await resolveTarget(name, {
      browser: config.browserPaths[name],
      driver: config.driverPaths[name],
    });
    if (target.unavailable) {
      skippedBrowsers.push(`${target.label}: ${target.unavailable}`);
      log(`Decode timing skipped for ${target.label}: ${target.unavailable}.${target.hint ? ` ${target.hint}` : ''}`);
      continue;
    }
    if (!target.headless) log(`${target.label} has no headless mode: a window will open and take focus.`);
    log(`Decode timing in ${target.label}...`);
    const measure = () =>
      measureDecodeTimes({
        target,
        rootDir: runDir,
        targets: list.map((v) => ({ key: v.id, url: path.basename(v.path) })),
        repeats: config.decodeRepeats,
        budgetMs: config.decodeBudgetMs,
      });
    let measured;
    let crops;
    try {
      // Retried once, as in jpeg-transcode: Nightly sometimes exits at launch
      // straight after another browser's session.
      measured = await measure().catch((error) => {
        log(`${target.label}: ${error.message}; retrying once`);
        return measure();
      });
      const cropCheck = () => browserCrops({ target, runDir, list, crop });
      crops = await cropCheck().catch((error) => {
        log(`${target.label} crop check: ${error.message}; retrying once`);
        return cropCheck();
      });
    } catch (error) {
      skippedBrowsers.push(`${target.label}: ${error.message}`);
      log(`Decode timing skipped for ${target.label}: ${error.message}`);
      continue;
    }
    browsersUsed[name] = {
      label: target.label,
      version: measured.version,
      timerGranularityMs: measured.timerGranularityMs ?? null,
    };
    for (const v of list) {
      const timing = measured.results.get(v.id);
      const cropResult = crops.get(v.id);
      const entry = { browser: measured.version };
      if (!timing || timing.error) {
        problems.push(`${target.label} / ${v.label}: ${timing?.error ?? 'no result'}`);
        entry.error = timing?.error ?? 'no result';
      } else {
        Object.assign(entry, timing);
      }
      if (cropResult?.error) {
        problems.push(`${target.label} / ${v.label} crop check: ${cropResult.error}`);
      } else if (cropResult) {
        const file = path.join(workDir, `${v.id}-${name}-crop.png`);
        const { buffer } = stripChunks(Buffer.from(cropResult.png, 'base64'));
        await writeFile(file, buffer);
        entry.cropScore = await ssimulacra2(refCrop, file);
        entry.decodedSize = `${cropResult.width}x${cropResult.height}`;
        await rm(file, { force: true });
        // Browsers convert YUV to RGB a little differently to libavif/libjxl,
        // but nowhere near this far; layer 0 alone scores below zero.
        if (entry.cropScore < v.nativeCropScore - 10) {
          problems.push(
            `${target.label} / ${v.label}: centre crop scores ${entry.cropScore.toFixed(1)} against ` +
              `${v.nativeCropScore.toFixed(1)} from the reference decoder -- it may not be decoding the final image`,
          );
        }
      }
      v.decode[name] = entry;
    }
  }

  await rm(workDir, { recursive: true, force: true });

  const output = {
    settings: {
      input: path.relative(process.cwd(), config.input),
      preview: path.relative(process.cwd(), config.preview),
      previewScale: config.previewScale,
      // Whether qualities were searched (see each file's `search`), and the
      // SSIMULACRA2 targets the non-progressive files were searched to, if any.
      match: config.match,
      targets: config.targets,
      jxl: { quality: config.jxlQuality, efforts: config.jxlEfforts },
      ...(config.jixelSpeeds.length
        ? {
            jixel: {
              quality: config.jixelQuality, speeds: config.jixelSpeeds, progressiveDc: true, groupOrder: 'center',
              // Only when asked for, so earlier settings blocks read the same.
              ...(config.jixelSplines.includes(true) ? { splines: config.jixelSplines } : {}),
            },
          }
        : {}),
      avif: {
        quality: config.avifQuality, previewQuality: config.avifPreviewQuality,
        speeds: config.avifSpeeds, yuv: config.avifYuv, depth: config.avifDepth,
      },
      repeats: config.repeats,
      threads: config.threads,
      crop,
    },
    versions,
    machine: { cpu: os.cpus()[0]?.model ?? 'unknown', cores: os.cpus().length, node: process.version },
    reference: { width: reference.width, height: reference.height },
    preview: { width: preview.width, height: preview.height, codedWidth: preview.codedWidth, codedHeight: preview.codedHeight },
    spawnOverhead,
    browsers: Object.keys(browsersUsed).length
      ? { repeats: config.decodeRepeats, warmup: WARMUP_RUNS, budgetMs: config.decodeBudgetMs, targets: browsersUsed }
      : null,
    files: list.map((v) => ({
      id: v.id,
      label: v.label,
      progressive: v.progressive,
      // Files are compared within a group: one codec at one effort/speed.
      group: v.group,
      codec: v.codec.name,
      // cjxl -e, jixel speed (1-6) or avifenc -s.
      effort: v.effort,
      file: path.basename(v.path),
      // The -q this file was encoded at; for the layered AVIF, layer 1's, with
      // layer 0's as previewQuality.
      quality: v.quality,
      ...(v.layered ? { previewQuality: config.avifPreviewQuality } : {}),
      // How the quality was chosen: the target score, the quality picked and
      // its score, and every quality tried.
      ...(v.search ? { search: v.search } : {}),
      argv: [v.command, ...v.args('multi')].map((a) => (path.isAbsolute(a) ? path.relative(runDir, a) : a)),
      bytes: v.bytes,
      ssimulacra2: v.ssimulacra2,
      ...(v.layer0Ssimulacra2 != null ? { layer0Ssimulacra2: v.layer0Ssimulacra2 } : {}),
      // Each AV1 frame in the bitstream: spatial layer, frame type and bytes.
      ...(v.frames ? { frames: v.frames } : {}),
      nativeCropScore: v.nativeCropScore,
      encode: v.encode,
      decode: v.decode,
    })),
  };
  const jsonPath = path.join(runDir, 'results.json');
  await writeFile(jsonPath, `${JSON.stringify(output, null, 2)}\n`);

  process.stdout.write(`\n${formatTable(output)}\n`);
  if (problems.length > 0) process.stdout.write(`\nProblems:\n  ${problems.join('\n  ')}\n`);
  process.stdout.write(
    `\nEncode times are best of ${config.repeats} and include process spawn ` +
      `(~${spawnOverhead.medianMs.toFixed(1)}ms). Decode times are means.\nResults: ${jsonPath}\n`,
  );
  if (skippedBrowsers.length > 0 && config.decodeBrowsersExplicit) throw new Error(skippedBrowsers.join('\n'));
  return 0;
}

/**
 * The AV1 frames in an AVIF's mdat: spatial layer, frame type and size. Enough
 * of a parse for layered files, whose frames carry full (non-reduced) headers:
 * the uncompressed header starts with show_existing_frame, then frame_type.
 */
const FRAME_TYPES = ['KEY', 'INTER', 'INTRA_ONLY', 'SWITCH'];
function av1Frames(buffer) {
  let mdat = null;
  for (let off = 0; off + 8 <= buffer.length;) {
    let size = buffer.readUInt32BE(off);
    let header = 8;
    if (size === 1) {
      size = Number(buffer.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) {
      size = buffer.length - off;
    }
    if (buffer.toString('latin1', off + 4, off + 8) === 'mdat') {
      mdat = buffer.subarray(off + header, off + size);
      break;
    }
    off += size;
  }
  if (!mdat) throw new Error('No mdat box');
  const frames = [];
  for (let p = 0; p < mdat.length;) {
    const obuHeader = mdat[p];
    const obuType = (obuHeader >> 3) & 15;
    let q = p + 1;
    let spatialId = 0;
    if (obuHeader & 4) {
      spatialId = (mdat[q] >> 3) & 3;
      q += 1;
    }
    if (!(obuHeader & 2)) throw new Error('OBU without a size field');
    let size = 0;
    for (let i = 0; ; i += 1) {
      const byte = mdat[q];
      q += 1;
      size += (byte & 0x7f) * 2 ** (7 * i);
      if (!(byte & 0x80)) break;
    }
    // OBU_FRAME_HEADER (3) or OBU_FRAME (6).
    if (obuType === 3 || obuType === 6) {
      const showExisting = mdat[q] >> 7;
      frames.push({
        spatialId,
        type: showExisting ? 'SHOW_EXISTING' : FRAME_TYPES[(mdat[q] >> 5) & 3],
        bytes: size,
      });
    }
    p = q + size;
  }
  return frames;
}

function formatBytes(bytes) {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(2)} MB` : `${(bytes / 1e3).toFixed(1)} KB`;
}

const pct = (value, base) => `${value >= base ? '+' : ''}${(((value - base) / base) * 100).toFixed(1)}%`;

/**
 * One block per group (codec and effort): the non-progressive row, then each progressive row with
 * the difference from the non-progressive one beneath each figure.
 */
function formatTable(output) {
  const modes = output.settings.threads;
  const browsers = Object.keys(output.browsers?.targets ?? {});
  const header = [
    'file', 'size', 'SSIMU2',
    ...modes.flatMap((m) => [`enc ${m} ms`, `peak ${m}`]),
    ...browsers.map((b) => `${b} dec ms`),
  ];
  const figures = (f) => [
    f.bytes,
    f.ssimulacra2,
    ...modes.flatMap((m) => [f.encode[m].bestMs, f.encode[m].peakBytes]),
    ...browsers.map((b) => f.decode[b]?.meanMs ?? null),
  ];
  const render = (f) => {
    const [bytes, score, ...rest] = figures(f);
    return [
      f.label, formatBytes(bytes), score.toFixed(2),
      ...rest.map((value, i) => {
        if (value == null) return '--';
        const isPeak = i < modes.length * 2 && i % 2 === 1;
        return isPeak ? `${(value / 1048576).toFixed(0)} MB` : value.toFixed(i < modes.length * 2 ? 0 : 1);
      }),
    ];
  };
  const rows = [header];
  for (const group of [...new Set(output.files.map((f) => f.group))]) {
    const base = output.files.find((f) => f.group === group && !f.progressive);
    rows.push(render(base));
    const b = figures(base);
    for (const prog of output.files.filter((f) => f.group === group && f.progressive)) {
      rows.push(render(prog));
      const p = figures(prog);
      rows.push([
        '  progressive overhead',
        ...p.map((value, i) => {
          if (value == null || b[i] == null) return '--';
          // Score as an absolute difference; everything else relative.
          return i === 1 ? `${value - b[i] >= 0 ? '+' : ''}${(value - b[i]).toFixed(2)}` : pct(value, b[i]);
        }),
      ]);
      if (prog.layer0Ssimulacra2 != null) {
        rows.push([`  (layer 0 alone: SSIMU2 ${prog.layer0Ssimulacra2.toFixed(2)})`, ...header.slice(1).map(() => '')]);
      }
    }
    rows.push(header.map(() => ''));
  }
  rows.pop();
  const widths = header.map((_, i) => Math.max(...rows.filter((r) => !r[0].startsWith('  (')).map((r) => r[i].length)));
  return rows
    .map((row) =>
      row[0].startsWith('  (')
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
