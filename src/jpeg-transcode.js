#!/usr/bin/env node
// JPEG -> JPEG XL lossless transcoding: what it saves, and what it costs to
// decode. For each input, width, quality and progressive level, encode a
// jpegli JPEG (4:2:0, no metadata), transcode it to the smallest JXL cjxl can
// make from it, and time both decoding in real browsers.
//
// The transcode discards the JPEG reconstruction data (no `jbrd` box, so no
// container either), so the JXL can't be turned back into the same JPEG. That
// is the deployment case being measured: a JXL served in place of the JPEG.

import { access, constants, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { parseTargets, resolveTarget } from './browsers.js';
import { parseDuration } from './config.js';
import { WARMUP_RUNS, measureDecodeTimes } from './decode.js';
import { run, setToolPath } from './exec.js';
import { hasGainMap, isHdrPng } from './hdr.js';
import { jpegMetadata, smallest } from './jpeg.js';
import { normalise } from './normalise.js';
import { parseRange } from './schedule.js';
import { fileSize } from './score.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff']);

/**
 * jpegli left libjxl for its own repo and Homebrew doesn't package it, so the
 * default is a local build, as for libavif in HDR mode. PATH is the fallback.
 */
const LOCAL_CJPEGLI =
  process.env.CJPEGLI ?? path.join(os.homedir(), 'dev/jpegli/build/tools/cjpegli');

const OPTIONS = {
  widths: { type: 'string', short: 'w', default: '400,800,1200,1600,2000' },
  quality: { type: 'string', short: 'q', default: '80' },
  progressive: { type: 'string', short: 'p', default: '2' },
  'jxl-effort': { type: 'string', default: '1-10' },
  'decode-browsers': { type: 'string' },
  'no-decode-timing': { type: 'boolean' },
  'decode-repeats': { type: 'string', default: '20' },
  'decode-budget': { type: 'string', default: '2s' },
  chrome: { type: 'string' },
  firefox: { type: 'string' },
  chromedriver: { type: 'string' },
  geckodriver: { type: 'string' },
  safaridriver: { type: 'string' },
  out: { type: 'string', default: 'out' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

const HELP = `image-codec-bench jpeg-transcode -- what lossless JPEG -> JPEG XL
transcoding saves, and how both decode in browsers.

For each image, width, quality and progressive level: resize (Lanczos, never
upscaling), encode with cjpegli at 4:2:0 with no metadata, then transcode with
cjxl at every --jxl-effort, keeping the smallest JXL. JPEG reconstruction data
is discarded. Then times createImageBitmap for the JPEG and the kept JXL.

Usage:
  node src/jpeg-transcode.js <image|directory>... [options]

Options:
  -w, --widths RANGE         output widths in px (default 400,800,1200,1600,2000)
  -q, --quality RANGE        cjpegli -q (default 80)
  -p, --progressive RANGE    cjpegli -p, 0 (sequential) .. 2 (default 2, jpegli's own)
  --jxl-effort RANGE         cjxl -e levels to try (default 1-10)
  --decode-browsers LIST     chrome, firefox, safari, safari-preview, all, none
                             (default all: chrome, firefox and safari, skipping
                             any that can't be driven; named browsers are
                             required, but don't cost the others' results)
  --no-decode-timing         sizes only
  --decode-repeats N         createImageBitmap runs per file (default 20)
  --decode-budget DURATION   stop repeating a file past this (default 2s)
  --chrome, --firefox PATH   browser binaries (default Canary / Nightly)
  --chromedriver, --geckodriver, --safaridriver PATH
                             driver overrides
  --out DIR                  output root (default out)
  --quiet                    only print the results table
  -h, --help                 this text

cjpegli is taken from $CJPEGLI, else ~/dev/jpegli/build/tools/cjpegli, else PATH.

Examples:
  node src/jpeg-transcode.js inputs/f1.png -w 400:2000:400 -q 70,80,90
  node src/jpeg-transcode.js inputs --decode-browsers firefox,chrome -p 0,2
`;

function resolveConfig(values, positionals) {
  if (positionals.length === 0) throw new Error('No input given.');
  const config = {
    inputs: positionals.map((p) => path.resolve(p)),
    out: path.resolve(values.out),
    widths: [...new Set(parseRange(values.widths, { integer: true }))].sort((a, b) => a - b),
    qualities: parseRange(values.quality, { integer: true }),
    progressive: parseRange(values.progressive, { integer: true }),
    efforts: parseRange(values['jxl-effort'], { integer: true }),
    decodeBrowsers: values['no-decode-timing'] ? [] : parseTargets(values['decode-browsers'] ?? 'all'),
    // Named browsers are required; 'all' means whichever are installed.
    decodeBrowsersExplicit: Boolean(values['decode-browsers']) && values['decode-browsers'] !== 'all',
    decodeRepeats: Number(values['decode-repeats']),
    decodeBudgetMs: parseDuration(values['decode-budget']),
    browserPaths: { chrome: values.chrome ?? null, firefox: values.firefox ?? null },
    driverPaths: {
      chrome: values.chromedriver ?? null,
      firefox: values.geckodriver ?? null,
      safari: values.safaridriver ?? null,
    },
    quiet: values.quiet === true,
  };
  for (const w of config.widths) if (w < 1) throw new Error(`--widths must be positive (got ${w})`);
  for (const q of config.qualities) {
    if (q < 1 || q > 100) throw new Error(`--quality must be 1..100 (got ${q})`);
  }
  for (const p of config.progressive) {
    if (p < 0 || p > 2) throw new Error(`--progressive must be 0..2 (got ${p})`);
  }
  for (const e of config.efforts) {
    if (e < 1 || e > 10) throw new Error(`--jxl-effort must be 1..10 (got ${e})`);
  }
  if (!Number.isInteger(config.decodeRepeats) || config.decodeRepeats < 1) {
    throw new Error('--decode-repeats must be an integer >= 1');
  }
  return config;
}

async function isExecutable(filePath) {
  return access(filePath, constants.X_OK).then(() => true, () => false);
}

/**
 * Versions of the three tools. cjpegli has no version flag, so a local build
 * is identified by its git commit, as well as its path.
 */
async function toolchain() {
  let cjpegliPath = LOCAL_CJPEGLI;
  if (await isExecutable(LOCAL_CJPEGLI)) setToolPath('cjpegli', LOCAL_CJPEGLI);
  else cjpegliPath = (await run('/usr/bin/which', ['cjpegli'], { allowFailure: true })).stdout.trim();
  if (!cjpegliPath) {
    throw new Error(
      'cjpegli not found. Build it with:\n' +
        '  git clone --recursive https://github.com/google/jpegli ~/dev/jpegli\n' +
        '  cmake -S ~/dev/jpegli -B ~/dev/jpegli/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=OFF\n' +
        '  ninja -C ~/dev/jpegli/build cjpegli\n' +
        'or point $CJPEGLI at a binary.',
    );
  }
  const commit = await run('git', ['-C', path.dirname(cjpegliPath), 'log', '-1', '--format=%h %cs'], {
    allowFailure: true,
  });
  const cjxl = await run('cjxl', ['--version']);
  const magick = await run('magick', ['-version']);
  return {
    cjpegli: { path: cjpegliPath, commit: commit.stdout.trim() || null },
    cjxl: cjxl.stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? cjxl.stdout.trim(),
    magick: magick.stdout.match(/(\d+\.\d+\.\d+(-\d+)?)/)?.[1] ?? null,
  };
}

async function listInputs(inputs) {
  const files = [];
  for (const input of inputs) {
    if ((await stat(input)).isDirectory()) {
      const entries = await readdir(input, { withFileTypes: true });
      files.push(
        ...entries
          .filter((e) => e.isFile() && IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase()))
          .map((e) => path.join(input, e.name))
          .sort(),
      );
    } else {
      files.push(input);
    }
  }
  if (files.length === 0) throw new Error('No images found.');
  return files;
}

/** Resize, encode the JPEG, transcode at every effort. Returns one row. */
async function encodeOne({ reference, width, quality, progressive, efforts, dir, runDir }) {
  const stem = `w${width}-q${quality}-p${progressive}`;
  const jpeg = path.join(dir, `${stem}.jpg`);
  await run('cjpegli', [
    reference.path,
    jpeg,
    '-q', String(quality),
    '--chroma_subsampling=420',
    '-p', String(progressive),
    '--quiet',
  ]);
  // The reference is stripped sRGB, so jpegli has nothing to write. Asserted
  // because metadata bytes would be counted against the JPEG.
  const metadata = jpegMetadata(await readFile(jpeg));
  if (metadata.length > 0) throw new Error(`${jpeg} carries metadata: ${metadata.join(', ')}`);

  const candidates = [];
  for (const effort of efforts) {
    const jxl = path.join(dir, `${stem}-e${effort}.jxl`);
    await run('cjxl', [
      jpeg,
      jxl,
      '--lossless_jpeg=1',
      '-e', String(effort),
      // Without the reconstruction box, cjxl writes a bare codestream.
      '--allow_jpeg_reconstruction=0',
      '--quiet',
    ]);
    candidates.push({ effort, path: jxl, bytes: await fileSize(jxl) });
  }
  const best = smallest(candidates);
  // Only the kept JXL stays on disk.
  for (const c of candidates) if (c !== best) await rm(c.path, { force: true });

  const jpegBytes = await fileSize(jpeg);
  return {
    width: reference.width,
    height: reference.height,
    quality,
    progressive,
    jpeg: { file: path.relative(runDir, jpeg), bytes: jpegBytes, decode: {} },
    jxl: {
      file: path.relative(runDir, best.path),
      bytes: best.bytes,
      effort: best.effort,
      decode: {},
    },
    savingPercent: ((jpegBytes - best.bytes) / jpegBytes) * 100,
    jxlByEffort: Object.fromEntries(candidates.map((c) => [c.effort, c.bytes])),
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

  const versions = await toolchain();
  log(
    `cjpegli ${versions.cjpegli.commit ?? '?'} (${versions.cjpegli.path}), ` +
      `cjxl ${versions.cjxl}, magick ${versions.magick}\n`,
  );

  const files = await listInputs(config.inputs);
  const runDir = path.join(
    config.out,
    files.length === 1 && config.inputs.length === 1
      ? `${path.basename(files[0], path.extname(files[0]))}-jpeg-transcode`
      : 'jpeg-transcode',
  );
  await mkdir(runDir, { recursive: true });
  const jsonPath = path.join(runDir, 'results.json');

  const output = {
    settings: {
      widths: config.widths,
      qualities: config.qualities,
      progressive: config.progressive,
      jxlEfforts: config.efforts,
      chromaSubsampling: '420',
    },
    versions,
    browsers: null,
    images: [],
  };

  // 1. Encode. Fast enough serially, and keeps the machine idle for timing.
  for (const file of files) {
    const name = path.basename(file);
    if (isHdrInput(await readFile(file))) {
      log(`${name}: skipped, HDR input isn't supported here`);
      continue;
    }
    const imageDir = path.join(runDir, path.basename(file, path.extname(file)));
    // Cleared so the directory holds exactly what results.json describes, not
    // a previous run's files (whose kept effort may have differed).
    await rm(imageDir, { recursive: true, force: true });
    await mkdir(imageDir, { recursive: true });
    const image = { file: name, rows: [] };

    for (const width of config.widths) {
      const reference = await normalise(file, path.join(imageDir, `w${width}.png`), { width });
      try {
        if (reference.width < width) {
          log(`${name}: skipping ${width}px, the source is only ${reference.source.width}px wide`);
          continue;
        }
        if (reference.hasAlpha) throw new Error(`${name} has transparency, which JPEG can't carry`);
        image.width ??= reference.source.width;
        image.height ??= reference.source.height;

        for (const quality of config.qualities) {
          for (const progressive of config.progressive) {
            const row = await encodeOne({
              reference, width, quality, progressive, efforts: config.efforts, dir: imageDir, runDir,
            });
            image.rows.push(row);
            log(
              `${name} ${row.width}x${row.height} q${quality} p${progressive}: ` +
                `JPEG ${formatBytes(row.jpeg.bytes)} -> JXL ${formatBytes(row.jxl.bytes)} ` +
                `(e${row.jxl.effort}, ${row.savingPercent.toFixed(1)}% smaller)`,
            );
          }
        }
      } finally {
        await rm(reference.path, { force: true });
      }
    }
    output.images.push(image);
    await writeFile(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
  }

  // 2. Browser decode timing, serial, one browser at a time.
  const entries = output.images.flatMap((image) =>
    image.rows.flatMap((row) =>
      ['jpeg', 'jxl'].map((format) => ({ key: row[format].file, url: row[format].file, target: row[format] })),
    ),
  );
  const browsersUsed = {};
  const failures = [];
  // A browser that can't be driven doesn't cost the others' results: noted,
  // and an error at the end if it was asked for by name.
  const skippedBrowsers = [];
  const skipped = (message) => {
    skippedBrowsers.push(message);
    log(message);
  };
  for (const name of config.decodeBrowsers) {
    const target = await resolveTarget(name, {
      browser: config.browserPaths[name],
      driver: config.driverPaths[name],
    });
    if (target.unavailable) {
      skipped(`Decode timing skipped for ${target.label}: ${target.unavailable}.${target.hint ? ` ${target.hint}` : ''}`);
      continue;
    }
    if (!target.headless) log(`${target.label} has no headless mode: a window will open and take focus.`);
    log(`Decode timing ${entries.length} file(s) in ${target.label}...`);

    const measure = () =>
      measureDecodeTimes({
        target,
        rootDir: runDir,
        targets: entries.map(({ key, url }) => ({ key, url })),
        repeats: config.decodeRepeats,
        budgetMs: config.decodeBudgetMs,
        onProgress: (done, total) => {
          if (!config.quiet && process.stderr.isTTY) {
            process.stderr.write(`\r\x1b[2K${target.label}: decoded ${done}/${total}`);
          }
        },
      });
    let measured;
    try {
      // Once more on failure: Firefox Nightly has been seen to exit at launch
      // ("unexpectedly closed with status 0") straight after a Chrome session,
      // then start fine.
      measured = await measure().catch((error) => {
        log(`${target.label}: ${error.message}; retrying once`);
        return measure();
      });
    } catch (error) {
      skipped(`Decode timing skipped for ${target.label}: ${error.message}${target.setupHint ? `\n  ${target.setupHint}` : ''}`);
      continue;
    } finally {
      if (!config.quiet && process.stderr.isTTY) process.stderr.write('\r\x1b[2K');
    }

    browsersUsed[name] = {
      label: target.label,
      version: measured.version,
      timerGranularityMs: measured.timerGranularityMs ?? null,
    };
    for (const entry of entries) {
      const result = measured.results.get(entry.key);
      if (!result) continue;
      if (result.error) failures.push(`${target.label} / ${entry.key}: ${result.error}`);
      else entry.target.decode[name] = { ...result, browser: measured.version };
    }
  }
  output.browsers = Object.keys(browsersUsed).length
    ? { repeats: config.decodeRepeats, warmup: WARMUP_RUNS, budgetMs: config.decodeBudgetMs, targets: browsersUsed }
    : null;
  await writeFile(jsonPath, `${JSON.stringify(output, null, 2)}\n`);

  const csvPath = path.join(runDir, 'results.csv');
  await writeFile(csvPath, formatCsv(output));

  process.stdout.write(`\n${formatTable(output)}\n`);
  if (failures.length > 0) {
    process.stdout.write(`\nDecode failed for ${failures.length} file(s):\n  ${failures.join('\n  ')}\n`);
  }
  process.stdout.write(`\nResults: ${jsonPath}\n         ${csvPath}\n`);
  if (skippedBrowsers.length > 0 && config.decodeBrowsersExplicit) {
    throw new Error(skippedBrowsers.join('\n'));
  }
  return 0;
}

function isHdrInput(bytes) {
  return hasGainMap(bytes) || isHdrPng(bytes);
}

function formatBytes(bytes) {
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(2)} MB` : `${(bytes / 1e3).toFixed(1)} KB`;
}

const ms = (decode) => (decode ? decode.meanMs.toFixed(2) : '--');

/** A row per output, with the decode mean per browser and format. */
function formatTable(output) {
  const browsers = Object.keys(output.browsers?.targets ?? {});
  const table = [
    [
      'image', 'size', 'q', 'p', 'JPEG', 'JXL', 'saving', 'e',
      ...browsers.flatMap((b) => [`${b} JPEG ms`, `${b} JXL ms`]),
    ],
    ...output.images.flatMap((image) =>
      image.rows.map((row) => [
        image.file,
        `${row.width}x${row.height}`,
        String(row.quality),
        String(row.progressive),
        formatBytes(row.jpeg.bytes),
        formatBytes(row.jxl.bytes),
        `${row.savingPercent.toFixed(1)}%`,
        String(row.jxl.effort),
        ...browsers.flatMap((b) => [ms(row.jpeg.decode[b]), ms(row.jxl.decode[b])]),
      ]),
    ),
  ];
  const widths = table[0].map((_, i) => Math.max(...table.map((row) => row[i].length)));
  return table
    .map((row) => row.map((cell, i) => (i < 2 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  '))
    .join('\n');
}

function formatCsv(output) {
  const browsers = Object.keys(output.browsers?.targets ?? {});
  const header = [
    'image', 'width', 'height', 'quality', 'progressive', 'jpeg_bytes', 'jxl_bytes', 'saving_percent',
    'jxl_effort',
    ...browsers.flatMap((b) => [`${b}_jpeg_mean_ms`, `${b}_jpeg_sd_ms`, `${b}_jxl_mean_ms`, `${b}_jxl_sd_ms`]),
  ];
  const cell = (decode, field) => (decode ? decode[field].toFixed(4) : '');
  const lines = output.images.flatMap((image) =>
    image.rows.map((row) =>
      [
        image.file, row.width, row.height, row.quality, row.progressive, row.jpeg.bytes, row.jxl.bytes,
        row.savingPercent.toFixed(3), row.jxl.effort,
        ...browsers.flatMap((b) => [
          cell(row.jpeg.decode[b], 'meanMs'), cell(row.jpeg.decode[b], 'sdMs'),
          cell(row.jxl.decode[b], 'meanMs'), cell(row.jxl.decode[b], 'sdMs'),
        ]),
      ].join(','),
    ),
  );
  return `${[header.join(','), ...lines].join('\n')}\n`;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`\nError: ${error.message}\n`);
  process.exitCode = 1;
}
