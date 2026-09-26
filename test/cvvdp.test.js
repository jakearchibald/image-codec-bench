import assert from 'node:assert/strict';
import test from 'node:test';

import { displayModel, isCurrent, parseJod } from '../src/cvvdp.js';
import { needsScoring } from '../src/run.js';
import { formatTable, toCsv } from '../src/table.js';

test('parseJod reads the bare --quiet output and the labelled form', () => {
  assert.equal(parseJod('9.7709\n'), 9.7709);
  assert.equal(parseJod('cvvdp=9.9682 [JOD]\n'), 9.9682);
  assert.throws(() => parseJod('Traceback ...'), /Could not parse/);
});

test('display model: SDR is standard_4k in sRGB', () => {
  const { id, model } = displayModel(null);
  assert.equal(id, 'standard_4k');
  assert.equal(model.colorspace, 'bench-sRGB');
  assert.equal(model.max_luminance, 200);
});

test('display model: HDR is standard_hdr_pq in the reference’s own primaries', () => {
  // cvvdp ignores the files' colour tags, so the display must match the image.
  assert.equal(displayModel({ primaries: 9 }).model.colorspace, 'bench-BT.2020-PQ');
  assert.equal(displayModel({ primaries: 12 }).model.colorspace, 'bench-P3-PQ');
  assert.equal(displayModel({ primaries: 1 }).model.colorspace, 'bench-BT.709-PQ');
  assert.notEqual(displayModel({ primaries: 9 }).id, displayModel({ primaries: 12 }).id);
  assert.equal(displayModel({ primaries: 9 }).model.max_luminance, 1500);
});

const cvvdp = { id: '0.5.7|standard_4k' };
const scored = { score: 70, cvvdp: { jod: 9.8, id: '0.5.7|standard_4k' } };

test('isCurrent: only a JOD from the same version and display counts', () => {
  assert.ok(isCurrent(scored.cvvdp, cvvdp));
  assert.ok(!isCurrent({ jod: 9.8, id: '0.5.6|standard_4k' }, cvvdp));
  assert.ok(!isCurrent({ jod: 9.8, id: '0.5.7|standard_hdr_pq-9' }, cvvdp));
  assert.ok(!isCurrent(undefined, cvvdp));
});

test('needsScoring: a missing or stale JOD re-scores, but only with --cvvdp on', () => {
  assert.ok(needsScoring({}, {}));
  assert.ok(!needsScoring({ score: 70 }, {}));
  assert.ok(needsScoring({ score: 70 }, { cvvdp }));
  assert.ok(!needsScoring(scored, { cvvdp }));
  assert.ok(needsScoring({ score: 70, cvvdp: { jod: 9.8, id: 'old' } }, { cvvdp }));
});

const row = (extra = {}) => ({
  codec: 'avif', quality: 60, effortLabel: 's6', effort: 6, depth: 8, yuv: '444',
  bytes: 100, bpp: 0.1, score: 70, timings: {}, ...extra,
});

test('the cvvdp column appears only when some row has a JOD', () => {
  assert.ok(!formatTable([row()], []).includes('cvvdp'));
  assert.ok(formatTable([row({ cvvdp: { jod: 9.87654 } })], []).includes('9.8765'));
  const csv = toCsv([row({ cvvdp: { jod: 9.8 } }), row({ quality: 70 })], []);
  assert.ok(csv.split('\n')[0].includes('cvvdp_jod'));
});
