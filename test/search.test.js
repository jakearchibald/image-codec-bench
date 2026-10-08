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
