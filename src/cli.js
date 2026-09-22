#!/usr/bin/env node
// Entry point: config resolution, doctor, normalise, the two phases, outputs.

import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { ResultsStore, hashFileBytes, jobKey, shortHash } from './cache.js';
import { HELP, OPTIONS, resolveConfig } from './config.js';
import { assertToolchain, doctor, formatDoctor, hasWebp } from './doctor.js';
import { measureSpawnOverhead } from './exec.js';
import { losslessSuite } from './lossless.js';
import { normalise } from './normalise.js';
import { readHeader } from './png.js';
import { Progress, formatDuration } from './progress.js';
import { buildReport } from './report/build.js';
import {
  calibrate,
  encodeParams,
  encodePhase,
  estimateRuntime,
  planJobs,
  scorePhase,
} from './run.js';
import { formatLosslessTable, formatTable, losslessToCsv, toCsv } from './table.js';

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }

  const config = await resolveConfig(values, positionals);

  // 1. Toolchain. Runs every invocation: scores and timings are only
  //    comparable within one toolchain version (plan.md §1).
  const health = await doctor();
  if (!config.quiet) process.stdout.write(`${formatDoctor(health)}\n\n`);
  assertToolchain(health);

  // 2. Normalise once. Everything downstream reads this file.
  const inputBytes = await readFile(config.input);
  const stem = path.basename(config.input, path.extname(config.input));
  const runDir = path.join(
    config.out,
    `${stem}-${shortHash(`${hashFileBytes(inputBytes)}:${config.maxPixels}`)}`,
  );
  const assetsDir = path.join(runDir, 'assets');
  const tempDir = path.join(runDir, '.tmp');
  await mkdir(assetsDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });

  const referencePath = path.join(runDir, 'reference.png');
  const reference = await normalise(config.input, referencePath, { maxPixels: config.maxPixels });
  const referenceHeader = readHeader(await readFile(referencePath));
  const referenceHash = hashFileBytes(await readFile(referencePath));

  if (!config.quiet) {
    process.stdout.write(
      `Reference: ${reference.width}x${reference.height} ` +
        `(${reference.megapixels.toFixed(2)} MP), ${reference.depth}-bit, ` +
        `${reference.hasAlpha ? 'RGBA' : 'RGB'}\n`,
    );
    if (reference.hasAlpha) {
      process.stdout.write(
        'Note: image has alpha. Transparent pixels are scored free, so absolute\n' +
          '      scores are inflated and not comparable with opaque images (§2 finding 5).\n',
      );
    }
    process.stdout.write('\n');
  }

  // 3. Plan the grid.
  const { series, jobs } = planJobs(config);

  const store = new ResultsStore(path.join(runDir, 'results.json'));
  await store.load({ force: config.force });

  // 4. Calibrate: one encode per series, for a meaningful first ETA.
  if (!config.quiet) process.stdout.write(`Calibrating ${series.length} series...\n`);
  const model = await calibrate({ series, config, reference, tempDir });
  const estimate = estimateRuntime({ jobs, config, model });

  const cachedCount = jobs.filter((job) => {
    const key = jobKey({
      referenceHash,
      codec: job.codec,
      params: encodeParams(job),
      versions: health.versions,
      // Deliberately NOT keyed on --timing or --repeats: those change what was
      // measured, not what was encoded, so a config re-run with different
      // timing settings is the same job with more (or fewer) measurements.
      // Keying on them would make one config appear as several table rows.
      extra: {},
    });
    const cached = store.get(key);
    return cached && cached.score !== undefined;
  }).length;

  if (!config.quiet) {
    process.stdout.write(
      `Plan: ${jobs.length} jobs across ${series.length} series ` +
        `(${config.timing.length > 0
          ? `${config.timing.join('+')} timing, up to ${config.repeats} repeats`
          : 'untimed: one encode per job'})\n` +
        `Estimated encode time: ${formatDuration(estimate)}` +
        `${cachedCount > 0 ? `  (${cachedCount} already cached)` : ''}\n`,
    );
  }

  if (config.dryRun) {
    process.stdout.write('\nDry run: nothing encoded. Re-run without --dry-run to execute.\n');
    await rm(tempDir, { recursive: true, force: true });
    return 0;
  }

  // Spawn overhead only characterises the timing figures, so there is no
  // point paying for it when nothing is being timed.
  const spawnOverhead = config.timing.length > 0
    ? await measureSpawnOverhead()
    : { bestMs: null, medianMs: null, samples: 0 };

  store.setRunMetadata({
    startedAt: new Date().toISOString(),
    input: config.input,
    inputSha256: hashFileBytes(inputBytes),
    reference: {
      path: path.relative(runDir, referencePath),
      width: reference.width,
      height: reference.height,
      depth: reference.depth,
      channels: reference.channels,
      hasAlpha: reference.hasAlpha,
      megapixels: reference.megapixels,
      sha256: referenceHash,
      strippedChunks: reference.strippedChunks,
    },
    config: serialisableConfig(config),
    tools: health.tools,
    versions: health.versions,
    machine: health.machine,
    spawnOverheadMs: spawnOverhead,
  });
  await store.flush();

  // 5. Phase 1: serial timed encodes. Nothing else runs concurrently.
  const progress = new Progress({
    totalWeight: estimate,
    totalJobs: jobs.length,
    enabled: !config.quiet,
  });

  const { pending, skipped, encoded, reusedBitstreams } = await encodePhase({
    jobs,
    config,
    reference,
    referenceHash,
    versions: health.versions,
    assetsDir,
    store,
    model,
    progress,
  });
  progress.finish(
    `Encoded ${encoded} job(s)` +
      `${reusedBitstreams > 0 ? `, re-scored ${reusedBitstreams} already-encoded` : ''}` +
      `${skipped > 0 ? `, reused ${skipped} cached` : ''} ` +
      `in ${formatDuration(Date.now() - progress.started)}.`,
  );

  // 6. Phase 2: parallel decode + score.
  if (pending.length > 0 && !config.quiet) {
    process.stdout.write(`Scoring ${pending.length} job(s) across ${config.scoreConcurrency} workers...\n`);
  }
  let scoredCount = 0;
  await scorePhase({
    pending,
    reference,
    referenceHeader,
    config,
    store,
    tempDir,
    onScored: () => {
      scoredCount += 1;
      if (!config.quiet && process.stderr.isTTY) {
        process.stderr.write(`\r\x1b[2KScored ${scoredCount}/${pending.length}`);
      }
    },
  });
  if (!config.quiet && process.stderr.isTTY && pending.length > 0) {
    process.stderr.write('\r\x1b[2K');
  }

  // 7. Lossless suite, with its hard assertions.
  let losslessRows = store.lossless;
  if (config.lossless) {
    if (!config.quiet) process.stdout.write('Running lossless suite...\n');
    losslessRows = await losslessSuite({
      reference,
      referenceHeader,
      config,
      assetsDir,
      tempDir,
      hasWebp: hasWebp(health),
      log: (message) => {
        if (!config.quiet) process.stdout.write(`  ${message}\n`);
      },
    });
    await store.putLossless(losslessRows);
  }

  // 8. Outputs.
  const results = store.jobs.filter((job) => job.score !== undefined);
  await writeFile(path.join(runDir, 'results.csv'), toCsv(results, config.timing));
  if (losslessRows?.length) {
    await writeFile(
      path.join(runDir, 'lossless.csv'),
      losslessToCsv(losslessRows, config.timing),
    );
  }

  process.stdout.write(`\n${formatTable(results, config.timing)}\n`);
  if (losslessRows?.length) {
    process.stdout.write(`\nLossless (all bit-exact, all scoring exactly 100):\n`);
    process.stdout.write(`${formatLosslessTable(losslessRows, config.timing)}\n`);
  }

  const warnings = collectWarnings(results, config);
  if (warnings.length > 0) {
    process.stdout.write('\nWarnings:\n');
    for (const warning of warnings) process.stdout.write(`  - ${warning}\n`);
  }

  if (config.report) {
    const reportPath = await buildReport({
      runDir,
      data: store.data,
      results,
      lossless: losslessRows ?? [],
      warnings,
    });
    process.stdout.write(`\nReport: ${reportPath}\n`);
  }

  process.stdout.write(`Results: ${path.join(runDir, 'results.json')}\n`);

  await rm(tempDir, { recursive: true, force: true });
  return 0;
}

function serialisableConfig(config) {
  return {
    codecs: config.codecs,
    avif: config.avif,
    jxl: config.jxl,
    timing: config.timing,
    repeats: config.repeats,
    repeatBudgetMs: config.repeatBudgetMs,
    maxPixels: config.maxPixels,
    scoreConcurrency: config.scoreConcurrency,
    lossless: config.lossless,
  };
}

/**
 * The score ranges of the two codecs must overlap, or the curves cannot be
 * read against each other (plan.md §4).
 */
export function collectWarnings(results, config) {
  const warnings = [];
  const byCodec = new Map();
  for (const result of results) {
    if (result.score == null) continue;
    const entry = byCodec.get(result.codec) ?? { min: Infinity, max: -Infinity };
    entry.min = Math.min(entry.min, result.score);
    entry.max = Math.max(entry.max, result.score);
    byCodec.set(result.codec, entry);
  }

  const codecs = [...byCodec.entries()];
  for (let i = 0; i < codecs.length; i += 1) {
    for (let j = i + 1; j < codecs.length; j += 1) {
      const [nameA, a] = codecs[i];
      const [nameB, b] = codecs[j];
      if (a.max < b.min || b.max < a.min) {
        warnings.push(
          `${nameA} (${a.min.toFixed(1)}..${a.max.toFixed(1)}) and ` +
            `${nameB} (${b.min.toFixed(1)}..${b.max.toFixed(1)}) score ranges do not overlap; ` +
            'widen a --*-quality range so the curves can be compared.',
        );
      }
    }
  }
  return warnings;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`\nError: ${error.message}\n`);
  process.exitCode = 1;
}
