import assert from 'node:assert/strict';
import test from 'node:test';

import { avif, jxl, webp, getCodec, lossyCodecs } from '../src/codecs/index.js';

test('avif encode argv carries quality, effort, depth, subsampling', () => {
  const args = avif.buildEncodeArgs({
    input: 'ref.png', output: 'out.avif', quality: 60, effort: 4, depth: 8, yuv: '444',
  });
  assert.ok(args.includes('-q') && args[args.indexOf('-q') + 1] === '60');
  assert.ok(args.includes('-s') && args[args.indexOf('-s') + 1] === '4');
  assert.ok(args.includes('-d') && args[args.indexOf('-d') + 1] === '8');
  assert.ok(args.includes('-y') && args[args.indexOf('-y') + 1] === '444');
});

test('avif --qalpha tracks -q by default (plan.md §11)', () => {
  const args = avif.buildEncodeArgs({
    input: 'r.png', output: 'o.avif', quality: 55, effort: 6, qalpha: 'match',
  });
  assert.equal(args[args.indexOf('--qalpha') + 1], '55');
});

test('avif --qalpha can be pinned to a fixed value', () => {
  const args = avif.buildEncodeArgs({
    input: 'r.png', output: 'o.avif', quality: 55, effort: 6, qalpha: '90',
  });
  assert.equal(args[args.indexOf('--qalpha') + 1], '90');
});

test('avif single-thread uses -j 1, multi uses -j all (finding 3)', () => {
  const single = avif.buildEncodeArgs({
    input: 'r.png', output: 'o.avif', quality: 50, effort: 6, threads: 'single',
  });
  assert.equal(single[single.indexOf('-j') + 1], '1');
  const multi = avif.buildEncodeArgs({
    input: 'r.png', output: 'o.avif', quality: 50, effort: 6, threads: 'multi',
  });
  assert.equal(multi[multi.indexOf('-j') + 1], 'all');
});

test('avif lossless drops the lossy quality flags', () => {
  const args = avif.buildEncodeArgs({
    input: 'r.png', output: 'o.avif', effort: 0, lossless: true,
  });
  assert.ok(args.includes('--lossless'));
  assert.ok(!args.includes('-q'));
  assert.ok(!args.includes('--qalpha'));
});

test('avif decode pins the output depth to the reference (finding 2)', () => {
  const args = avif.buildDecodeArgs({ input: 'a.avif', output: 'a.png', referenceDepth: 8 });
  assert.equal(args[args.indexOf('-d') + 1], '8');
});

test('jxl single-thread uses --num_threads=0 (finding 3)', () => {
  const single = jxl.buildEncodeArgs({
    input: 'r.png', output: 'o.jxl', quality: 70, effort: 7, threads: 'single',
  });
  assert.ok(single.includes('--num_threads=0'));
  const multi = jxl.buildEncodeArgs({
    input: 'r.png', output: 'o.jxl', quality: 70, effort: 7, threads: 'multi',
  });
  assert.ok(!multi.some((a) => a.startsWith('--num_threads')));
});

test('jxl lossless uses -d 0 rather than -q', () => {
  const args = jxl.buildEncodeArgs({ input: 'r.png', output: 'o.jxl', effort: 9, lossless: true });
  assert.equal(args[args.indexOf('-d') + 1], '0');
  assert.ok(!args.includes('-q'));
});

test('jxl decode pins bits_per_sample to the reference depth', () => {
  const args = jxl.buildDecodeArgs({ input: 'a.jxl', output: 'a.png', referenceDepth: 8 });
  assert.ok(args.includes('--bits_per_sample=8'));
});

test('webp lossless always passes -exact (finding 6)', () => {
  // Without -exact the round-trip is not bit-exact on fully-transparent
  // pixels, so a "lossless" claim would be false.
  const args = webp.buildEncodeArgs({ input: 'r.png', output: 'o.webp' });
  assert.ok(args.includes('-exact'));
  assert.ok(args.includes('-lossless'));
  assert.equal(args[args.indexOf('-z') + 1], '9');
});

test('webp uses -mt only for the multi-threaded timing column', () => {
  assert.ok(webp.buildEncodeArgs({ input: 'r.png', output: 'o.webp', threads: 'multi' }).includes('-mt'));
  assert.ok(!webp.buildEncodeArgs({ input: 'r.png', output: 'o.webp', threads: 'single' }).includes('-mt'));
});

test('webp refuses images over 16383px per side, and allows the boundary', () => {
  assert.equal(webp.checkSupport({ width: 16383, height: 16383 }).supported, true);
  const tooWide = webp.checkSupport({ width: 16384, height: 100 });
  assert.equal(tooWide.supported, false);
  assert.match(tooWide.warnings[0], /16383/);
  assert.equal(webp.checkSupport({ width: 100, height: 20000 }).supported, false);
});

test('effort labels reflect each encoder\'s own scale', () => {
  // avifenc -s counts down (0 slowest); cjxl -e counts up (10 slowest).
  assert.equal(avif.effortLabel(0), 's0');
  assert.equal(jxl.effortLabel(9), 'e9');
});

test('lossless sweeps every configured effort level', () => {
  // A single point per codec hid the size/encode-time curve entirely.
  assert.deepEqual(
    avif.losslessConfigs([0, 3, 6]).map((c) => c.label),
    ['avifenc --lossless -s 0', 'avifenc --lossless -s 3', 'avifenc --lossless -s 6'],
  );
  assert.deepEqual(jxl.losslessConfigs([7, 9]).map((c) => c.effort), [7, 9]);
  assert.deepEqual(
    webp.losslessConfigs([0, 9]).map((c) => c.label),
    ['cwebp -lossless -z 0 -exact', 'cwebp -lossless -z 9 -exact'],
  );
  // Each point carries the label used for its series and filename.
  for (const codec of [avif, jxl, webp]) {
    for (const point of codec.losslessConfigs([codec.defaults.effort[0]])) {
      assert.ok(point.effortLabel, `${codec.name} point needs an effortLabel`);
      assert.equal(point.lossless, true);
    }
  }
});

test('webp carries its own lossless effort axis', () => {
  // cwebp's -z is a separate flag from avifenc -s and cjxl -e, so it gets its
  // own option rather than borrowing either range.
  assert.deepEqual(webp.defaults.effort, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const args = webp.buildEncodeArgs({ input: 'r.png', output: 'o.webp', effort: 4 });
  assert.equal(args[args.indexOf('-z') + 1], '4');
  // -exact stays mandatory at every effort level (finding 6).
  assert.ok(args.includes('-exact'));
});

test('the default lossless sweep includes each codec\'s slowest effort', () => {
  // The slowest setting is the interesting end -- the smallest file -- so it
  // must be in the default range rather than something you have to ask for.
  assert.ok(avif.losslessConfigs().some((c) => c.effort === 0), 'avifenc -s 0');
  assert.ok(jxl.losslessConfigs().some((c) => c.effort === 10), 'cjxl -e 10');
  assert.ok(webp.losslessConfigs().some((c) => c.effort === 9), 'cwebp -z 9');
});

test('every lossy codec implements the shared interface', () => {
  for (const codec of lossyCodecs) {
    for (const method of [
      'buildEncodeArgs',
      'buildDecodeArgs',
      'fixDecoded',
      'checkSupport',
      'losslessConfigs',
    ]) {
      assert.equal(typeof codec[method], 'function', `${codec.name} is missing ${method}`);
    }
    assert.equal(typeof codec.encoder, 'string');
    assert.equal(typeof codec.decoder, 'string');
    assert.equal(typeof codec.extension, 'string');
  }
});

test('getCodec rejects an unknown name', () => {
  assert.throws(() => getCodec('heic'), /Unknown codec/);
});
