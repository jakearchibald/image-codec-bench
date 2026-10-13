import assert from 'node:assert/strict';
import test from 'node:test';

import { searchQuality } from '../src/search.js';
import { targetFileName } from '../src/target.js';

/** A probe over a fixed score curve, counting calls. */
function curve(fn) {
  const probe = async (q) => {
    probe.calls += 1;
    return fn(q);
  };
  probe.calls = 0;
  return probe;
}

test('finds the lowest quality reaching the target', async () => {
  const probe = curve((q) => q * 0.9);
  const hit = await searchQuality({ min: 0, max: 100, step: 1, target: 63, probe });
  assert.deepEqual(hit, { quality: 70, score: 63 });
  assert.ok(probe.calls <= 8, `took ${probe.calls} probes`);
});

test('works on a fractional grid', async () => {
  const probe = curve((q) => Math.sqrt(q) * 10);
  const hit = await searchQuality({ min: 0, max: 100, step: 0.1, target: 75, probe });
  // sqrt(56.3) * 10 = 75.03; sqrt(56.2) * 10 = 74.97.
  assert.equal(hit.quality, 56.3);
  assert.ok(hit.score >= 75);
});

test('returns null when the top of the grid falls short', async () => {
  const probe = curve((q) => q * 0.5);
  assert.equal(await searchQuality({ min: 0, max: 100, step: 1, target: 80, probe }), null);
});

test('reuses scores known from earlier targets', async () => {
  const probe = curve((q) => q);
  const known = new Map();
  await searchQuality({ min: 0, max: 100, step: 1, target: 60, probe, known });
  const before = probe.calls;
  const hit = await searchQuality({ min: 0, max: 100, step: 1, target: 60, probe, known });
  assert.equal(hit.quality, 60);
  assert.equal(probe.calls, before);
});

test('steps out from a one-sided bracket rather than bisecting the grid', async () => {
  const probe = curve((q) => q);
  // Only a failing score below the target is known, as after a seed probe.
  const known = new Map([[40, 40]]);
  const tried = [];
  const logged = async (q) => {
    tried.push(q);
    return probe(q);
  };
  const hit = await searchQuality({ min: 0, max: 100, step: 1, target: 45, probe: logged, known });
  assert.equal(hit.quality, 45);
  // Bisecting [40, unreached] would try ~70 first; stepping tries 46.
  assert.ok(Math.max(...tried) <= 52, `tried ${tried.join(', ')}`);
});

test('stops at the first score within the tolerance', async () => {
  const probe = curve((q) => q);
  const hit = await searchQuality({ min: 0, max: 100, step: 1, target: 60, probe, tolerance: 5 });
  assert.ok(Math.abs(hit.score - 60) <= 5);
  // Bisection from 0..100 lands at 50, then ~75, then ~62: within 5 by the third.
  assert.ok(probe.calls <= 3, `took ${probe.calls} probes`);
});

test('file names are the bench names plus the achieved score', () => {
  assert.equal(
    targetFileName({ codec: 'avif', quality: 28, effort: 0, depth: 8, yuv: '420' }, 70.04),
    'avif-q28-e0-d8-yuv420-ssimu70.0.avif',
  );
  assert.equal(
    targetFileName({ codec: 'jxl', quality: 72.3, effort: 7, depth: 8 }, 80.26),
    'jxl-q72.3-e7-ssimu80.3.jxl',
  );
});
