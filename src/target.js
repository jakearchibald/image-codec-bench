#!/usr/bin/env node
// Encode an image to target SSIMULACRA2 scores: for each codec setting, search
// for the lowest quality that reaches each score and keep that file, named for
// its settings and the score it got. Reuses the bench's codecs, normalisation,
// decode + scoring and file naming, so files and scores match a bench run.
//
// HDR input works as in src/cli.js: an HDR (PQ) PNG plus --sdr, AVIF in the
// --avif-hdr modes, and targets on the PU21 SSIMULACRA2 scale (src/hdr.js).

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { getCodec } from './codecs/index.js';
import { parseAlphaDistance, parseHdrModes, parsePatchModes, parsePixels, parseSplineModes, parseYuvModes } from './config.js';
import { assertToolchain, doctor, formatDoctor } from './doctor.js';
import { run as exec } from './exec.js';
import { checkHdrInput, pqDepthNote, prepareHdrReference } from './hdr.js';
import { normalise } from './normalise.js';
import { readHeader } from './png.js';
import { CANONICAL_THREADS, bitstreamName, encodeInput, encoderFor } from './run.js';
import { buildSeries, parseRange } from './schedule.js';
import { decodeAndScore, fileSize, mapConcurrent } from './score.js';
import { searchQuality } from './search.js';

const OPTIONS = {
  target: { type: 'string', short: 't' },
  codecs: { type: 'string', default: 'avif,jxl' },
  'avif-speed': { type: 'string', default: '6' },
  'avif-depth': { type: 'string', default: '8' },
  'avif-yuv': { type: 'string', default: '444' },
  'avif-qalpha': { type: 'string', default: 'match' },
  'avif-hdr': { type: 'string' },
  'jxl-effort': { type: 'string', default: '7' },
  'jxl-alpha-distance': { type: 'string', default: 'match' },
  'jxl-step': { type: 'string', default: '0.1' },
  'jixel-effort': { type: 'string', default: '3' },
  'jixel-patches': { type: 'string', default: 'off' },
  'jixel-splines': { type: 'string', default: 'off' },
  'max-pixels': { type: 'string', default: '0' },
  sdr: { type: 'string' },
  out: { type: 'string', default: 'out' },
  concurrency: { type: 'string', default: '1' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const HELP = `image-codec-bench target -- encode an image to target SSIMULACRA2 scores.

For every codec setting and target, finds the lowest quality whose decode
scores at least the target, and keeps that file, named like
  avif-q28-e0-d8-yuv420-ssimu70.2.avif
where the ssimu value is the score it actually got (to 1 decimal place).

Usage:
  node src/target.js <image> --target SCORES [options]

Options:
  -t, --target RANGE         SSIMULACRA2 scores to hit (required; e.g. 60,70,80
                             or 50:90:10)
  --codecs LIST              avif, jxl, jixel (default avif,jxl)
  --avif-speed RANGE         avifenc -s (default 6; 0 is slowest)
  --avif-depth LIST          avifenc -d (default 8; e.g. 8,10)
  --avif-yuv LIST            444 | 422 | 420 | 400, comma-separated (default 444)
  --avif-qalpha VALUE        'match' to track -q, or 0..100 (default match)
  --avif-hdr LIST            HDR mode: gainmap | gainmap-hdr | pq, comma-separated
                             (default gainmap), as in src/cli.js
  --jxl-effort RANGE         cjxl -e (default 7)
  --jxl-alpha-distance VALUE cjxl -a: 'match' to use the distance -q maps to,
                             or 0..25 (default match; images with alpha only)
  --jxl-step N               cjxl and jixel -q search precision (default 0.1;
                             avifenc -q is integer only)
  --jixel-effort RANGE       jixel speed 1-6 (default 3, jixel's default; 6 is
                             slowest)
  --jixel-patches LIST       off | on | off,on (default off)
  --jixel-splines LIST       off | on | off,on (default off; speed 5-6 only)
  --max-pixels N             downscale source to fit N pixels first (e.g. 2MP;
                             not available for HDR input)
  --sdr FILE                 HDR mode: the input is an HDR (PQ) PNG and FILE is the
                             SDR rendition, used as the AVIF gain map's base.
                             Targets are then PU21 SSIMULACRA2 scores, which are
                             not on the same scale as SDR ones
  --out DIR                  files go in DIR/<image>-targets (default out). An
                             existing targets.json there is added to: rows for
                             other settings are kept, rows for these replaced
  --concurrency N            settings searched in parallel (default 1)
  --quiet                    only print the results table
  -h, --help                 this text

Examples:
  node src/target.js photo.png -t 70
  node src/target.js photo.png -t 60,70,80,90 --avif-yuv 420,444 --avif-speed 0,6 --jxl-effort 7,9
  node src/target.js photo-hdr.png --sdr photo-sdr.png -t 60,70 --avif-depth 10 --avif-hdr gainmap,pq
`;

/** Quality grid searched per codec: avifenc -q is integer, cjxl's and jixel's are not. */
function qualityGrid(codecName, config) {
  return codecName === 'jxl' || codecName === 'jixel'
    ? { min: 0, max: 100, step: config.jxlStep }
    : { min: 0, max: 100, step: 1 };
}

/** The bench's file name, with the achieved score added before the extension. */
export function targetFileName(job, score) {
  const name = bitstreamName(job);
  const ext = path.extname(name);
  return `${path.basename(name, ext)}-ssimu${score.toFixed(1)}${ext}`;
}

function resolveConfig(values, positionals) {
  const input = positionals[0];
  if (!input) throw new Error('No input image given.');
  if (!values.target) throw new Error('--target is required, e.g. --target 70 or --target 60,70,80.');

  const codecs = values.codecs.split(',').map((c) => c.trim()).filter(Boolean);
  for (const name of codecs) {
    if (!['avif', 'jxl', 'jixel'].includes(name)) throw new Error(`--codecs takes avif, jxl and/or jixel (got ${name})`);
  }

  const config = {
    input: path.resolve(input),
    out: path.resolve(values.out),
    codecs,
    // Ascending, so each search starts from the bracket the previous one left.
    targets: [...new Set(parseRange(values.target))].sort((a, b) => a - b),
    avif: {
      effort: parseRange(values['avif-speed'], { integer: true }),
      depth: parseRange(values['avif-depth'], { integer: true }),
      yuv: parseYuvModes(values['avif-yuv']),
      qalpha: values['avif-qalpha'],
      hdrModes: parseHdrModes(values['avif-hdr'] ?? 'gainmap'),
      quality: [],
    },
    avifHdrExplicit: values['avif-hdr'] !== undefined,
    jxl: {
      effort: parseRange(values['jxl-effort'], { integer: true }),
      depth: [8],
      alphaDistance: parseAlphaDistance(values['jxl-alpha-distance']),
      quality: [],
    },
    jixel: {
      effort: parseRange(values['jixel-effort'], { integer: true }),
      depth: [8],
      patches: parsePatchModes(values['jixel-patches']),
      splines: parseSplineModes(values['jixel-splines']),
      quality: [],
    },
    jxlStep: Number(values['jxl-step']),
    maxPixels: parsePixels(values['max-pixels']),
    // HDR mode (src/hdr.js): the input is a PQ PNG and this is the SDR
    // rendition of the same image, used as the AVIF gain map's base.
    sdr: values.sdr ? path.resolve(values.sdr) : null,
    concurrency: Number(values.concurrency),
    quiet: values.quiet === true,
  };

  for (const t of config.targets) {
    if (t > 100) throw new Error(`SSIMULACRA2 tops out at 100 (got --target ${t})`);
  }
  for (const s of config.avif.effort) {
    if (s < 0 || s > 10) throw new Error(`avifenc -s out of range: ${s} (expected 0..10)`);
  }
  for (const d of config.avif.depth) {
    if (![8, 10, 12].includes(d)) throw new Error(`avifenc -d must be 8, 10 or 12, got ${d}`);
  }
  for (const e of config.jxl.effort) {
    if (e < 1 || e > 10) throw new Error(`cjxl -e out of range: ${e} (expected 1..10)`);
  }
  for (const s of config.jixel.effort) {
    if (s < 1 || s > 6) throw new Error(`jixel speed out of range: ${s} (expected 1..6)`);
  }
  if (!(config.jxlStep > 0)) throw new Error('--jxl-step must be greater than zero');
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
    throw new Error('--concurrency must be an integer >= 1');
  }
  return config;
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

  const inputBytes = await readFile(config.input);
  config.hdr = checkHdrInput({ input: config.input, inputBytes, sdr: config.sdr, command: 'node src/target.js' });
  if (!config.hdr && config.avifHdrExplicit) {
    throw new Error('--avif-hdr only applies to HDR runs (an HDR PNG with --sdr).');
  }
  if (config.hdr && config.maxPixels > 0) {
    throw new Error(
      '--max-pixels is not available for HDR input: the AVIF gain map is computed from the ' +
        'two PNGs as given. Downscale both PNGs first.',
    );
  }

  const health = await doctor({ hdr: config.hdr, codecs: config.codecs, log });
  log(`${formatDoctor(health)}\n`);
  assertToolchain(health);

  const stem = path.basename(config.input, path.extname(config.input));
  const outDir = path.join(config.out, `${stem}-targets`);
  const tempDir = path.join(outDir, '.tmp');
  await mkdir(tempDir, { recursive: true });

  const referencePath = path.join(tempDir, 'reference.png');
  const reference = config.hdr
    ? await prepareHdrReference({
        hdrInput: config.input,
        hdrBytes: inputBytes,
        sdrInput: config.sdr,
        sdrBytes: await readFile(config.sdr),
        output: referencePath,
      })
    : await normalise(config.input, referencePath, { maxPixels: config.maxPixels });
  const referenceHeader = readHeader(await readFile(reference.path));
  log(
    `Reference: ${reference.width}x${reference.height} (${reference.megapixels.toFixed(2)} MP)` +
      `${reference.resized ? ', downscaled' : ''}`,
  );
  if (reference.hdr) {
    const { hdr } = reference;
    const encodes = {
      avif: `AVIF as ${config.avif.hdrModes.join(', ')}`,
      jxl: 'JXL as PQ',
      jixel: 'jixel as PQ',
    };
    log(
      `HDR: PQ, ${hdr.primariesName} primaries, peak ${hdr.peakNits.toFixed(0)} nits; SDR PNG ` +
        `${hdr.sdr.primariesName}. ${config.codecs.map((c) => encodes[c]).join('; ')}.`,
    );
    const depthNote = pqDepthNote(config.avif.hdrModes, config.avif.depth);
    if (depthNote) log(depthNote.trimEnd());
  }

  const metric = reference.hdr ? 'PU21 SSIMULACRA2' : 'SSIMULACRA2';
  config.alpha = reference.hasAlpha;
  const series = buildSeries(config);
  log(`Searching ${series.length} setting(s) for ${metric} ${config.targets.join(', ')}...\n`);

  const rows = (await mapConcurrent(series, config.concurrency, async (s) => {
    const codec = getCodec(s.codec);
    const jobAt = (quality) => ({ ...s, quality });
    const known = new Map();

    // Encode + score one quality. Probes are kept until the end, since several
    // targets can land on the same one.
    const probe = async (quality) => {
      const job = jobAt(quality);
      const bitstream = path.join(tempDir, bitstreamName(job));
      await exec(
        encoderFor(codec, reference, job),
        codec.buildEncodeArgs({
          input: encodeInput(reference, s.codec),
          hdr: reference.hdr ?? null,
          hdrMode: s.hdrMode ?? null,
          output: bitstream,
          quality,
          effort: s.effort,
          depth: s.depth,
          yuv: s.yuv ?? undefined,
          qalpha: s.qalpha ?? undefined,
          alphaDistance: s.alphaDistance ?? undefined,
          patches: s.patches ?? undefined,
          splines: s.splines ?? undefined,
          threads: CANONICAL_THREADS,
        }),
      );
      const { score } = await decodeAndScore({
        codec,
        bitstream,
        reference: reference.path,
        referenceHeader,
        workDir: tempDir,
        hdr: reference.hdr ?? null,
        hdrMode: s.hdrMode ?? null,
      });
      log(`  ${path.basename(bitstream, path.extname(bitstream))}: ${score.toFixed(2)}`);
      return score;
    };

    const found = [];
    for (const target of config.targets) {
      const hit = await searchQuality({ ...qualityGrid(s.codec, config), target, probe, known });
      if (!hit) {
        log(`  ${s.id}: can't reach ${target} (q100 scores ${known.get(100).toFixed(2)})`);
        found.push({ ...settingsOf(s), target, file: null });
        continue;
      }
      const job = jobAt(hit.quality);
      const file = targetFileName(job, hit.score);
      const output = path.join(outDir, file);
      await copyFile(path.join(tempDir, bitstreamName(job)), output);
      found.push({
        ...settingsOf(s),
        target,
        quality: hit.quality,
        score: hit.score,
        bytes: await fileSize(output),
        file,
      });
    }
    return found;
  })).flat();

  const jsonPath = path.join(outDir, 'targets.json');
  const merged = mergeTargets(await readJson(jsonPath), { input: config.input, reference, versions: health.versions, results: rows });
  await writeFile(jsonPath, `${JSON.stringify(merged, null, 2)}\n`);
  await rm(tempDir, { recursive: true, force: true });

  const kept = merged.results.length - rows.length;
  process.stdout.write(
    `\n${formatRows(rows)}\n\nFiles: ${outDir}\n` +
      (kept > 0 ? `targets.json also keeps ${kept} row(s) from earlier runs with other settings.\n` : ''),
  );
  return 0;
}

/**
 * What identifies a setting in targets.json. `patches` only exists for jixel,
 * and `splines` only when on, so earlier files' settings still match.
 */
function settingsOf(s) {
  const settings = { codec: s.codec, effort: s.effort, depth: s.depth, yuv: s.yuv, hdrMode: s.hdrMode };
  if (s.codec === 'jixel') settings.patches = Boolean(s.patches);
  if (s.splines) settings.splines = true;
  return settings;
}

const rowId = (r) =>
  JSON.stringify([r.codec, r.effort, r.depth, r.yuv ?? null, r.hdrMode ?? null, r.patches ?? null, r.splines || null, r.target]);

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Add this run to an existing targets.json, so a run with only new settings
 * (say --codecs jixel) doesn't throw away slow searches done before. Rows for
 * settings this run searched are replaced; the rest are kept. Only for the same
 * reference pixels: a changed image or --max-pixels starts over.
 */
export function mergeTargets(previous, current) {
  if (!previous || previous.reference?.width !== current.reference.width ||
      previous.reference?.height !== current.reference.height || previous.input !== current.input) {
    return current;
  }
  const replaced = new Set(current.results.map(rowId));
  return {
    ...current,
    versions: { ...previous.versions, ...current.versions },
    results: [...previous.results.filter((r) => !replaced.has(rowId(r))), ...current.results],
  };
}

function formatRows(rows) {
  const table = [
    ['target', 'score', 'bytes', 'file'],
    ...rows.map((r) => [
      String(r.target),
      r.file ? r.score.toFixed(2) : '--',
      r.file ? r.bytes.toLocaleString('en-US') : '--',
      r.file ?? `unreachable (${[r.codec, `e${r.effort}`, r.yuv && `yuv${r.yuv}`, r.patches && 'patches', r.splines && 'splines', r.hdrMode].filter(Boolean).join('-')})`,
    ]),
  ];
  const widths = table[0].map((_, i) => Math.max(...table.map((row) => row[i].length)));
  return table
    .map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padStart(widths[i]))).join('  '))
    .join('\n');
}

// Only when run directly, so tests can import targetFileName.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`\nError: ${error.message}\n`);
    process.exitCode = 1;
  }
}
