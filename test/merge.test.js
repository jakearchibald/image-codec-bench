import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeFixedQuality } from '../src/fixed-quality.js';
import { mergeTargets } from '../src/target.js';

const reference = { width: 10, height: 10 };

test('targets.json keeps earlier settings and replaces re-searched ones', () => {
  const previous = {
    input: '/a.png', reference, versions: { cjxl: '0.12.0' },
    results: [
      { codec: 'avif', effort: 0, depth: 8, yuv: '444', target: 70, quality: 40 },
      { codec: 'jixel', effort: 6, depth: 8, patches: false, target: 70, quality: 1 },
    ],
  };
  const current = {
    input: '/a.png', reference, versions: { cjixel: 'x' },
    results: [{ codec: 'jixel', effort: 6, depth: 8, patches: false, target: 70, quality: 80 }],
  };
  const merged = mergeTargets(previous, current);
  assert.deepEqual(merged.results.map((r) => `${r.codec}:${r.quality}`), ['avif:40', 'jixel:80']);
  assert.deepEqual(merged.versions, { cjxl: '0.12.0', cjixel: 'x' });
  // A different reference starts over.
  assert.equal(mergeTargets({ ...previous, reference: { width: 5, height: 5 } }, current), current);
});

test('fixed-quality JSON keeps other codecs per image and recomputes the spread', () => {
  const previous = {
    dir: '/in', maxPixels: 0, quality: { jxl: 70 }, versions: {},
    images: [
      { file: 'a.png', results: [{ codec: 'jxl', effort: 7, depth: 8, score: 70 }], spread: [] },
      { file: 'b.png', results: [], spread: [] },
    ],
  };
  const current = {
    dir: '/in', maxPixels: 0, quality: { jixel: 80 }, versions: {},
    images: [{ file: 'a.png', results: [
      { codec: 'jixel', effort: 3, depth: 8, patches: false, score: 60 },
      { codec: 'jixel', effort: 6, depth: 8, patches: false, score: 66 },
    ], spread: [] }],
  };
  const merged = mergeFixedQuality(previous, current);
  assert.deepEqual(merged.quality, { jxl: 70, jixel: 80 });
  assert.deepEqual(merged.images.map((i) => i.file), ['a.png', 'b.png']);
  assert.deepEqual(merged.images[0].results.map((r) => r.codec), ['jxl', 'jixel', 'jixel']);
  assert.deepEqual(merged.images[0].spread.map((g) => [g.group, g.range]), [['jxl-d8', 0], ['jixel-d8', 6]]);
});

test('fixed-quality merge replaces settings, and drops a codec re-run at a new quality', () => {
  const row = (effort, score) => ({ codec: 'jixel', effort, depth: 8, patches: false, score });
  const previous = { dir: '/in', maxPixels: 0, quality: { jixel: 80 }, versions: {}, images: [{ file: 'a.png', results: [row(3, 60), row(6, 66)] }] };
  const sameQ = mergeFixedQuality(previous, { ...previous, images: [{ file: 'a.png', results: [row(6, 67)] }] });
  assert.deepEqual(sameQ.images[0].results.map((r) => `${r.effort}:${r.score}`), ['3:60', '6:67']);
  const newQ = mergeFixedQuality(previous, { ...previous, quality: { jixel: 70 }, images: [{ file: 'a.png', results: [row(6, 50)] }] });
  assert.deepEqual(newQ.images[0].results.map((r) => `${r.effort}:${r.score}`), ['6:50']);
});
