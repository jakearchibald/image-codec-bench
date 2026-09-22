#!/usr/bin/env node
// Entry point: config resolution, doctor, normalise, the two phases, outputs.

import { readFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { ResultsStore, hashFileBytes, shortHash } from './cache.js';
import { HELP, OPTIONS, resolveConfig } from './config.js';
import { decodeIsStale, findBrowser, measureDecodeTimes } from './decode.js';
import { assertToolchain, doctor, formatDoctor, hasWebp } from './doctor.js';
import { measureSpawnOverhead } from './exec.js';
import { losslessSuite } from './lossless.js';
import { normalise } from './normalise.js';
import { readHeader } from './png.js';
import { Progress, formatDuration } from './progress.js';
import { buildReport } from './report/build.js';
import {
  calibrate,
  encodePhase,
  estimateRuntime,
  partitionCached,
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

  // No image *and* no --config means there is nothing to work from; print
  // help. A --config file may carry `input`, so don't bail in that case.
  if (values.help || (positionals.length === 0 && !values.config)) {
    process.stdout.write(HELP);
    return 0;
  }

  const config = await resolveConfig(values, positionals);
  const decodeFailures = [];

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

  // The store accumulates every job ever measured against this reference, which
  // is what makes resume work. That full history lives in its own file so the
  // curated `results.json` can hold just this run's grid.
  const fullResultsPath = path.join(runDir, 'full-results.json');
  const resultsPath = path.join(runDir, 'results.json');
  await migrateLegacyStore({ resultsPath, fullResultsPath });

  const store = new ResultsStore(fullResultsPath);
  await store.load({ force: config.force });

  // 4. Calibrate: one encode per series, for a meaningful first ETA. Series
  //    already timed in full-results.json are seeded from it rather than re-run.
  if (!config.quiet) process.stdout.write(`Calibrating ${series.length} series...\n`);
  const model = await calibrate({
    series,
    config,
    reference,
    tempDir,
    cachedResults: store.jobs,
    log: (message) => {
      if (!config.quiet) process.stdout.write(`  ${message}\n`);
    },
  });
  // Estimate only the work actually left to do, so a resumed run's ETA is
  // right from the first job rather than starting at zero and climbing.
  const { cachedKeys, todo, keys: gridKeys } = partitionCached({
    jobs,
    store,
    referenceHash,
    versions: health.versions,
    config,
  });
  const estimate = estimateRuntime({ jobs: todo, config, model });
  const cachedCount = cachedKeys.size;

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
    browser: null,
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
    tempDir,
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

  // 7. Browser decode timing. Serial and uncontended, for the same reason the
  //    encode phase is: a decode timed on a busy machine is not a timing.
  let browser = null;
  if (config.decodeTiming !== false) {
    browser = await findBrowser(config.chrome);
    if (!browser) {
      if (config.decodeTiming === true) {
        throw new Error(
          'Decode timing was requested but no browser was found. Install Google Chrome ' +
            'Canary, or pass --chrome PATH. Canary is needed because stable Chrome cannot ' +
            'decode JPEG XL.',
        );
      }
      if (!config.quiet) {
        process.stdout.write(
          'Decode timing skipped: Chrome Canary not found (pass --chrome PATH to override).\n',
        );
      }
    }
  }

  if (browser) {
    const scored = store.jobs.filter(
      (job) => job.score !== undefined && gridKeys.has(job.key) && job.bitstream,
    );
    const stale = config.force
      ? scored
      : scored.filter((job) => decodeIsStale(job, browser.version));

    if (!config.quiet) {
      process.stdout.write(
        `Decode timing ${stale.length} image(s) in ${browser.version}` +
          `${stale.length < scored.length ? ` (${scored.length - stale.length} already measured)` : ''}...\n`,
      );
    }

    if (stale.length > 0) {
      const measured = await measureDecodeTimes({
        binary: browser.path,
        rootDir: runDir,
        targets: stale.map((job) => ({ key: job.key, url: job.bitstream })),
        repeats: config.decodeRepeats,
        onProgress: (done, total) => {
          if (!config.quiet && process.stderr.isTTY) {
            process.stderr.write(`\r\x1b[2KDecoded ${done}/${total}`);
          }
        },
      });
      if (!config.quiet && process.stderr.isTTY) process.stderr.write('\r\x1b[2K');

      for (const job of stale) {
        const result = measured.get(job.key);
        if (!result) continue;
        if (result.error) {
          // A decoder that can't read one of our files is worth surfacing, not
          // silently leaving a gap in the chart.
          decodeFailures.push(`${job.codec} q${job.quality} ${job.effortLabel}: ${result.error}`);
          continue;
        }
        job.decode = { ...result, browser: browser.version };
        await store.put(job);
      }
    }
  }

  // Decode timings are only comparable within one browser build, so record it.
  if (store.data.run) {
    store.data.run.browser = browser
      ? { path: browser.path, version: browser.version, repeats: config.decodeRepeats }
      : null;
    await store.flush();
  }

  // 8. Lossless suite, with its hard assertions.
  let losslessRows = store.lossless;
  if (config.lossless) {
    if (!config.quiet) process.stdout.write('Running lossless suite...\n');
    losslessRows = await losslessSuite({
      reference,
      referenceHeader,
      referenceHash,
      versions: health.versions,
      config,
      assetsDir,
      tempDir,
      hasWebp: hasWebp(health),
      cachedRows: store.lossless,
      force: config.force,
      log: (message) => {
        if (!config.quiet) process.stdout.write(`  ${message}\n`);
      },
    });
    await store.putLossless(losslessRows);
  }

  // 9. Outputs.
  //
  // Scoped to *this run's grid*, not everything the store has accumulated.
  // Re-running with a narrower `--avif-speed` used to report the previous run's
  // series too, which quietly changed what the table and charts were about.
  const results = store.jobs.filter(
    (job) => job.score !== undefined && gridKeys.has(job.key),
  );
  const orphaned = store.jobs.filter(
    (job) => job.score !== undefined && !gridKeys.has(job.key),
  ).length;

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

  // results.json is this run: same shape as the store, jobs narrowed to the
  // grid, so the report stays a pure function of the file beside it. Written
  // before the report is built, since the report is generated from it.
  const runData = { ...store.data, jobs: results, lossless: losslessRows ?? [] };
  await writeFile(resultsPath, `${JSON.stringify(runData, null, 2)}\n`);

  const warnings = [
    ...collectWarnings(results, config),
    ...(decodeFailures.length > 0
      ? [`Browser decode failed for ${decodeFailures.length} image(s): ${decodeFailures.join('; ')}`]
      : []),
  ];
  if (warnings.length > 0) {
    process.stdout.write('\nWarnings:\n');
    for (const warning of warnings) process.stdout.write(`  - ${warning}\n`);
  }

  if (config.report) {
    const reportPath = await buildReport({
      runDir,
      data: runData,
      results,
      lossless: losslessRows ?? [],
      warnings,
    });
    process.stdout.write(`\nReport: ${reportPath}\n`);
  }

  process.stdout.write(`Results: ${resultsPath}\n`);
  if (orphaned > 0) {
    process.stdout.write(
      `         (${orphaned} result(s) from other settings kept in ` +
        `${path.basename(fullResultsPath)}, excluded here)\n`,
    );
  }

  await rm(tempDir, { recursive: true, force: true });
  return 0;
}

/**
 * Move a pre-existing `results.json` store to `full-results.json`.
 *
 * Before the split, `results.json` *was* the accumulating store. Leaving it
 * behind would silently orphan the cache and re-encode everything, which for a
 * full-resolution grid is hours of work.
 */
async function migrateLegacyStore({ resultsPath, fullResultsPath }) {
  try {
    await stat(fullResultsPath);
    return; // Already migrated.
  } catch {
    // Not there yet; fall through.
  }
  try {
    const legacy = JSON.parse(await readFile(resultsPath, 'utf8'));
    if (!Array.isArray(legacy?.jobs) || legacy.jobs.length === 0) return;
    await writeFile(fullResultsPath, `${JSON.stringify(legacy, null, 2)}\n`);
  } catch {
    // No legacy file, or unreadable: nothing to carry over.
  }
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
    decodeRepeats: config.decodeRepeats,
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
