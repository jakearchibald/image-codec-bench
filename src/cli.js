#!/usr/bin/env node
// Entry point: config resolution, doctor, normalise, the two phases, outputs.

import { readFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { ResultsStore, hashFileBytes, shortHash } from './cache.js';
import { HELP, OPTIONS, resolveConfig } from './config.js';
import { resolveTarget } from './browsers.js';
import {
  DECODE_SCHEMA,
  WARMUP_RUNS,
  cleanDecodeMap,
  dropDecodeFromData,
  measureDecodeTimes,
} from './decode.js';
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

  // A maintenance action, not a run: no toolchain, no encoding, no browser.
  if (config.dropDecode.length > 0) {
    return dropDecodeCommand(config);
  }

  // 1. Toolchain. Runs every invocation: scores and timings are only
  //    comparable within one toolchain version (plan.md §1).
  const health = await doctor();
  if (!config.quiet) process.stdout.write(`${formatDoctor(health)}\n\n`);
  assertToolchain(health);

  // 2. Normalise once. Everything downstream reads this file.
  const inputBytes = await readFile(config.input);
  const runDir = await runDirFor(config, inputBytes);
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
    browsers: null,
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

  // 7. Lossless suite, with its hard assertions. Runs before decode timing so
  //    its bitstreams exist by then and one browser launch covers everything.
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

  // 8. Browser decode timing, once per configured browser. Serial and
  //    uncontended, for the same reason the encode phase is: a decode timed on
  //    a busy machine is not a timing.
  const browsersUsed = {};
  for (const name of config.decodeBrowsers) {
    const target = await resolveTarget(name, {
      browser: config.browserPaths[name],
      driver: config.driverPaths[name],
    });

    if (target.unavailable) {
      const message = `Decode timing skipped for ${target.label}: ${target.unavailable}.${target.hint ? ` ${target.hint}` : ''}`;
      // Explicitly asked for and not available is an error; the default set is
      // best-effort, so a missing browser only costs a note.
      if (config.decodeBrowsersExplicit) throw new Error(message);
      if (!config.quiet) process.stdout.write(`${message}\n`);
      continue;
    }

    if (!target.headless && !config.quiet) {
      process.stdout.write(
        `  ${target.label} has no headless mode: a window will open and take focus.\n`,
      );
    }

    // Lossy grid and lossless rows in one pass. The lossless numbers matter on
    // their own terms: a format can win on lossless size and lose on the time
    // it costs to get the pixels back.
    const lossyTargets = store.jobs
      .filter((job) => job.score !== undefined && gridKeys.has(job.key) && job.bitstream)
      .map((job) => ({
        kind: 'job',
        row: job,
        key: job.key,
        url: job.bitstream,
        label: `${job.codec} q${job.quality} ${job.effortLabel}`,
      }));

    const losslessTargets = (losslessRows ?? [])
      .filter((row) => !row.skipped)
      // The source-PNG row has no bitstream of its own; point it at the
      // reference so the table carries a familiar decode baseline.
      .map((row) => ({
        kind: 'lossless',
        row,
        key: `lossless:${row.codec}`,
        url: row.bitstream ?? (row.isSource ? store.data.run.reference.path : null),
        label: row.label ?? row.codec,
      }))
      .filter((entry) => entry.url);

    const all = [...lossyTargets, ...losslessTargets];

    // The browser version is only known once a session is open, so a first
    // pass measures everything whose stored version is missing or different.
    // Nothing to do at all is decided after the probe below.
    let measuredVersion = null;
    let stale = all;

    if (!config.force) {
      // Cheap pre-filter on the stored version: if every row already carries a
      // measurement, open one short session just to check the version matches.
      const anyMissing = all.some((entry) => !entry.row.decode?.[name]);
      if (!anyMissing) {
        const versions = new Set(all.map((entry) => entry.row.decode[name].browser));
        const schemas = new Set(all.map((entry) => entry.row.decode[name].schema));
        if (versions.size === 1 && schemas.size === 1 && schemas.has(DECODE_SCHEMA)) {
          const probe = await measureDecodeTimes({
            target,
            rootDir: runDir,
            targets: [all[0]].map(({ key, url }) => ({ key, url })),
            repeats: 1,
            warmup: 0,
          }).catch(() => null);
          if (!probe) {
            // Can't confirm the version, so fall through and re-measure, which
            // will surface the real error with its setup hint.
            measuredVersion = null;
          } else {
          if (probe.version === [...versions][0]) {
            browsersUsed[name] = {
              label: target.label,
              version: probe.version,
              timerGranularityMs: probe.timerGranularityMs ?? null,
            };
            if (!config.quiet) {
              process.stdout.write(
                `Decode timing ${target.label}: all ${all.length} already measured in ${probe.version}.\n`,
              );
            }
            continue;
          }
          measuredVersion = probe.version;
          }
        }
      }
    }

    if (!config.quiet) {
      process.stdout.write(`Decode timing ${all.length} image(s) in ${target.label}...\n`);
    }

    let measured;
    try {
      measured = await measureDecodeTimes({
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
    } catch (error) {
      if (!config.quiet && process.stderr.isTTY) process.stderr.write('\r\x1b[2K');
      // A driver that refuses a session usually needs a one-off setup step, and
      // the driver's own message rarely says which. Attach the hint.
      const message =
        `${target.label}: ${error.message}` +
        (target.setupHint ? `\n  ${target.setupHint}` : '');
      if (config.decodeBrowsersExplicit) throw new Error(message);
      if (!config.quiet) process.stdout.write(`Decode timing skipped — ${message}\n`);
      continue;
    }
    if (!config.quiet && process.stderr.isTTY) process.stderr.write('\r\x1b[2K');

    browsersUsed[name] = {
      label: target.label,
      version: measured.version ?? measuredVersion,
      timerGranularityMs: measured.timerGranularityMs ?? null,
    };

    let losslessTouched = false;
    for (const entry of stale) {
      const result = measured.results.get(entry.key);
      if (!result) continue;
      if (result.error) {
        // A decoder that can't read one of our files is worth surfacing, not
        // silently leaving a gap in the chart.
        decodeFailures.push(`${target.label} / ${entry.label}: ${result.error}`);
        continue;
      }
      entry.row.decode = {
        // Cleaned, not merged blindly: a row measured under schema 2 has flat
        // fields that would otherwise sit alongside the browser keys forever.
        ...cleanDecodeMap(entry.row.decode),
        [name]: { ...result, browser: measured.version },
      };
      if (entry.kind === 'job') await store.put(entry.row);
      else losslessTouched = true;
    }
    if (losslessTouched) await store.putLossless(losslessRows);
  }

  // Decode timings are only comparable within one browser build, so record
  // which build produced each set.
  if (store.data.run) {
    store.data.run.browsers = Object.keys(browsersUsed).length
      ? {
          repeats: config.decodeRepeats,
          warmup: WARMUP_RUNS,
          budgetMs: config.decodeBudgetMs,
          targets: browsersUsed,
        }
      : null;
    await store.flush();
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

/**
 * The output directory for an input. Keyed on the image bytes and the downscale
 * setting, so the same source always lands in the same place.
 */
async function runDirFor(config, inputBytes) {
  const stem = path.basename(config.input, path.extname(config.input));
  return path.join(
    config.out,
    `${stem}-${shortHash(`${hashFileBytes(inputBytes)}:${config.maxPixels}`)}`,
  );
}

/**
 * `--drop-decode`: delete stored decode measurements so the next run
 * re-measures them.
 *
 * Deliberately drops and exits rather than dropping and re-measuring. "Remove
 * these so they regenerate" and "re-measure them now" are different intents,
 * and silently doing the second would spend minutes of browser time nobody
 * asked for.
 */
async function dropDecodeCommand(config) {
  const inputBytes = await readFile(config.input);
  const runDir = await runDirFor(config, inputBytes);

  const totals = {};
  let touched = 0;

  // Both files: `full-results.json` is the cache the next run consults, and
  // `results.json` is what the report is built from. Editing only one leaves
  // the two disagreeing.
  for (const name of ['full-results.json', 'results.json']) {
    const file = path.join(runDir, name);
    let data;
    try {
      data = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(`Could not read ${file}: ${error.message}`);
    }

    const removed = dropDecodeFromData(data, config.dropDecode);
    if (Object.keys(removed).length === 0) continue;

    await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
    touched += 1;
    for (const [browser, count] of Object.entries(removed)) {
      totals[browser] = Math.max(totals[browser] ?? 0, count);
    }
  }

  if (touched === 0) {
    process.stdout.write(
      `No stored decode results to remove in ${runDir}.\n` +
        `Wanted: ${config.dropDecode.join(', ')}.\n`,
    );
    return 0;
  }

  const summary = Object.entries(totals)
    .map(([browser, count]) => `${browser} (${count} row${count === 1 ? '' : 's'})`)
    .join(', ');
  process.stdout.write(
    `Removed decode results from ${runDir}:\n  ${summary}\n` +
      'Scores, encode timings and bitstreams are untouched, so a re-run only ' +
      're-measures decode:\n' +
      `  node src/cli.js ${config.input} --decode-browsers ${
        config.dropDecode.includes('all') ? 'all' : config.dropDecode.join(',')
      }\n`,
  );
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
    decodeRepeats: config.decodeRepeats,
    decodeBudgetMs: config.decodeBudgetMs,
    decodeBrowsers: config.decodeBrowsers,
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
