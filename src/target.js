#!/usr/bin/env node
// Encode an image to target SSIMULACRA2 scores: for each codec setting, search
// for the lowest quality that reaches each score and keep that file, named for
// its settings and the score it got. Reuses the bench's codecs, normalisation,
// decode + scoring and file naming, so files and scores match a bench run.

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { getCodec } from './codecs/index.js';
import { parsePixels, parseYuvModes } from './config.js';
import { assertToolchain, doctor, formatDoctor } from './doctor.js';
import { run as exec } from './exec.js';
import { hasGainMap, isHdrPng } from './hdr.js';
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
  'jxl-effort': { type: 'string', default: '7' },
  'jxl-step': { type: 'string', default: '0.1' },
  'max-pixels': { type: 'string', default: '0' },
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
  --codecs LIST              avif, jxl (default avif,jxl)
  --avif-speed RANGE         avifenc -s (default 6; 0 is slowest)
  --avif-depth LIST          avifenc -d (default 8; e.g. 8,10)
  --avif-yuv LIST            444 | 422 | 420 | 400, comma-separated (default 444)
  --avif-qalpha VALUE        'match' to track -q, or 0..100 (default match)
  --jxl-effort RANGE         cjxl -e (default 7)
  --jxl-step N               cjxl -q search precision (default 0.1; avifenc -q
                             is integer only)
  --max-pixels N             downscale source to fit N pixels first (e.g. 2MP)
  --out DIR                  files go in DIR/<image>-targets (default out)
  --concurrency N            settings searched in parallel (default 1)
  --quiet                    only print the results table
  -h, --help                 this text

Examples:
  node src/target.js photo.png -t 70
  node src/target.js photo.png -t 60,70,80,90 --avif-yuv 420,444 --avif-speed 0,6 --jxl-effort 7,9
`;

/** Quality grid searched per codec: avifenc -q is integer, cjxl -q is not. */
function qualityGrid(codecName, config) {
  return codecName === 'jxl'
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
    if (name !== 'avif' && name !== 'jxl') throw new Error(`--codecs takes avif and/or jxl (got ${name})`);
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
      quality: [],
    },
    jxl: {
      effort: parseRange(values['jxl-effort'], { integer: true }),
      depth: [8],
      quality: [],
    },
    jxlStep: Number(values['jxl-step']),
    maxPixels: parsePixels(values['max-pixels']),
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
  if (hasGainMap(inputBytes) || isHdrPng(inputBytes)) {
    throw new Error('HDR input is not supported here; use src/cli.js with --sdr.');
  }

  const health = await doctor({ log });
  log(`${formatDoctor(health)}\n`);
  assertToolchain(health);

  const stem = path.basename(config.input, path.extname(config.input));
  const outDir = path.join(config.out, `${stem}-targets`);
  const tempDir = path.join(outDir, '.tmp');
  await mkdir(tempDir, { recursive: true });

  const reference = await normalise(config.input, path.join(tempDir, 'reference.png'), {
    maxPixels: config.maxPixels,
  });
  const referenceHeader = readHeader(await readFile(reference.path));
  log(
    `Reference: ${reference.width}x${reference.height} (${reference.megapixels.toFixed(2)} MP)` +
      `${reference.resized ? ', downscaled' : ''}`,
  );

  const series = buildSeries(config);
  log(`Searching ${series.length} setting(s) for SSIMULACRA2 ${config.targets.join(', ')}...\n`);

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
          output: bitstream,
          quality,
          effort: s.effort,
          depth: s.depth,
          yuv: s.yuv ?? undefined,
          qalpha: s.qalpha ?? undefined,
          threads: CANONICAL_THREADS,
        }),
      );
      const { score } = await decodeAndScore({
        codec,
        bitstream,
        reference: reference.path,
        referenceHeader,
        workDir: tempDir,
      });
      log(`  ${path.basename(bitstream, path.extname(bitstream))}: ${score.toFixed(2)}`);
      return score;
    };

    const found = [];
    for (const target of config.targets) {
      const hit = await searchQuality({ ...qualityGrid(s.codec, config), target, probe, known });
      if (!hit) {
        log(`  ${s.id}: can't reach ${target} (q100 scores ${known.get(100).toFixed(2)})`);
        found.push({ codec: s.codec, effort: s.effort, depth: s.depth, yuv: s.yuv, target, file: null });
        continue;
      }
      const job = jobAt(hit.quality);
      const file = targetFileName(job, hit.score);
      const output = path.join(outDir, file);
      await copyFile(path.join(tempDir, bitstreamName(job)), output);
      found.push({
        codec: s.codec,
        effort: s.effort,
        depth: s.depth,
        yuv: s.yuv,
        target,
        quality: hit.quality,
        score: hit.score,
        bytes: await fileSize(output),
        file,
      });
    }
    return found;
  })).flat();

  await writeFile(
    path.join(outDir, 'targets.json'),
    `${JSON.stringify({ input: config.input, reference, versions: health.versions, results: rows }, null, 2)}\n`,
  );
  await rm(tempDir, { recursive: true, force: true });

  process.stdout.write(`\n${formatRows(rows)}\n\nFiles: ${outDir}\n`);
  return 0;
}

function formatRows(rows) {
  const table = [
    ['target', 'score', 'bytes', 'file'],
    ...rows.map((r) => [
      String(r.target),
      r.file ? r.score.toFixed(2) : '--',
      r.file ? r.bytes.toLocaleString('en-US') : '--',
      r.file ?? `unreachable (${[r.codec, `e${r.effort}`, r.yuv && `yuv${r.yuv}`].filter(Boolean).join('-')})`,
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
