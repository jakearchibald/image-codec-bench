#!/usr/bin/env node
// JPEG -> JPEG XL lossless transcoding: what it saves, and what it costs to
// decode. For each input, width, quality and progressive level, encode a
// jpegli JPEG (4:2:0, no metadata), transcode it to the smallest JXL cjxl can
// make from it, and time both decoding in real browsers.
//
// The transcode discards the JPEG reconstruction data (no `jbrd` box, so no
// container either), so the JXL can't be turned back into the same JPEG. That
// is the deployment case being measured: a JXL served in place of the JPEG.
//
// With --jixel-effort, jixel (tools/cjixel --jpeg) transcodes the same JPEG
// too, keeping its smallest speed. Both carry the same DCT coefficients, so
// they decode to the same pixels; only the entropy coding differs.
//
// A re-run reuses what an earlier one in the same directory measured, when the
// settings and tool versions match and cjpegli reproduces the JPEG byte for
// byte: its transcodes, and browser timings from the same browser build.

import { access, constants, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { parseTargets, resolveTarget } from './browsers.js';
import { parseDuration } from './config.js';
import * as jixel from './codecs/jixel.js';
import { WARMUP_RUNS, decodeIsStale, measureDecodeTimes } from './decode.js';
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
  'jixel-effort': { type: 'string' },
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
  --jixel-effort RANGE       also transcode with jixel at these speeds (1-6),
                             keeping its smallest (default: no jixel)
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
    jixelEfforts: values['jixel-effort'] ? parseRange(values['jixel-effort'], { integer: true }) : [],
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
  for (const s of config.jixelEfforts) {
    if (s < 1 || s > 6) throw new Error(`--jixel-effort must be 1..6 (got ${s})`);
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
async function toolchain({ withJixel = false, log = () => {} } = {}) {
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
  const versions = {
    cjpegli: { path: cjpegliPath, commit: commit.stdout.trim() || null },
    cjxl: cjxl.stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? cjxl.stdout.trim(),
    magick: magick.stdout.match(/(\d+\.\d+\.\d+(-\d+)?)/)?.[1] ?? null,
  };
  if (withJixel) {
    setToolPath('cjixel', await jixel.ensureEncoder({ log }));
    // The whole line: it names the jixel git rev.
    versions.cjixel = (await run('cjixel', ['--version'])).stdout.trim();
  }
  return versions;
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

/**
 * Resize, encode the JPEG, transcode at every effort. Returns one row.
 * `previous` is the same row from an earlier run, if that run's settings and
 * tools match: its transcodes are kept when the new JPEG is byte-identical.
 */
async function encodeOne({ reference, width, quality, progressive, efforts, jixelEfforts, dir, runDir, previous, reuseJixel }) {
  const stem = `w${width}-q${quality}-p${progressive}`;
  const jpeg = path.join(dir, `${stem}.jpg`);
  const fresh = path.join(dir, `${stem}.new.jpg`);
  await run('cjpegli', [
    reference.path,
    fresh,
    '-q', String(quality),
    '--chroma_subsampling=420',
    '-p', String(progressive),
    '--quiet',
  ]);
  // The reference is stripped sRGB, so jpegli has nothing to write. Asserted
  // because metadata bytes would be counted against the JPEG.
  const jpegData = await readFile(fresh);
  const metadata = jpegMetadata(jpegData);
  if (metadata.length > 0) throw new Error(`${jpeg} carries metadata: ${metadata.join(', ')}`);

  const same = previous && (await readFile(jpeg).then((old) => old.equals(jpegData), () => false));
  await rename(fresh, jpeg);
  const exists = (file) => stat(path.join(runDir, file)).then(() => true, () => false);
  const keptJxl = same && (await exists(previous.jxl.file)) ? previous : null;
  const keptJixel = same && reuseJixel && previous.jixel && (await exists(previous.jixel.file)) ? previous : null;

  const row = keptJxl
    ? { ...previous, jpeg: { ...previous.jpeg }, jxl: { ...previous.jxl }, jixel: undefined }
    : await transcodeCjxl({ jpeg, stem, efforts, dir, runDir, reference, quality, progressive });
  if (jixelEfforts.length > 0) {
    Object.assign(row, keptJixel
      ? { jixel: previous.jixel, jixelSavingPercent: previous.jixelSavingPercent, jixelByEffort: previous.jixelByEffort }
      : await transcodeJixel({ jpeg, stem, efforts: jixelEfforts, dir, runDir, jpegBytes: row.jpeg.bytes }));
  } else {
    delete row.jixel;
  }
  row.reused = [keptJxl && 'cjxl', keptJixel && 'jixel'].filter(Boolean);
  return row;
}

/** cjxl at every effort, keeping the smallest; the JPEG part of a row too. */
async function transcodeCjxl({ jpeg, stem, efforts, dir, runDir, reference, quality, progressive }) {
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

/** jixel at every speed, keeping the smallest. Also no reconstruction data. */
async function transcodeJixel({ jpeg, stem, efforts, dir, runDir, jpegBytes }) {
  const candidates = [];
  for (const effort of efforts) {
    const jxl = path.join(dir, `${stem}-jixel-s${effort}.jxl`);
    await run('cjixel', [jpeg, jxl, '--jpeg', '-s', String(effort)]);
    candidates.push({ effort, path: jxl, bytes: await fileSize(jxl) });
  }
  const best = smallest(candidates);
  for (const c of candidates) if (c !== best) await rm(c.path, { force: true });
  return {
    jixel: { file: path.relative(runDir, best.path), bytes: best.bytes, effort: best.effort, decode: {} },
    jixelSavingPercent: ((jpegBytes - best.bytes) / jpegBytes) * 100,
    jixelByEffort: Object.fromEntries(candidates.map((c) => [c.effort, c.bytes])),
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

  const versions = await toolchain({ withJixel: config.jixelEfforts.length > 0, log });
  log(
    `cjpegli ${versions.cjpegli.commit ?? '?'} (${versions.cjpegli.path}), ` +
      `cjxl ${versions.cjxl}, magick ${versions.magick}` +
      `${versions.cjixel ? `, ${versions.cjixel}` : ''}\n`,
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
      ...(config.jixelEfforts.length > 0 ? { jixelEfforts: config.jixelEfforts } : {}),
      chromaSubsampling: '420',
    },
    versions,
    browsers: null,
    images: [],
  };

  // An earlier run's rows are reusable when it made the JPEGs and cjxl
  // transcodes the same way; its jixel rows also need the same jixel settings.
  const previous = await readFile(jsonPath, 'utf8').then(JSON.parse, () => null);
  const sameTools = (a, b, keys) => keys.every((k) => JSON.stringify(a?.[k]) === JSON.stringify(b?.[k]));
  const reuseRows =
    previous &&
    sameTools(previous.settings, output.settings, ['jxlEfforts', 'chromaSubsampling']) &&
    sameTools(previous.versions, versions, ['cjpegli', 'cjxl', 'magick']);
  const reuseJixel =
    reuseRows &&
    sameTools(previous.settings, output.settings, ['jixelEfforts']) &&
    sameTools(previous.versions, versions, ['cjixel']);
  if (reuseRows) log(`Reusing transcodes and decode timings from ${jsonPath} where the JPEG comes out identical.`);
  const previousRow = (file, row) =>
    reuseRows
      ? previous.images.find((i) => i.file === file)?.rows.find(
          (r) => r.jpeg.file.endsWith(`/w${row.width}-q${row.quality}-p${row.progressive}.jpg`),
        ) ?? null
      : null;

  // 1. Encode. Fast enough serially, and keeps the machine idle for timing.
  for (const file of files) {
    const name = path.basename(file);
    if (isHdrInput(await readFile(file))) {
      log(`${name}: skipped, HDR input isn't supported here`);
      continue;
    }
    const imageDir = path.join(runDir, path.basename(file, path.extname(file)));
    // Without reuse, cleared up front; either way, anything results.json
    // doesn't describe is removed once the image is done.
    if (!reuseRows) await rm(imageDir, { recursive: true, force: true });
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
              reference, width, quality, progressive, efforts: config.efforts, jixelEfforts: config.jixelEfforts,
              dir: imageDir, runDir, previous: previousRow(name, { width, quality, progressive }), reuseJixel,
            });
            const { reused } = row;
            delete row.reused;
            image.rows.push(row);
            log(
              `${name} ${row.width}x${row.height} q${quality} p${progressive}: ` +
                `JPEG ${formatBytes(row.jpeg.bytes)} -> JXL ${formatBytes(row.jxl.bytes)} ` +
                `(e${row.jxl.effort}, ${row.savingPercent.toFixed(1)}% smaller)` +
                (row.jixel
                  ? `, jixel ${formatBytes(row.jixel.bytes)} (s${row.jixel.effort}, ${row.jixelSavingPercent.toFixed(1)}% smaller)`
                  : '') +
                (reused.length ? ` [reused ${reused.join(', ')}]` : ''),
            );
          }
        }
      } finally {
        await rm(reference.path, { force: true });
      }
    }
    const kept = new Set(image.rows.flatMap((row) => [row.jpeg.file, row.jxl.file, row.jixel?.file].filter(Boolean)));
    for (const entry of await readdir(imageDir)) {
      const rel = path.relative(runDir, path.join(imageDir, entry));
      if (!kept.has(rel)) await rm(path.join(imageDir, entry), { force: true });
    }
    output.images.push(image);
    await writeFile(jsonPath, `${JSON.stringify(output, null, 2)}\n`);
  }

  // 2. Browser decode timing, serial, one browser at a time.
  const entries = output.images.flatMap((image) =>
    image.rows.flatMap((row) =>
      ['jpeg', 'jxl', 'jixel']
        .filter((format) => row[format])
        .map((format) => ({ key: row[format].file, url: row[format].file, target: row[format] })),
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

    // Files already measured in this browser build keep their timings: one
    // short session reads the version, then only the rest are timed.
    let stale = entries;
    let probedVersion = null;
    let probedGranularity = null;
    const measuredOne = entries.find((entry) => entry.target.decode[name]);
    if (measuredOne) {
      const probe = await measureDecodeTimes({
        target, rootDir: runDir, targets: [{ key: measuredOne.key, url: measuredOne.url }], repeats: 1, warmup: 0,
      }).catch(() => null);
      if (probe) {
        probedVersion = probe.version;
        probedGranularity = probe.timerGranularityMs ?? null;
        stale = entries.filter((entry) => decodeIsStale(entry.target, name, probe.version));
      }
    }
    if (stale.length === 0) {
      browsersUsed[name] = { label: target.label, version: probedVersion, timerGranularityMs: probedGranularity };
      log(`Decode timing ${target.label}: all ${entries.length} already measured in ${probedVersion}.`);
      continue;
    }
    const keptCount = entries.length - stale.length;
    log(
      `Decode timing ${stale.length} file(s) in ${target.label}` +
        `${keptCount > 0 ? ` (${keptCount} already measured in ${probedVersion})` : ''}...`,
    );

    const measure = () =>
      measureDecodeTimes({
        target,
        rootDir: runDir,
        targets: stale.map(({ key, url }) => ({ key, url })),
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
    for (const entry of stale) {
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

const hasJixel = (output) => output.images.some((image) => image.rows.some((row) => row.jixel));

/** A row per output, with the decode mean per browser and format. */
function formatTable(output) {
  const browsers = Object.keys(output.browsers?.targets ?? {});
  const withJixel = hasJixel(output);
  const table = [
    [
      'image', 'size', 'q', 'p', 'JPEG', 'JXL', 'saving', 'e',
      ...(withJixel ? ['jixel', 'saving', 's'] : []),
      ...browsers.flatMap((b) => [`${b} JPEG ms`, `${b} JXL ms`, ...(withJixel ? [`${b} jixel ms`] : [])]),
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
        ...(withJixel
          ? row.jixel
            ? [formatBytes(row.jixel.bytes), `${row.jixelSavingPercent.toFixed(1)}%`, String(row.jixel.effort)]
            : ['--', '--', '--']
          : []),
        ...browsers.flatMap((b) => [
          ms(row.jpeg.decode[b]), ms(row.jxl.decode[b]), ...(withJixel ? [ms(row.jixel?.decode[b])] : []),
        ]),
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
  const withJixel = hasJixel(output);
  const header = [
    'image', 'width', 'height', 'quality', 'progressive', 'jpeg_bytes', 'jxl_bytes', 'saving_percent',
    'jxl_effort',
    ...(withJixel ? ['jixel_bytes', 'jixel_saving_percent', 'jixel_speed'] : []),
    ...browsers.flatMap((b) => [
      `${b}_jpeg_mean_ms`, `${b}_jpeg_sd_ms`, `${b}_jxl_mean_ms`, `${b}_jxl_sd_ms`,
      ...(withJixel ? [`${b}_jixel_mean_ms`, `${b}_jixel_sd_ms`] : []),
    ]),
  ];
  const cell = (decode, field) => (decode ? decode[field].toFixed(4) : '');
  const lines = output.images.flatMap((image) =>
    image.rows.map((row) =>
      [
        image.file, row.width, row.height, row.quality, row.progressive, row.jpeg.bytes, row.jxl.bytes,
        row.savingPercent.toFixed(3), row.jxl.effort,
        ...(withJixel ? [row.jixel?.bytes ?? '', row.jixelSavingPercent?.toFixed(3) ?? '', row.jixel?.effort ?? ''] : []),
        ...browsers.flatMap((b) => [
          cell(row.jpeg.decode[b], 'meanMs'), cell(row.jpeg.decode[b], 'sdMs'),
          cell(row.jxl.decode[b], 'meanMs'), cell(row.jxl.decode[b], 'sdMs'),
          ...(withJixel ? [cell(row.jixel?.decode[b], 'meanMs'), cell(row.jixel?.decode[b], 'sdMs')] : []),
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
