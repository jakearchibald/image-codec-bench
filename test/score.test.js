import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertComparable,
  assertLosslessScore,
  mapConcurrent,
  parseScore,
} from '../src/score.js';

test('parseScore reads the float ssimulacra2 prints', () => {
  assert.equal(parseScore('68.79089283\n'), 68.79089283);
  assert.equal(parseScore('100.00000000'), 100);
  assert.equal(parseScore('  91.5  '), 91.5);
});

test('parseScore handles negative scores (very low quality)', () => {
  assert.equal(parseScore('-12.5\n'), -12.5);
});

test('parseScore rejects output with no number in it', () => {
  // e.g. the cICP failure mode: "Could not decode distorted image: a.png"
  assert.throws(() => parseScore('Could not decode distorted image'), /Could not parse/);
  assert.throws(() => parseScore(''), /Could not parse/);
});

const reference = { width: 640, height: 480, depth: 8, channels: 3 };

test('assertComparable accepts a matching decode', () => {
  assert.doesNotThrow(() => assertComparable(reference, { ...reference }, 'avif'));
});

test('assertComparable rejects a wider decode (the finding-2 trap)', () => {
  // Decoding 16-bit against an 8-bit reference silently costs ~1.66 points,
  // which would shift every number in the run.
  assert.throws(
    () => assertComparable(reference, { ...reference, depth: 16 }, 'avif'),
    /decoded at 16-bit but reference is 8-bit/,
  );
});

test('assertComparable rejects a geometry mismatch', () => {
  assert.throws(
    () => assertComparable(reference, { ...reference, width: 320 }, 'jxl'),
    /decoded 320x480 but reference is 640x480/,
  );
});

test('assertComparable rejects a channel-count change', () => {
  assert.throws(
    () => assertComparable(reference, { ...reference, channels: 4 }, 'avif'),
    /Alpha was added or dropped/,
  );
});

test('assertLosslessScore accepts exactly 100', () => {
  assert.doesNotThrow(() => assertLosslessScore(100, 'cjxl -d 0 -e 9'));
  assert.doesNotThrow(() => assertLosslessScore(100.0000001, 'cjxl -d 0 -e 9'));
});

test('assertLosslessScore rejects the 16-bit-mismatch value', () => {
  // 98.33520916 is exactly what a bit-exact round-trip scores when decoded at
  // 16-bit against an 8-bit reference. Catching it is the self-check.
  assert.throws(
    () => assertLosslessScore(98.33520916, 'cjxl -d 0 -e 9'),
    /expected exactly 100/,
  );
});

test('assertLosslessScore rejects a near miss', () => {
  assert.throws(() => assertLosslessScore(99.998, 'avifenc --lossless'), /expected exactly 100/);
});

test('mapConcurrent preserves input order regardless of completion order', async () => {
  const input = [50, 10, 30, 5, 1];
  const results = await mapConcurrent(input, 3, async (ms) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return ms;
  });
  assert.deepEqual(results, input);
});

test('mapConcurrent respects the concurrency limit', async () => {
  let inFlight = 0;
  let peak = 0;
  await mapConcurrent(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
  });
  assert.ok(peak <= 4, `peak concurrency was ${peak}`);
});

test('mapConcurrent handles an empty list', async () => {
  assert.deepEqual(await mapConcurrent([], 4, async () => 1), []);
});
