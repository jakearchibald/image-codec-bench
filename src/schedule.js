// Series expansion, job ordering, and the cost model (plan.md §5).
//
// Three ideas here, all aimed at making a partial run useful:
//  - bisection order on quality, so an aborted run still has a correctly
//    shaped curve for every series rather than only the low-quality end
//  - interleaving across series, so each round mixes cheap (-s 6) with
//    expensive (-s 0) work and estimation error averages out
//  - cost-weighted progress, so the bar advances at a roughly constant rate

/** Parse `min:max:step`, `a-b`, or an explicit comma list into numbers. */
export function parseRange(spec, { integer = false } = {}) {
  if (typeof spec === 'number') return [spec];
  if (Array.isArray(spec)) return spec.map(Number);

  const text = String(spec).trim();
  if (text.length === 0) throw new Error('Empty range specification');

  if (text.includes(',')) {
    return text
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .flatMap((part) => parseRange(part, { integer }));
  }

  if (text.includes(':')) {
    const parts = text.split(':').map((p) => Number(p.trim()));
    if (parts.some(Number.isNaN)) throw new Error(`Bad range '${spec}'`);
    const [min, max, step = 1] = parts;
    return expand(min, max, step, integer);
  }

  // `a-b` inclusive. Guard against negative numbers being read as a range.
  const dashMatch = text.match(/^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/);
  if (dashMatch) {
    return expand(Number(dashMatch[1]), Number(dashMatch[2]), 1, integer);
  }

  const single = Number(text);
  if (Number.isNaN(single)) throw new Error(`Bad range '${spec}'`);
  return [single];
}

function expand(min, max, step, integer) {
  if (step === 0) throw new Error('Range step must be non-zero');
  const values = [];
  const stride = Math.abs(step);
  if (min <= max) {
    for (let v = min; v <= max + 1e-9; v += stride) values.push(round(v, integer));
  } else {
    for (let v = min; v >= max - 1e-9; v -= stride) values.push(round(v, integer));
  }
  return values;
}

function round(value, integer) {
  const r = Math.round(value * 1e6) / 1e6;
  return integer ? Math.round(r) : r;
}

/**
 * Reorder `[min..max]` as `[min, max, mid, quarter, three-quarter, ...]` by
 * recursive bisection, so any prefix of the result spans the full range.
 */
export function bisectionOrder(values) {
  if (values.length <= 2) return [...values];
  const order = [values[0], values[values.length - 1]];
  const seen = new Set([0, values.length - 1]);
  const queue = [[0, values.length - 1]];
  while (queue.length > 0) {
    const [low, high] = queue.shift();
    const mid = Math.floor((low + high) / 2);
    if (mid !== low && mid !== high && !seen.has(mid)) {
      seen.add(mid);
      order.push(values[mid]);
    }
    if (mid - low > 1) queue.push([low, mid]);
    if (high - mid > 1) queue.push([mid, high]);
  }
  return order;
}

/**
 * A series is codec x effort x depth x yuv -- one line on the charts. The
 * quality axis varies within a series.
 */
export function buildSeries(config) {
  const series = [];
  for (const codecName of config.codecs) {
    const codecConfig = config[codecName];
    if (!codecConfig) continue;
    const depths = codecConfig.depth ?? [8];
    // Codecs with no subsampling axis (JXL) get a single null pass. Accepting a
    // bare value as well as a list keeps older configs working.
    const yuvs = toList(codecConfig.yuv);
    for (const depth of depths) {
      for (const yuv of yuvs) {
        for (const effort of codecConfig.effort) {
          series.push({
            id: seriesId(codecName, effort, depth, yuv),
            codec: codecName,
            effort,
            depth,
            yuv,
            qalpha: codecConfig.qalpha ?? null,
            hdr: Boolean(config.hdr),
            qualities: bisectionOrder(codecConfig.quality),
          });
        }
      }
    }
  }
  return series;
}

/** Normalise an axis that may be absent, a single value, or a list. */
function toList(value) {
  if (value == null) return [null];
  return Array.isArray(value) ? value : [value];
}

export function seriesId(codec, effort, depth, yuv) {
  const parts = [codec, `e${effort}`, `d${depth}`];
  if (yuv) parts.push(`yuv${yuv}`);
  return parts.join('-');
}

/**
 * Flatten series into execution order: round r takes the r-th quality point of
 * every series. Expensive and cheap series therefore alternate throughout.
 */
export function interleave(series) {
  const jobs = [];
  const maxLength = Math.max(0, ...series.map((s) => s.qualities.length));
  for (let round = 0; round < maxLength; round += 1) {
    for (const s of series) {
      if (round >= s.qualities.length) continue;
      jobs.push({
        seriesId: s.id,
        codec: s.codec,
        quality: s.qualities[round],
        effort: s.effort,
        depth: s.depth,
        yuv: s.yuv,
        qalpha: s.qalpha,
        hdr: s.hdr,
        round,
      });
    }
  }
  return jobs;
}

/** Full job list for a config, in execution order. */
export function planJobs(config) {
  const series = buildSeries(config);
  return { series, jobs: interleave(series) };
}

/**
 * Per-series cost estimates, refined by an exponential moving average as real
 * measurements arrive so the ETA self-corrects (plan.md §5).
 */
export class CostModel {
  constructor({ alpha = 0.3 } = {}) {
    this.alpha = alpha;
    this.estimates = new Map();
  }

  /** Seed from the calibration pass. */
  seed(seriesId, mode, ms) {
    this.estimates.set(key(seriesId, mode), ms);
  }

  observe(seriesId, mode, ms) {
    const k = key(seriesId, mode);
    const previous = this.estimates.get(k);
    this.estimates.set(k, previous === undefined ? ms : previous + this.alpha * (ms - previous));
  }

  estimate(seriesId, mode) {
    return this.estimates.get(key(seriesId, mode)) ?? this.fallback();
  }

  fallback() {
    const values = [...this.estimates.values()];
    if (values.length === 0) return 250;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }

  /** Total estimated cost of `jobs` across the given threading modes. */
  totalEstimate(jobs, modes, repeats = 1) {
    let total = 0;
    for (const job of jobs) {
      for (const mode of modes) {
        total += this.estimate(job.seriesId, mode) * repeats;
      }
    }
    return total;
  }
}

function key(seriesId, mode) {
  return `${seriesId}\u0000${mode}`;
}

/**
 * How many repeats a job gets: up to `repeats`, but bail once cumulative time
 * exceeds `budgetMs` so cheap configs get averaged and -s 0 runs once.
 */
export function shouldRepeatAgain({ runsDone, cumulativeMs, repeats, budgetMs }) {
  if (runsDone >= repeats) return false;
  if (runsDone === 0) return true;
  return cumulativeMs < budgetMs;
}
