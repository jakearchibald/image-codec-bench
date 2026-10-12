import assert from 'node:assert/strict';
import { test } from 'node:test';

import { jpegMetadata, jpegSegments, smallest } from '../src/jpeg.js';

/** A marker segment: FF, marker, 16-bit length, then the payload. */
function segment(marker, payload = []) {
  const length = payload.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...payload];
}

function jpeg(...parts) {
  return Buffer.from([0xff, 0xd8, ...parts.flat(), 0xff, 0xd9]);
}

test('finds metadata segments', () => {
  const file = jpeg(segment(0xe0, [0x4a, 0x46]), segment(0xdb, [0]), segment(0xe1, [1, 2]), segment(0xfe, [3]));
  assert.deepEqual(jpegMetadata(file), ['APP0', 'APP1', 'COM']);
});

test('walks entropy-coded data, including stuffed bytes and restarts', () => {
  // A metadata segment after a scan must still be found: the walker has to
  // step over 0xff00 and RSTn inside the scan rather than stopping there.
  const scan = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56];
  const file = jpeg(segment(0xdb, [0]), segment(0xda, [1]), scan, segment(0xc4, [0]), segment(0xda, [1]), scan, segment(0xfe, [9]));
  assert.deepEqual(
    jpegSegments(file).map((s) => s.marker),
    [0xd8, 0xdb, 0xda, 0xc4, 0xda, 0xfe, 0xd9],
  );
  assert.deepEqual(jpegMetadata(file), ['COM']);
});

test('no metadata in a bare file', () => {
  assert.deepEqual(jpegMetadata(jpeg(segment(0xdb, [0]), segment(0xda, [1]), [0x12])), []);
});

test('rejects non-JPEG input', () => {
  assert.throws(() => jpegSegments(Buffer.from([0x89, 0x50])), /Not a JPEG/);
});

test('smallest picks the fewest bytes, ties to the lower effort', () => {
  const pick = smallest([
    { effort: 9, bytes: 100 },
    { effort: 5, bytes: 100 },
    { effort: 7, bytes: 100 },
    { effort: 10, bytes: 120 },
  ]);
  assert.equal(pick.effort, 5);
  assert.equal(smallest([{ effort: 3, bytes: 90 }, { effort: 1, bytes: 95 }]).effort, 3);
});
