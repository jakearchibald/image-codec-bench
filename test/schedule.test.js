import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CostModel,
  bisectionOrder,
  buildSeries,
  interleave,
  parseRange,
  planJobs,
  shouldRepeatAgain,
} from '../src/schedule.js';

test('parseRange handles min:max:step', () => {
  assert.deepEqual(parseRange('20:90:5'), [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90]);
  assert.deepEqual(parseRange('0:10:5'), [0, 5, 10]);
});

test('parseRange handles a-b inclusive', () => {
  assert.deepEqual(parseRange('0-6'), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(parseRange('7-10'), [7, 8, 9, 10]);
});

test('parseRange handles comma lists and single values', () => {
  assert.deepEqual(parseRange('8,10'), [8, 10]);
  assert.deepEqual(parseRange('4'), [4]);
  assert.deepEqual(parseRange('1,4-6,9'), [1, 4, 5, 6, 9]);
});

test('parseRange does not overshoot the max', () => {
  // 20:90:7 must stop at 90 or below, never emit 91.
  const values = parseRange('20:90:7');
  assert.ok(Math.max(...values) <= 90, `overshot: ${values.join(',')}`);
});

test('parseRange rejects nonsense', () => {
  assert.throws(() => parseRange('abc'), /Bad range/);
  assert.throws(() => parseRange(''), /Empty range/);
  assert.throws(() => parseRange('1:10:0'), /step must be non-zero/);
});

test('bisectionOrder starts with the endpoints, then the midpoint', () => {
  const order = bisectionOrder([10, 20, 30, 40, 50]);
  assert.equal(order[0], 10);
  assert.equal(order[1], 50);
  assert.equal(order[2], 30);
});

test('bisectionOrder is a permutation: every point exactly once', () => {
  const input = parseRange('20:90:5');
  const order = bisectionOrder(input);
  assert.equal(order.length, input.length);
  assert.deepEqual([...order].sort((a, b) => a - b), [...input].sort((a, b) => a - b));
});

test('any prefix of bisectionOrder spans the full range', () => {
  // This is the property that makes an aborted run useful: a partial series
  // still has a correctly-shaped curve, not just the low-quality end.
  const input = parseRange('15:90:5');
  const order = bisectionOrder(input);
  for (let n = 2; n <= order.length; n += 1) {
    const prefix = order.slice(0, n);
    assert.equal(Math.min(...prefix), 15, `prefix of ${n} lost the minimum`);
    assert.equal(Math.max(...prefix), 90, `prefix of ${n} lost the maximum`);
  }
});

test('bisectionOrder handles degenerate inputs', () => {
  assert.deepEqual(bisectionOrder([]), []);
  assert.deepEqual(bisectionOrder([5]), [5]);
  assert.deepEqual(bisectionOrder([5, 9]), [5, 9]);
});

const config = {
  codecs: ['avif', 'jxl'],
  avif: { quality: [30, 60, 90], effort: [0, 6], depth: [8], yuv: '444', qalpha: 'match' },
  jxl: { quality: [30, 60, 90], effort: [7, 9], depth: [8] },
};

test('buildSeries expands codec x effort x depth', () => {
  const series = buildSeries(config);
  assert.equal(series.length, 4);
  assert.deepEqual(series.map((s) => s.id).sort(), [
    'avif-e0-d8-yuv444',
    'avif-e6-d8-yuv444',
    'jxl-e7-d8',
    'jxl-e9-d8',
  ]);
});

test('buildSeries multiplies out multiple depths', () => {
  const series = buildSeries({
    ...config,
    avif: { ...config.avif, depth: [8, 10] },
  });
  assert.equal(series.filter((s) => s.codec === 'avif').length, 4);
});

test('interleave mixes series within each round', () => {
  const series = buildSeries(config);
  const jobs = interleave(series);
  // Round 0 must contain one job from every series, so cheap and expensive
  // work alternates instead of all the -s 0 jobs landing at the end.
  const round0 = jobs.filter((j) => j.round === 0);
  assert.equal(round0.length, series.length);
  assert.equal(new Set(round0.map((j) => j.seriesId)).size, series.length);
});

test('interleave covers the whole grid exactly once', () => {
  const { series, jobs } = planJobs(config);
  const expected = series.reduce((sum, s) => sum + s.qualities.length, 0);
  assert.equal(jobs.length, expected);
  const keys = jobs.map((j) => `${j.seriesId}:${j.quality}`);
  assert.equal(new Set(keys).size, jobs.length, 'duplicate job in the grid');
});

test('interleave starts each series at its range endpoints', () => {
  const { jobs } = planJobs(config);
  const firstAvif = jobs.find((j) => j.seriesId === 'avif-e0-d8-yuv444');
  assert.equal(firstAvif.quality, 30);
});

test('interleave tolerates series of differing length', () => {
  const jobs = interleave([
    { id: 'a', codec: 'avif', effort: 0, depth: 8, yuv: '444', qalpha: 'match', qualities: [10] },
    { id: 'b', codec: 'jxl', effort: 7, depth: 8, yuv: null, qalpha: null, qualities: [10, 20, 30] },
  ]);
  assert.equal(jobs.length, 4);
  assert.equal(jobs.filter((j) => j.seriesId === 'a').length, 1);
});

test('CostModel seeds from calibration and refines with an EMA', () => {
  const model = new CostModel({ alpha: 0.5 });
  model.seed('s', 'multi', 100);
  assert.equal(model.estimate('s', 'multi'), 100);
  model.observe('s', 'multi', 200);
  assert.equal(model.estimate('s', 'multi'), 150);
  model.observe('s', 'multi', 150);
  assert.equal(model.estimate('s', 'multi'), 150);
});

test('CostModel keeps threading modes separate', () => {
  const model = new CostModel();
  model.seed('s', 'single', 600);
  model.seed('s', 'multi', 200);
  assert.equal(model.estimate('s', 'single'), 600);
  assert.equal(model.estimate('s', 'multi'), 200);
});

test('CostModel falls back to the mean for an unseen series', () => {
  const model = new CostModel();
  model.seed('a', 'multi', 100);
  model.seed('b', 'multi', 300);
  assert.equal(model.estimate('unseen', 'multi'), 200);
});

test('shouldRepeatAgain always allows the first run', () => {
  assert.equal(
    shouldRepeatAgain({ runsDone: 0, cumulativeMs: 0, repeats: 3, budgetMs: 2000 }),
    true,
  );
});

test('shouldRepeatAgain stops at the repeat count', () => {
  assert.equal(
    shouldRepeatAgain({ runsDone: 3, cumulativeMs: 10, repeats: 3, budgetMs: 2000 }),
    false,
  );
});

test('shouldRepeatAgain bails out once the budget is spent (so -s 0 runs once)', () => {
  // A single 6s encode has already blown a 2s budget: no repeats.
  assert.equal(
    shouldRepeatAgain({ runsDone: 1, cumulativeMs: 6000, repeats: 3, budgetMs: 2000 }),
    false,
  );
  // A cheap 30ms encode gets averaged.
  assert.equal(
    shouldRepeatAgain({ runsDone: 1, cumulativeMs: 30, repeats: 3, budgetMs: 2000 }),
    true,
  );
});

test('estimateRuntime counts one encode per job when timing is off', async () => {
  const { estimateRuntime, UNTIMED } = await import('../src/run.js');
  const model = new CostModel();
  const { jobs } = planJobs(config);
  for (const job of jobs) model.seed(job.seriesId, UNTIMED, 100);

  const untimed = estimateRuntime({
    jobs,
    config: { timing: [], repeats: 3, repeatBudgetMs: 2000 },
    model,
  });
  // No repeats and no threading sweep: exactly one encode each.
  assert.equal(untimed, jobs.length * 100);
});

test('estimateRuntime is larger with timing than without', async () => {
  const { estimateRuntime, UNTIMED } = await import('../src/run.js');
  const model = new CostModel();
  const { jobs } = planJobs(config);
  for (const job of jobs) {
    model.seed(job.seriesId, UNTIMED, 100);
    model.seed(job.seriesId, 'single', 100);
    model.seed(job.seriesId, 'multi', 100);
  }
  const base = { repeats: 3, repeatBudgetMs: 2000 };
  const untimed = estimateRuntime({ jobs, config: { ...base, timing: [] }, model });
  const timed = estimateRuntime({ jobs, config: { ...base, timing: ['single', 'multi'] }, model });
  assert.ok(timed > untimed, `expected timed (${timed}) > untimed (${untimed})`);
});
