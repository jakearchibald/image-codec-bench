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

/** Total estimated cost of one job, across whatever modes are configured. */
function jobWeight(job, config, model) {
  if (config.timing.length === 0) return model.estimate(job.seriesId, UNTIMED);
  return config.timing.reduce((sum, m) => sum + model.estimate(job.seriesId, m), 0);
}

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
export async function calibrate({ series, config, reference, tempDir, log = () => {} }) {
  const model = new CostModel();
  const calibrationDir = path.join(tempDir, 'calibration');
  await mkdir(calibrationDir, { recursive: true });

  // With `--timing none` there are no threading modes, but we still need a
  // cost estimate for the ETA, so calibrate a single untimed encode.
  const modes = config.timing.length > 0 ? config.timing : [UNTIMED];

  for (const s of series) {
    const codec = getCodec(s.codec);
    const midQuality = s.qualities[Math.floor(s.qualities.length / 2)];
    for (const mode of modes) {
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
  store,
  model,
  progress,
}) {
  await mkdir(assetsDir, { recursive: true });
  const pending = [];
  let skipped = 0;
  let reusedBitstreams = 0;

  for (const job of jobs) {
    const codec = getCodec(job.codec);
    const params = encodeParams(job);
    const key = jobKey({
      referenceHash,
      codec: job.codec,
      params,
      versions,
      // Deliberately NOT keyed on --timing or --repeats: those change what was
      // measured, not what was encoded, so a config re-run with different
      // timing settings is the same job with more (or fewer) measurements.
      // Keying on them would make one config appear as several table rows.
      extra: {},
    });

    const cached = store.get(key);
    // Skip only if it is scored *and* already carries every timing mode this
    // run asked for; otherwise fall through and measure what is missing.
    const hasWantedTimings = config.timing.every((m) => cached?.timings?.[m]);
    if (cached && !config.force && cached.score !== undefined && hasWantedTimings) {
      skipped += 1;
      progress?.complete({ weight: jobWeight(job, config, model) });
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
        progress?.complete({ weight: jobWeight(job, config, model), jobs: 1 });
        continue;
      }
    }

    const label =
      `${job.codec} q${job.quality} ${codec.effortLabel?.(job.effort) ?? `e${job.effort}`}` +
      ` ${job.depth}bit`;

    const timings = {};

    if (config.timing.length === 0) {
      // Quality-only run: encode exactly once, all cores, and record no
      // timings. This is the fast path -- a timed run re-encodes the same job
      // up to `--repeats` times per threading mode just to stabilise a number
      // nobody asked for here.
      progress?.setCurrent(`${label}  (untimed)`);
      const args = codec.buildEncodeArgs({
        input: reference.path,
        output: bitstream,
        quality: job.quality,
        effort: job.effort,
        depth: job.depth,
        yuv: job.yuv ?? undefined,
        qalpha: job.qalpha ?? undefined,
        threads: 'multi',
      });
      const { ms } = await exec(codec.encoder, args);
      model.observe(job.seriesId, UNTIMED, ms);
      progress?.complete({ weight: model.estimate(job.seriesId, UNTIMED), jobs: 0 });
    } else {
      for (const mode of config.timing) {
        const samples = [];
        let cumulative = 0;
        let runsDone = 0;

        while (
          shouldRepeatAgain({
            runsDone,
            cumulativeMs: cumulative,
            repeats: config.repeats,
            budgetMs: config.repeatBudgetMs,
          })
        ) {
          progress?.setCurrent(`${label}  (${mode}, run ${runsDone + 1}/${config.repeats})`);
          const args = codec.buildEncodeArgs({
            input: reference.path,
            output: bitstream,
            quality: job.quality,
            effort: job.effort,
            depth: job.depth,
            yuv: job.yuv ?? undefined,
            qalpha: job.qalpha ?? undefined,
            threads: mode,
          });
          const { ms } = await exec(codec.encoder, args);
          samples.push(ms);
          cumulative += ms;
          runsDone += 1;
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
        };

        progress?.complete({ weight: model.estimate(job.seriesId, mode) * samples.length, jobs: 0 });
      }
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
