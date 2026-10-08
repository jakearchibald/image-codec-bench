#!/usr/bin/env node
// Encode every image in a directory at one fixed quality per codec, across
// effort/speed levels and AVIF subsampling, and record each file's SSIMULACRA2
// score -- to see how much the score moves when only effort or yuv changes.
// Reuses the bench's codecs, normalisation, decode + scoring and file naming,
// so scores match a bench run at the same settings.

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
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

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff']);

const OPTIONS = {
  codecs: { type: 'string', default: 'avif,jxl' },
  'avif-quality': { type: 'string', default: '60' },
  'avif-speed': { type: 'string', default: '0-10' },
  'avif-depth': { type: 'string', default: '8' },
  'avif-yuv': { type: 'string', default: '420,444' },
  'avif-qalpha': { type: 'string', default: 'match' },
  'jxl-quality': { type: 'string', default: '75' },
  'jxl-effort': { type: 'string', default: '1-10' },
  'max-pixels': { type: 'string', default: '0' },
  out: { type: 'string', default: 'out' },
  concurrency: { type: 'string', default: '1' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const HELP = `image-codec-bench fixed-quality -- how SSIMULACRA2 varies with effort and
subsampling at a fixed quality.

Encodes every image in a directory at one quality per codec, across each
effort/speed level (and, for AVIF, each yuv mode), and scores every file.
Results go to DIR/<dir-name>-fixed-quality.json; the encoded files are not kept.

Usage:
  node src/fixed-quality.js <directory> [options]

Options:
  --codecs LIST              avif, jxl (default avif,jxl)
  --avif-quality N           avifenc -q, integer (default 60)
  --avif-speed RANGE         avifenc -s (default 0-10; 0 is slowest)
  --avif-depth LIST          avifenc -d (default 8; e.g. 8,10)
  --avif-yuv LIST            444 | 422 | 420 | 400, comma-separated (default 420,444)
  --avif-qalpha VALUE        'match' to track -q, or 0..100 (default match)
  --jxl-quality N            cjxl -q (default 75)
  --jxl-effort RANGE         cjxl -e (default 1-10)
  --max-pixels N             downscale each source to fit N pixels first (e.g. 2MP)
  --out DIR                  where the JSON goes (default out)
  --concurrency N            encodes in parallel (default 1)
  --quiet                    only print the results table
  -h, --help                 this text

Examples:
  node src/fixed-quality.js inputs --avif-quality 50 --jxl-quality 70
  node src/fixed-quality.js inputs --codecs avif --avif-speed 2,4,6,8 --max-pixels 2MP
`;

function resolveConfig(values, positionals) {
  const dir = positionals[0];
  if (!dir) throw new Error('No input directory given.');

  const codecs = values.codecs.split(',').map((c) => c.trim()).filter(Boolean);
  for (const name of codecs) {
    if (name !== 'avif' && name !== 'jxl') throw new Error(`--codecs takes avif and/or jxl (got ${name})`);
  }

  const config = {
    dir: path.resolve(dir),
    out: path.resolve(values.out),
    codecs,
    avif: {
      quality: [Number(values['avif-quality'])],
      effort: parseRange(values['avif-speed'], { integer: true }),
      depth: parseRange(values['avif-depth'], { integer: true }),
      yuv: parseYuvModes(values['avif-yuv']),
      qalpha: values['avif-qalpha'],
    },
    jxl: {
      quality: [Number(values['jxl-quality'])],
      effort: parseRange(values['jxl-effort'], { integer: true }),
      depth: [8],
    },
    maxPixels: parsePixels(values['max-pixels']),
    concurrency: Number(values.concurrency),
    quiet: values.quiet === true,
  };

  const [avifQuality] = config.avif.quality;
  if (!Number.isInteger(avifQuality) || avifQuality < 0 || avifQuality > 100) {
    throw new Error(`--avif-quality must be an integer 0..100 (got ${values['avif-quality']})`);
  }
  const [jxlQuality] = config.jxl.quality;
  if (Number.isNaN(jxlQuality) || jxlQuality < 0 || jxlQuality > 100) {
    throw new Error(`--jxl-quality must be 0..100 (got ${values['jxl-quality']})`);
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
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
    throw new Error('--concurrency must be an integer >= 1');
  }
  return config;
}

/**
 * Score spread across effort, per image and per group of settings that differ
 * only in effort (codec x depth x yuv), so yuv's effect isn't counted as
 * effort's.
 */
function summarise(results) {
  const groups = new Map();
  for (const r of results) {
    const key = [r.codec, `d${r.depth}`, r.yuv && `yuv${r.yuv}`].filter(Boolean).join('-');
    if (!groups.has(key)) groups.set(key, { codec: r.codec, depth: r.depth, yuv: r.yuv, rows: [] });
    groups.get(key).rows.push(r);
  }
  return [...groups.entries()].map(([group, { codec, depth, yuv, rows }]) => {
    const best = rows.reduce((a, b) => (b.score > a.score ? b : a));
    const worst = rows.reduce((a, b) => (b.score < a.score ? b : a));
    return {
      group,
      codec,
      depth,
      yuv,
      min: { effort: worst.effort, score: worst.score },
      max: { effort: best.effort, score: best.score },
      range: best.score - worst.score,
    };
  });
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

  const files = (await readdir(config.dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort();
  if (files.length === 0) throw new Error(`No images found in ${config.dir}`);

  const health = await doctor({ log });
  log(`${formatDoctor(health)}\n`);
  assertToolchain(health);

  const series = buildSeries(config);
  const jsonPath = path.join(config.out, `${path.basename(config.dir)}-fixed-quality.json`);
  const tempDir = path.join(config.out, `${path.basename(config.dir)}-fixed-quality.tmp`);
  await mkdir(tempDir, { recursive: true });

  const output = {
    dir: config.dir,
    quality: Object.fromEntries(config.codecs.map((c) => [c, config[c].quality[0]])),
    maxPixels: config.maxPixels,
    versions: health.versions,
    images: [],
  };
  log(`${files.length} image(s) x ${series.length} setting(s)\n`);

  for (const file of files) {
    const input = path.join(config.dir, file);
    const inputBytes = await readFile(input);
    if (hasGainMap(inputBytes) || isHdrPng(inputBytes)) {
      log(`${file}: skipped, HDR input isn't supported here`);
      continue;
    }

    const imageDir = path.join(tempDir, path.basename(file, path.extname(file)));
    await mkdir(imageDir, { recursive: true });
    const reference = await normalise(input, path.join(imageDir, 'reference.png'), {
      maxPixels: config.maxPixels,
    });
    const referenceHeader = readHeader(await readFile(reference.path));
    log(
      `${file}: ${reference.width}x${reference.height} (${reference.megapixels.toFixed(2)} MP)` +
        `${reference.resized ? ', downscaled' : ''}`,
    );

    const results = await mapConcurrent(series, config.concurrency, async (s) => {
      const codec = getCodec(s.codec);
      const job = { ...s, quality: s.qualities[0] };
      const bitstream = path.join(imageDir, bitstreamName(job));
      await exec(
        encoderFor(codec, reference, job),
        codec.buildEncodeArgs({
          input: encodeInput(reference, s.codec),
          output: bitstream,
          quality: job.quality,
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
        workDir: imageDir,
      });
      const bytes = await fileSize(bitstream);
      await rm(bitstream, { force: true });
      log(`  ${path.basename(bitstream, path.extname(bitstream))}: ${score.toFixed(2)}`);
      return {
        codec: s.codec,
        quality: job.quality,
        effort: s.effort,
        depth: s.depth,
        yuv: s.yuv,
        score,
        bytes,
      };
    });
    await rm(imageDir, { recursive: true, force: true });

    output.images.push({
      file,
      width: reference.width,
      height: reference.height,
      resized: reference.resized,
      results,
      spread: summarise(results),
    });
    // After every image, so an interrupted run keeps what it finished.
    await writeFile(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
  }
  await rm(tempDir, { recursive: true, force: true });

  process.stdout.write(`\n${formatTables(output.images, config)}\n\nResults: ${jsonPath}\n`);
  return 0;
}

/** One table per codec: a row per image and group, a column per effort, then the range. */
function formatTables(images, config) {
  return config.codecs
    .map((codec) => {
      const efforts = config[codec].effort;
      const table = [
        ['image', 'settings', ...efforts.map((e) => `e${e}`), 'range'],
        ...images.flatMap((image) =>
          image.spread
            .filter((g) => g.codec === codec)
            .map((g) => {
              const rows = image.results.filter(
                (r) => r.codec === codec && r.depth === g.depth && r.yuv === g.yuv,
              );
              return [
                image.file,
                g.group,
                ...efforts.map((e) => rows.find((r) => r.effort === e)?.score.toFixed(2) ?? '--'),
                g.range.toFixed(2),
              ];
            }),
        ),
      ];
      const widths = table[0].map((_, i) => Math.max(...table.map((row) => row[i].length)));
      return table
        .map((row) => row.map((cell, i) => (i < 2 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  '))
        .join('\n');
    })
    .join('\n\n');
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`\nError: ${error.message}\n`);
  process.exitCode = 1;
}
