// Regressions for bugs found in review. Each of these was a real defect that
// produced plausible-looking but wrong output, so each gets a test.

import assert from 'node:assert/strict';
import test from 'node:test';

import { avif, jxl, webp } from '../src/codecs/index.js';
import { exists } from '../src/exec.js';
import { readHeader, stripChunks } from '../src/png.js';
import { CANONICAL_THREADS, keyForJob, partitionCached } from '../src/run.js';

/** Minimal valid PNG, optionally carrying extra chunks. */
function makePng({ extra = [] } = {}) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    // CRC is not validated by our reader, so a placeholder keeps this simple.
    return Buffer.concat([length, body, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr.writeUInt8(8, 8);
  ihdr.writeUInt8(2, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...extra.map(([type, data]) => chunk(type, data)),
    chunk('IDAT', Buffer.from([1, 2, 3])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('exists() reports a missing binary as missing', async () => {
  // Regression: with allowFailure set, `run` resolves rather than rejects for
  // ENOENT, so the old try/catch reported every tool on earth as present.
  assert.equal(await exists('definitely-not-a-real-binary-xyz'), false);
});

test('exists() reports a present binary as present', async () => {
  assert.equal(await exists('node'), true);
});

test('fixDecoded is a pure buffer transform, so the caller reads the file once', () => {
  // Regression: fixDecoded used to take a path and do its own read+write, so
  // scoring read the same multi-MB PNG three times per job.
  const png = makePng({ extra: [['cICP', Buffer.from([9, 16, 0, 1])]] });
  const { buffer, removed } = avif.fixDecoded(png);
  assert.deepEqual(removed, ['cICP']);
  assert.ok(buffer.length < png.length);
  // The header must be parseable straight out of the returned buffer.
  assert.equal(readHeader(buffer).width, 4);

  for (const codec of [jxl, webp]) {
    const result = codec.fixDecoded(png);
    assert.deepEqual(result.removed, []);
    assert.equal(result.buffer, png, `${codec.name} should pass the buffer through`);
  }
});

test('the measured artefact is always encoded all-cores', () => {
  // Regression: the artefact used to be whichever timing mode ran last. aom's
  // output is thread-dependent, so --timing silently changed every file size.
  assert.equal(CANONICAL_THREADS, 'multi');
  const args = avif.buildEncodeArgs({
    input: 'r.png', output: 'o.avif', quality: 60, effort: 6, threads: CANONICAL_THREADS,
  });
  assert.equal(args[args.indexOf('-j') + 1], 'all');
});

test('a job key ignores timing settings, so resume still matches', () => {
  const job = { codec: 'avif', quality: 60, effort: 6, depth: 8, yuv: '444', qalpha: 'match' };
  const a = keyForJob({ job, referenceHash: 'abc', versions: { avifenc: '1.4.2' } });
  const b = keyForJob({ job, referenceHash: 'abc', versions: { avifenc: '1.4.2' } });
  assert.equal(a, b, 'same inputs must give the same key');

  const different = keyForJob({ job, referenceHash: 'abc', versions: { avifenc: '1.5.0' } });
  assert.notEqual(a, different, 'a toolchain change must invalidate the key');
});

test('partitionCached only treats fully-measured jobs as cached', () => {
  const versions = { avifenc: '1.4.2' };
  const referenceHash = 'ref';
  const jobs = [
    { codec: 'avif', quality: 40, effort: 6, depth: 8, yuv: '444', qalpha: 'match', seriesId: 's' },
    { codec: 'avif', quality: 60, effort: 6, depth: 8, yuv: '444', qalpha: 'match', seriesId: 's' },
    { codec: 'avif', quality: 80, effort: 6, depth: 8, yuv: '444', qalpha: 'match', seriesId: 's' },
  ];
  const [scored, unscored, missingTiming] = jobs.map((job) =>
    keyForJob({ job, referenceHash, versions }));

  const store = new Map([
    [scored, { key: scored, score: 50, timings: { multi: { bestMs: 1 } } }],
    // Encoded but never scored: must be redone.
    [unscored, { key: unscored, timings: { multi: { bestMs: 1 } } }],
    // Scored, but this run wants a timing mode it doesn't have.
    [missingTiming, { key: missingTiming, score: 70, timings: {} }],
  ]);

  const config = { timing: ['multi'], force: false };
  const { cachedKeys, todo } = partitionCached({
    jobs, store: { get: (k) => store.get(k) }, referenceHash, versions, config,
  });

  assert.equal(cachedKeys.size, 1);
  assert.ok(cachedKeys.has(scored));
  assert.equal(todo.length, 2, 'unscored and missing-timing jobs must still run');
});

test('partitionCached honours --force by treating nothing as cached', () => {
  const job = { codec: 'jxl', quality: 60, effort: 7, depth: 8, seriesId: 's' };
  const key = keyForJob({ job, referenceHash: 'ref', versions: {} });
  const store = { get: () => ({ key, score: 50, timings: { multi: { bestMs: 1 } } }) };
  const { cachedKeys, todo } = partitionCached({
    jobs: [job], store, referenceHash: 'ref', versions: {}, config: { timing: ['multi'], force: true },
  });
  assert.equal(cachedKeys.size, 0);
  assert.equal(todo.length, 1);
});

test('stripChunks leaves a clean PNG untouched, byte for byte', () => {
  const png = makePng();
  const { buffer, removed } = stripChunks(png);
  assert.deepEqual(removed, []);
  assert.ok(buffer.equals(png));
});
