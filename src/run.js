// Phase 1 (serial, timed encodes) and phase 2 (parallel scoring).
//
// The two-phase split is what makes the timings trustworthy: during phase 1
// nothing else runs, so no scoring work pollutes the measurement. Phase 2 can
// then use every core, because nothing there is being timed (plan.md §3).

import { access, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { jobKey } from './cache.js';
import { getCodec } from './codecs/index.js';
import { run as exec } from './exec.js';
import { formatDuration } from './progress.js';
import { CostModel, planJobs, shouldRepeatAgain } from './schedule.js';
import { decodeAndScore, fileSize, mapConcurrent } from './score.js';

/**
 * Pseudo-mode used by the cost model when timing is disabled, so an untimed
 * run still gets a per-series estimate and a meaningful ETA.
 */
export const UNTIMED = 'untimed';

/**
 * The threading mode used for the bitstream that actually gets measured.
 *
 * aom's output is thread-dependent: `avifenc -j 1` and `-j all` produce
 * *different files* -- verified at -s 0 as 23,408 vs 22,955 bytes, a 2% gap,
 * which is the same order as the codec differences this tool exists to
 * measure. (cjxl is unaffected: identical bytes either way.)
 *
 * So the artefact is always encoded in one fixed mode and the timing sweep
 * encodes to a scratch path. Otherwise whichever timing mode happened to run
 * last would silently redefine every file size and score, and the whole
 * rate-distortion curve would depend on --timing.
 */
export const CANONICAL_THREADS = 'multi';

/**
 * Encode params for a job, as passed to the codec and hashed into the cache
 * key. Exported so the CLI's cached-job count uses exactly the same shape --
 * if these two drifted, resume would silently stop matching.
 */
export function encodeParams(job) {
  const params = {
    quality: job.quality,
    effort: job.effort,
    depth: job.depth,
  };
  if (job.codec === 'avif') {
    params.yuv = job.yuv;
    params.qalpha = job.qalpha === 'match' ? job.quality : Number(job.qalpha);
  }
  return params;
}

/**
 * The cache key for a job. One definition, used by both the planner and the
 * encode loop -- if those two derived it separately and drifted, resume would
 * silently stop matching and every run would re-encode from scratch.
 */
export function keyForJob({ job, referenceHash, versions }) {
  return jobKey({
    referenceHash,
    codec: job.codec,
    params: encodeParams(job),
    // Deliberately NOT keyed on --timing or --repeats: those change what was
    // measured, not what was encoded, so a config re-run with different timing
    // settings is the same job with more (or fewer) measurements. Keying on
    // them would make one config appear as several table rows. This holds only
    // because the artefact is always encoded with CANONICAL_THREADS --
    // otherwise --timing really would change the bytes.
    versions,
    extra: {},
  });
}

/**
 * Split `jobs` into those already fully measured and those still to do.
 *
 * Used for the ETA as well as the skip decision: crediting a cached job's full
 * estimated weight the instant it is skipped would make the progress rate look
 * enormous and the first ETA of a resumed run near-zero.
 *
 * `keys` is every key in the grid, cached or not. The results store accumulates
 * across runs, so this is what distinguishes "in this run's grid" from "measured
 * here at some point with other settings".
 */
export function partitionCached({ jobs, store, referenceHash, versions, config }) {
  const cachedKeys = new Set();
  const keys = new Set();
  const todo = [];
  for (const job of jobs) {
    const key = keyForJob({ job, referenceHash, versions });
    keys.add(key);
    const cached = store.get(key);
    const hasWantedTimings = config.timing.every((m) => cached?.timings?.[m]);
    if (!config.force && cached && cached.score !== undefined && hasWantedTimings) {
      cachedKeys.add(key);
    } else {
      todo.push(job);
    }
  }
  return { cachedKeys, todo, keys };
}

function bitstreamName(job) {
  const parts = [job.codec, `q${job.quality}`, `e${job.effort}`, `d${job.depth}`];
  if (job.codec === 'avif') parts.push(`yuv${job.yuv}`);
  return `${parts.join('-')}.${getCodec(job.codec).extension}`;
}

/**
 * Calibration: one encode per series at the midpoint quality, in every
 * threading mode. Gives a meaningful first ETA and warms the page cache for
 * the reference image (plan.md §5).
 */
export async function calibrate({
  series,
  config,
  reference,
  tempDir,
  cachedResults = [],
  log = () => {},
}) {
  const model = new CostModel();

  // Seed from timings already in results.json before spending anything. A
  // calibration pass costs one encode per series, and for `avif -s 0` at full
  // resolution that is minutes -- paid on every resume, to re-measure
  // something the previous run already recorded.
  const seeded = new Set();
  for (const result of cachedResults) {
    if (!result.seriesId || !result.timings) continue;
    for (const [mode, timing] of Object.entries(result.timings)) {
      if (typeof timing?.bestMs !== 'number') continue;
      model.observe(result.seriesId, mode, timing.bestMs);
      seeded.add(`${result.seriesId}\u0000${mode}`);
    }
  }

  // With `--timing none` there are no threading modes, but we still need a
  // cost estimate for the ETA, so calibrate a single untimed encode.
  const modes = config.timing.length > 0 ? config.timing : [UNTIMED];

  const needed = series.filter((s) => modes.some((m) => !seeded.has(`${s.id}\u0000${m}`)));
  if (needed.length === 0) {
    log('calibration skipped: every series already has timings in full-results.json');
    return model;
  }

  const calibrationDir = path.join(tempDir, 'calibration');
  await mkdir(calibrationDir, { recursive: true });

  for (const s of needed) {
    const codec = getCodec(s.codec);
    const midQuality = s.qualities[Math.floor(s.qualities.length / 2)];
    for (const mode of modes) {
      if (seeded.has(`${s.id}\u0000${mode}`)) continue;
      const output = path.join(calibrationDir, `cal-${s.id}-${mode}.${codec.extension}`);
      const args = codec.buildEncodeArgs({
        input: reference.path,
        output,
        quality: midQuality,
        effort: s.effort,
        depth: s.depth,
        yuv: s.yuv ?? undefined,
        qalpha: s.qalpha ?? undefined,
        threads: mode,
      });
      const { ms } = await exec(codec.encoder, args);
      model.seed(s.id, mode, ms);
      log(`calibrate ${s.id} ${mode}: ${ms.toFixed(0)}ms`);
      await rm(output, { force: true });
    }
  }

  await rm(calibrationDir, { recursive: true, force: true });
  return model;
}

/**
 * Phase 1. Encodes every job serially, timing each threading mode, and writes
 * the bitstream to `assetsDir`. Scoring happens later, in phase 2.
 */
export async function encodePhase({
  jobs,
  config,
  reference,
  referenceHash,
  versions,
  assetsDir,
  tempDir,
  store,
  model,
  progress,
}) {
  await mkdir(assetsDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  const pending = [];
  let skipped = 0;
  let reusedBitstreams = 0;

  for (const job of jobs) {
    const codec = getCodec(job.codec);
    const params = encodeParams(job);
    const key = keyForJob({ job, referenceHash, versions });

    const cached = store.get(key);
    // Skip only if it is scored *and* already carries every timing mode this
    // run asked for; otherwise fall through and measure what is missing.
    const hasWantedTimings = config.timing.every((m) => cached?.timings?.[m]);
    if (cached && !config.force && cached.score !== undefined && hasWantedTimings) {
      skipped += 1;
      // Zero weight: this job costs no time, so crediting its estimate would
      // distort the progress rate and with it the ETA.
      progress?.complete({ weight: 0, jobs: 1 });
      continue;
    }

    const bitstream = path.join(assetsDir, bitstreamName(job));

    // Encoded on a previous run but interrupted before scoring: keep the
    // original timings (re-encoding would throw away real measurements) and
    // just hand it to phase 2.
    if (cached && !config.force && cached.score === undefined) {
      if (await fileExists(bitstream)) {
        reusedBitstreams += 1;
        pending.push({ job, result: cached, bitstream, codec });
        // Already encoded, so no phase-1 time is spent on it either.
        progress?.complete({ weight: 0, jobs: 1 });
        continue;
      }
    }

    const label =
      `${job.codec} q${job.quality} ${codec.effortLabel?.(job.effort) ?? `e${job.effort}`}` +
      ` ${job.depth}bit`;

    const timings = {};
    const scratch = path.join(tempDir, `${bitstreamName(job)}.timing`);

    const encodeTo = (output, threads) =>
      exec(
        codec.encoder,
        codec.buildEncodeArgs({
          input: reference.path,
          output,
          quality: job.quality,
          effort: job.effort,
          depth: job.depth,
          yuv: job.yuv ?? undefined,
          qalpha: job.qalpha ?? undefined,
          threads,
        }),
      );

    // The canonical encode. This one file is what gets sized and scored, and
    // it is always CANONICAL_THREADS regardless of --timing (see above).
    progress?.setCurrent(`${label}  (encode)`);
    const canonical = await encodeTo(bitstream, CANONICAL_THREADS);

    if (config.timing.length === 0) {
      // Quality-only run: the canonical encode is the whole job. This is the
      // fast path -- a timed run re-encodes up to `--repeats` times per mode
      // just to stabilise a number nobody asked for here.
      model.observe(job.seriesId, UNTIMED, canonical.ms);
      progress?.complete({ weight: model.estimate(job.seriesId, UNTIMED), jobs: 0 });
    } else {
      model.observe(job.seriesId, CANONICAL_THREADS, canonical.ms);

      for (const mode of config.timing) {
        const samples = [];
        let cumulative = 0;

        // The canonical encode already timed this mode, so count it rather
        // than paying for a byte-identical encode twice.
        if (mode === CANONICAL_THREADS) {
          samples.push(canonical.ms);
          cumulative = canonical.ms;
        }

        while (
          shouldRepeatAgain({
            runsDone: samples.length,
            cumulativeMs: cumulative,
            repeats: config.repeats,
            budgetMs: config.repeatBudgetMs,
          })
        ) {
          progress?.setCurrent(`${label}  (${mode}, run ${samples.length + 1}/${config.repeats})`);
          // Scratch output: a timing run must never be able to replace the
          // artefact, because for AVIF it would not be the same bytes.
          const { ms } = await encodeTo(scratch, mode);
          samples.push(ms);
          cumulative += ms;
          model.observe(job.seriesId, mode, ms);
        }

        // Best-of-N is the headline figure: benchmark noise is one-sided, so
        // the minimum is the cleaner estimate. Mean is kept so spread stays
        // visible.
        timings[mode] = {
          bestMs: Math.min(...samples),
          meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
          runs: samples.length,
          samplesMs: samples,
          // Which mode produced the file that was sized and scored. Only this
          // one's timing pairs with the recorded bytes; the other is a pure
          // speed measurement of a different (for AVIF) bitstream.
          canonical: mode === CANONICAL_THREADS,
        };

        progress?.complete({ weight: model.estimate(job.seriesId, mode) * samples.length, jobs: 0 });
      }

      await rm(scratch, { force: true });
    }

    const bytes = await fileSize(bitstream);
    const result = {
      key,
      codec: job.codec,
      seriesId: job.seriesId,
      quality: job.quality,
      effort: job.effort,
      effortLabel: codec.effortLabel?.(job.effort) ?? String(job.effort),
      depth: job.depth,
      yuv: job.yuv ?? null,
      qalpha: params.qalpha ?? null,
      bytes,
      bpp: (bytes * 8) / (reference.width * reference.height),
      bitstream: path.relative(path.dirname(assetsDir), bitstream),
      // Merge rather than replace: a later `--timing single` run should add to
      // the multi figures a previous run measured, not discard them.
      timings: { ...(cached?.timings ?? {}), ...timings },
      lossless: false,
    };
    if (cached?.score !== undefined) result.score = cached.score;

    // Persist the encode immediately, before scoring. A single `-s 0` encode
    // can cost minutes at full resolution, so losing phase-1 work to a Ctrl-C
    // would make resume useless exactly when it matters most. The record has
    // no `score` yet, so phase 2 (or a later run) still knows to score it.
    pending.push({ job, result, bitstream, codec });
    await store.put(result);
    progress?.complete({ weight: 0, jobs: 1 });
  }

  return { pending, skipped, reusedBitstreams, encoded: pending.length - reusedBitstreams };
}

/**
 * Phase 2. Decode + score in parallel, deleting each decoded PNG immediately
 * (plan.md §3 -- a 500-job grid of retained decodes runs to gigabytes).
 */
export async function scorePhase({
  pending,
  reference,
  referenceHeader,
  config,
  store,
  tempDir,
  onScored = () => {},
}) {
  await mkdir(tempDir, { recursive: true });

  await mapConcurrent(pending, config.scoreConcurrency, async (entry) => {
    const scored = await decodeAndScore({
      codec: entry.codec,
      bitstream: entry.bitstream,
      reference: reference.path,
      referenceHeader,
      workDir: tempDir,
      keepDecoded: config.keepDecoded,
    });

    Object.assign(entry.result, {
      score: scored.score,
      decodeMs: scored.decodeMs,
      scoreMs: scored.scoreMs,
      strippedChunks: scored.strippedChunks,
    });

    await store.put(entry.result);
    onScored(entry.result);
    return entry.result;
  });

  return pending.map((entry) => entry.result);
}

/** Does the file exist and is it readable? */
async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Total estimated runtime for a plan, used by --dry-run. */
export function estimateRuntime({ jobs, config, model }) {
  let total = 0;
  if (config.timing.length === 0) {
    // One encode per job, no repeats.
    for (const job of jobs) total += model.estimate(job.seriesId, UNTIMED);
    return total;
  }
  for (const job of jobs) {
    for (const mode of config.timing) {
      const per = model.estimate(job.seriesId, mode);
      // Repeats stop once cumulative time passes the budget, so a job costs
      // min(repeats, ceil(budget / per)) runs -- at least one.
      const affordable = Math.max(1, Math.ceil(config.repeatBudgetMs / Math.max(per, 1)));
      total += per * Math.min(config.repeats, affordable);
    }
  }
  return total;
}

export { planJobs, formatDuration };
