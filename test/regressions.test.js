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

test('the lossless JXL is the comparison reference, with a PNG fallback', async () => {
  const { pickVariants } = await import('../src/report/build.js');
  const results = [
    { codec: 'jxl', effort: 9, score: 70.1, quality: 80, effortLabel: 'e9',
      bytes: 1000, bpp: 0.1, bitstream: 'assets/a.jxl', key: 'k1' },
  ];

  const { variants: withLossless } = pickVariants({
    results,
    lossless: [{ codec: 'jxl', bytes: 5000, bitstream: 'assets/lossless-jxl.jxl' }],
    referenceRelPath: 'reference.png',
  });
  const reference = withLossless.find((v) => v.isReference);
  assert.equal(reference.name, 'JXL lossless');
  assert.equal(withLossless.filter((v) => v.isReference).length, 1);

  // --no-lossless, or a skipped row: the original PNG has to stand in.
  const { variants: without } = pickVariants({
    results,
    lossless: [],
    referenceRelPath: 'reference.png',
  });
  const fallback = without.find((v) => v.isReference);
  assert.ok(fallback.isOriginal, 'falls back to the original PNG');
  assert.equal(without.filter((v) => v.isReference).length, 1);
});

test('depth is shown only for codecs that actually code at a chosen depth', async () => {
  const { formatTable, toCsv } = await import('../src/table.js');
  const rows = [
    { codec: 'avif', quality: 60, effortLabel: 's6', effort: 6, depth: 10, yuv: '444',
      bytes: 100, bpp: 0.1, score: 70, timings: {} },
    { codec: 'jxl', quality: 60, effortLabel: 'e7', effort: 7, depth: 8, yuv: null,
      bytes: 90, bpp: 0.09, score: 71, timings: {} },
  ];

  const table = formatTable(rows, []);
  const [, , avifLine, jxlLine] = table.split('\n');
  assert.match(avifLine, /10b/, 'AVIF depth is a real setting, so show it');
  // JXL declares 8-bit but has no -d analogue; printing it invites reading the
  // two codecs as like-for-like on a knob only one of them has.
  assert.doesNotMatch(jxlLine, /\b8b\b/);

  const csv = toCsv(rows, []).split('\n');
  assert.match(csv[1], /^avif,60,s6,10,/, 'CSV keeps the bare number');
  assert.match(csv[2], /^jxl,60,e7,,/, 'CSV leaves it empty rather than claiming 8');
});

test('partitionCached reports every key in the grid, not just the cached ones', () => {
  // The store accumulates across runs, so outputs need a way to tell "in this
  // run's grid" from "measured here at some point under other settings".
  // Without this set, re-running with a narrower grid reported the old series.
  const versions = { avifenc: '1.4.2' };
  const referenceHash = 'ref';
  const jobs = [40, 60].map((quality) => ({
    codec: 'avif', quality, effort: 6, depth: 8, yuv: '444', qalpha: 'match', seriesId: 's',
  }));
  const cachedKey = keyForJob({ job: jobs[0], referenceHash, versions });

  const { keys, cachedKeys, todo } = partitionCached({
    jobs,
    store: { get: (k) => (k === cachedKey ? { key: k, score: 1, timings: { multi: { bestMs: 1 } } } : undefined) },
    referenceHash,
    versions,
    config: { timing: ['multi'], force: false },
  });

  assert.equal(keys.size, 2, 'both grid members are listed');
  assert.equal(cachedKeys.size, 1);
  assert.equal(todo.length, 1);
  // A job outside the grid must not be claimed by it.
  const outside = keyForJob({
    job: { codec: 'avif', quality: 60, effort: 0, depth: 8, yuv: '444', qalpha: 'match' },
    referenceHash,
    versions,
  });
  assert.ok(!keys.has(outside), 'a different effort is a different grid member');
});

test('report-assets holds only the linked files, rebuilt each time', async (t) => {
  const { collectReportAssets, REPORT_ASSETS_DIR } = await import('../src/report/build.js');
  const { mkdir, mkdtemp, readdir, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;

  const runDir = await mkdtemp(path.join(tmpdir(), 'icb-assets-'));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  await mkdir(path.join(runDir, 'assets'), { recursive: true });
  await writeFile(path.join(runDir, 'reference.png'), 'ref');
  for (const name of ['a.avif', 'b.jxl', 'unused.avif']) {
    await writeFile(path.join(runDir, 'assets', name), name);
  }

  const first = await collectReportAssets({
    runDir,
    variants: [
      { name: 'Original', src: 'reference.png' },
      { name: 'A', src: 'assets/a.avif' },
      { name: 'B', src: 'assets/b.jxl' },
    ],
  });
  assert.deepEqual(first.missing, []);
  assert.deepEqual(
    (await readdir(path.join(runDir, REPORT_ASSETS_DIR))).sort(),
    ['a.avif', 'b.jxl', 'reference.png'],
    'unused.avif is not copied',
  );
  assert.deepEqual(first.variants.map((v) => v.src), [
    'report-assets/reference.png',
    'report-assets/a.avif',
    'report-assets/b.jxl',
  ]);

  // A narrower second run must not leave the first run's extra files behind,
  // or the folder stops being "only what is needed".
  const second = await collectReportAssets({
    runDir,
    variants: [{ name: 'Original', src: 'reference.png' }],
  });
  assert.deepEqual(await readdir(path.join(runDir, REPORT_ASSETS_DIR)), ['reference.png']);
  assert.deepEqual(second.missing, []);

  // A missing source drops that variant instead of failing the whole report,
  // which would waste a run that may have taken hours.
  const third = await collectReportAssets({
    runDir,
    variants: [
      { name: 'Original', src: 'reference.png' },
      { name: 'Gone', src: 'assets/deleted.avif' },
    ],
  });
  assert.deepEqual(third.missing, ['Gone']);
  assert.deepEqual(third.variants.map((v) => v.name), ['Original']);
});

test('report-assets keeps distinct sources that share a basename apart', async (t) => {
  const { collectReportAssets } = await import('../src/report/build.js');
  const { mkdir, mkdtemp, readdir, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;

  const runDir = await mkdtemp(path.join(tmpdir(), 'icb-collide-'));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  for (const dir of ['one', 'two']) {
    await mkdir(path.join(runDir, dir), { recursive: true });
    await writeFile(path.join(runDir, dir, 'same.avif'), dir);
  }

  const { variants } = await collectReportAssets({
    runDir,
    variants: [
      { name: 'One', src: 'one/same.avif' },
      { name: 'Two', src: 'two/same.avif' },
    ],
  });
  assert.equal(new Set(variants.map((v) => v.src)).size, 2, 'the two must not collapse');
  assert.equal((await readdir(path.join(runDir, 'report-assets'))).length, 2);
});

test('score targets come from the overlap of the codecs\' achieved ranges', async () => {
  const { deriveScoreTargets } = await import('../src/report/build.js');
  // Overlap is 44..72: above avif's floor and below jxl's ceiling, so every
  // target is reachable by both and the flip test compares like with like.
  const targets = deriveScoreTargets(new Map([['avif', [44, 60, 81]], ['jxl', [42, 56, 72]]]));
  assert.deepEqual(targets, [44, 53, 63, 72]);
});

test('score targets fall back to the union when ranges do not overlap', async () => {
  const { deriveScoreTargets } = await import('../src/report/build.js');
  // Nothing is comparable here, but returning no targets would mean an empty
  // comparison; the report warns about non-overlap separately.
  assert.deepEqual(
    deriveScoreTargets(new Map([['avif', [85, 90]], ['jxl', [40, 50]]])),
    [40, 57, 73, 90],
  );
});

test('a low-quality-only run still gets a comparison', async () => {
  const { deriveScoreTargets, pickVariants } = await import('../src/report/build.js');
  // Regression: with targets fixed at 60/70/80/90 and a +-5 tolerance, a run
  // scoring ~44 matched none of them and the comparison held only the original.
  assert.ok(deriveScoreTargets(new Map([['avif', [44.9]], ['jxl', [42.5]]])).length > 0);

  const { variants } = pickVariants({
    results: [
      { codec: 'avif', effort: 6, score: 44.95, quality: 40, effortLabel: 's6', depth: 8,
        yuv: '444', bytes: 7083, bpp: 0.29, bitstream: 'assets/a.avif', key: 'k1' },
      { codec: 'jxl', effort: 7, score: 42.51, quality: 40, effortLabel: 'e7', depth: 8,
        yuv: null, bytes: 5469, bpp: 0.22, bitstream: 'assets/b.jxl', key: 'k2' },
    ],
    lossless: [],
    referenceRelPath: 'reference.png',
  });
  assert.ok(variants.some((v) => v.codec === 'avif'), 'avif is represented');
  assert.ok(variants.some((v) => v.codec === 'jxl'), 'jxl is represented');
});

test('variants are labelled with the measured score, not the target', async () => {
  const { pickVariants } = await import('../src/report/build.js');
  const { variants } = pickVariants({
    results: [
      { codec: 'avif', effort: 6, score: 81.2, quality: 80, effortLabel: 's6', depth: 8,
        yuv: '444', bytes: 100, bpp: 0.1, bitstream: 'assets/a.avif', key: 'k1' },
      { codec: 'avif', effort: 6, score: 29.18, quality: 30, effortLabel: 's6', depth: 8,
        yuv: '444', bytes: 50, bpp: 0.05, bitstream: 'assets/c.avif', key: 'k3' },
    ],
    lossless: [],
    referenceRelPath: 'reference.png',
  });
  // Naming a variant after the target is what previously required a tolerance
  // to avoid calling a 45 a "~60".
  for (const v of variants.filter((x) => !x.isOriginal)) {
    assert.match(v.name, new RegExp(`~${Math.round(v.score)}\\b`));
  }
});

test('two targets landing on one encode yield a single variant', async () => {
  const { pickVariants } = await import('../src/report/build.js');
  const { variants } = pickVariants({
    results: [
      { codec: 'avif', effort: 6, score: 70, quality: 60, effortLabel: 's6', depth: 8,
        yuv: '444', bytes: 100, bpp: 0.1, bitstream: 'assets/a.avif', key: 'only' },
    ],
    lossless: [],
    referenceRelPath: 'reference.png',
  });
  assert.equal(variants.filter((v) => v.key === 'only').length, 1);
});
