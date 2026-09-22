import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeIsStale, findBrowser, summarise } from '../src/decode.js';

test('summarise reports best-of-N with the mean alongside', () => {
  // The first createImageBitmap call carries codec init and JIT warm-up, which
  // is why the headline is the minimum rather than the mean.
  const stats = summarise([5.1, 2.6, 2.4, 2.0, 2.4]);
  assert.equal(stats.bestMs, 2.0);
  assert.equal(stats.runs, 5);
  assert.ok(stats.meanMs > stats.bestMs, 'the warm-up sample pulls the mean up');
  assert.deepEqual(stats.samplesMs, [5.1, 2.6, 2.4, 2, 2.4]);
});

test('decode timings go stale when the browser build changes', () => {
  // Canary updates most days, and decode times are only comparable within one
  // build. This is why the build is stamped on the measurement instead of
  // being folded into the job cache key, where it would also invalidate every
  // encode and throw away hours of work.
  const job = { decode: { bestMs: 2, browser: 'Google Chrome 156.0.8068.0 canary' } };
  assert.equal(decodeIsStale(job, 'Google Chrome 156.0.8068.0 canary'), false);
  assert.equal(decodeIsStale(job, 'Google Chrome 157.0.8100.0 canary'), true);
});

test('a job with no decode measurement is stale', () => {
  assert.equal(decodeIsStale({}, 'any'), true);
  assert.equal(decodeIsStale(undefined, 'any'), true);
});

test('findBrowser returns null rather than throwing for a bad path', async () => {
  // The decode phase is skipped, not fatal, when no browser is present.
  assert.equal(await findBrowser('/nope/not/a/browser'), null);
});

test('findBrowser reports the version of an explicit binary', async () => {
  // `node --version` stands in for a browser here: the contract is just that an
  // explicit path wins and its version string comes back.
  const found = await findBrowser(process.execPath);
  assert.equal(found.path, process.execPath);
  assert.match(found.version, /^v\d+\./);
});
