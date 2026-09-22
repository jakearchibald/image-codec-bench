import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ResultsStore, hashFileBytes, jobKey, shortHash } from '../src/cache.js';
import { encodeParams } from '../src/run.js';

async function tempStore() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'icb-cache-'));
  const store = new ResultsStore(path.join(dir, 'results.json'));
  await store.load();
  return { store, dir };
}

const baseJob = { codec: 'avif', quality: 60, effort: 6, depth: 8, yuv: '444', qalpha: 'match' };

function keyFor(overrides = {}, extra = {}) {
  const job = { ...baseJob, ...overrides };
  return jobKey({
    referenceHash: 'abc123',
    codec: job.codec,
    params: encodeParams(job),
    versions: { avifenc: '1.4.2' },
    extra,
  });
}

test('jobKey is stable for identical inputs', () => {
  assert.equal(keyFor(), keyFor());
});

test('jobKey changes with any encode parameter', () => {
  const base = keyFor();
  assert.notEqual(base, keyFor({ quality: 61 }));
  assert.notEqual(base, keyFor({ effort: 5 }));
  assert.notEqual(base, keyFor({ depth: 10 }));
  assert.notEqual(base, keyFor({ yuv: '420' }));
});

test('jobKey changes with tool versions, so a codec upgrade invalidates the cache', () => {
  const a = jobKey({ referenceHash: 'h', codec: 'avif', params: {}, versions: { avifenc: '1.4.2' } });
  const b = jobKey({ referenceHash: 'h', codec: 'avif', params: {}, versions: { avifenc: '1.5.0' } });
  assert.notEqual(a, b);
});

test('jobKey changes with the reference image', () => {
  const a = jobKey({ referenceHash: 'one', codec: 'avif', params: {}, versions: {} });
  const b = jobKey({ referenceHash: 'two', codec: 'avif', params: {}, versions: {} });
  assert.notEqual(a, b);
});

test('jobKey ignores key order in params', () => {
  const a = jobKey({ referenceHash: 'h', codec: 'avif', params: { quality: 1, effort: 2 }, versions: {} });
  const b = jobKey({ referenceHash: 'h', codec: 'avif', params: { effort: 2, quality: 1 }, versions: {} });
  assert.equal(a, b);
});

test('encodeParams excludes timing settings, so one config is one row', () => {
  // --timing and --repeats change what was *measured*, not what was encoded.
  // If they fed the key, the same config would appear as several table rows.
  const params = encodeParams(baseJob);
  assert.deepEqual(Object.keys(params).sort(), ['depth', 'effort', 'qalpha', 'quality', 'yuv']);
});

test('encodeParams resolves qalpha: match to the quality value', () => {
  assert.equal(encodeParams({ ...baseJob, quality: 55, qalpha: 'match' }).qalpha, 55);
  assert.equal(encodeParams({ ...baseJob, quality: 55, qalpha: '90' }).qalpha, 90);
});

test('encodeParams omits AVIF-only fields for JXL', () => {
  const params = encodeParams({ codec: 'jxl', quality: 70, effort: 7, depth: 8 });
  assert.deepEqual(Object.keys(params).sort(), ['depth', 'effort', 'quality']);
});

test('store round-trips a result and persists it atomically', async () => {
  const { store } = await tempStore();
  await store.put({ key: 'k1', codec: 'avif', score: 80 });
  assert.equal(store.get('k1').score, 80);

  const onDisk = JSON.parse(await readFile(store.filePath, 'utf8'));
  assert.equal(onDisk.jobs.length, 1);
  assert.equal(onDisk.jobs[0].score, 80);
});

test('store.put merges into an existing record rather than duplicating it', async () => {
  const { store } = await tempStore();
  await store.put({ key: 'k1', codec: 'avif', bytes: 100, timings: { multi: { bestMs: 5 } } });
  await store.put({ key: 'k1', codec: 'avif', bytes: 100, score: 82, timings: { multi: { bestMs: 5 }, single: { bestMs: 9 } } });

  assert.equal(store.jobs.length, 1, 'same key must not create a second row');
  assert.equal(store.get('k1').score, 82);
  assert.deepEqual(Object.keys(store.get('k1').timings).sort(), ['multi', 'single']);
});

test('a reloaded store sees previously written results', async () => {
  const { store } = await tempStore();
  await store.put({ key: 'k1', score: 1 });

  const reopened = new ResultsStore(store.filePath);
  await reopened.load();
  assert.equal(reopened.get('k1').score, 1);
});

test('--force clears prior results on load', async () => {
  const { store } = await tempStore();
  await store.put({ key: 'k1', score: 1 });

  const reopened = new ResultsStore(store.filePath);
  await reopened.load({ force: true });
  assert.equal(reopened.jobs.length, 0);
  assert.equal(reopened.has('k1'), false);
});

test('a corrupt results.json is replaced rather than crashing the run', async () => {
  const { store } = await tempStore();
  const { writeFile } = await import('node:fs/promises');
  await writeFile(store.filePath, '{ not valid json');

  const reopened = new ResultsStore(store.filePath);
  await reopened.load();
  assert.deepEqual(reopened.jobs, []);
});

test('hashFileBytes and shortHash are deterministic', () => {
  const buffer = Buffer.from('some image bytes');
  assert.equal(hashFileBytes(buffer), hashFileBytes(Buffer.from('some image bytes')));
  assert.notEqual(hashFileBytes(buffer), hashFileBytes(Buffer.from('other bytes')));
  assert.equal(shortHash('abc').length, 8);
});
