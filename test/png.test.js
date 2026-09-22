import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';

import { COLOUR_CHUNKS, chunks, isPng, readHeader, stripChunks } from '../src/png.js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Build a chunk with a correct CRC so the result is a real PNG. */
function chunk(type, data = Buffer.alloc(0)) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c ^= byte;
    for (let i = 0; i < 8; i += 1) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function ihdr({ width = 4, height = 3, depth = 8, colourType = 2, interlaced = 0 } = {}) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data.writeUInt8(depth, 8);
  data.writeUInt8(colourType, 9);
  data.writeUInt8(0, 10);
  data.writeUInt8(0, 11);
  data.writeUInt8(interlaced, 12);
  return chunk('IHDR', data);
}

function makePng(extraChunks = [], header = {}) {
  return Buffer.concat([
    SIGNATURE,
    ihdr(header),
    ...extraChunks,
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 1, 2, 3]))),
    chunk('IEND'),
  ]);
}

test('isPng recognises the signature', () => {
  assert.equal(isPng(makePng()), true);
  assert.equal(isPng(Buffer.from('not a png at all')), false);
});

test('readHeader parses dimensions, depth and channel count', () => {
  const header = readHeader(makePng([], { width: 640, height: 480, depth: 8, colourType: 2 }));
  assert.equal(header.width, 640);
  assert.equal(header.height, 480);
  assert.equal(header.depth, 8);
  assert.equal(header.channels, 3);
  assert.equal(header.interlaced, false);
});

test('readHeader reports 4 channels for RGBA and 16-bit depth', () => {
  const header = readHeader(makePng([], { depth: 16, colourType: 6 }));
  assert.equal(header.channels, 4);
  assert.equal(header.depth, 16);
});

test('stripChunks removes cICP, which is what blocks ssimulacra2 (finding 1)', () => {
  const cicp = chunk('cICP', Buffer.from([9, 16, 0, 1]));
  const png = makePng([cicp]);
  const before = [...chunks(png)].map((c) => c.type);
  assert.ok(before.includes('cICP'));

  const { buffer, removed } = stripChunks(png);
  assert.deepEqual(removed, ['cICP']);
  const after = [...chunks(buffer)].map((c) => c.type);
  assert.deepEqual(after, ['IHDR', 'IDAT', 'IEND']);
});

test('stripChunks removes every colour-management chunk avifdec may emit', () => {
  const png = makePng([
    chunk('cHRM', Buffer.alloc(32)),
    chunk('cICP', Buffer.from([9, 16, 0, 1])),
    chunk('gAMA', Buffer.alloc(4)),
  ]);
  const { removed } = stripChunks(png);
  assert.deepEqual(removed.sort(), ['cHRM', 'cICP', 'gAMA']);
});

test('stripChunks preserves pixel data and the resulting file is still a valid PNG', () => {
  const png = makePng([chunk('cICP', Buffer.from([9, 16, 0, 1]))]);
  const { buffer } = stripChunks(png);
  assert.equal(isPng(buffer), true);
  // IDAT must survive byte-for-byte: this is a chunk walk, not a re-encode.
  const originalIdat = [...chunks(png)].find((c) => c.type === 'IDAT');
  const strippedIdat = [...chunks(buffer)].find((c) => c.type === 'IDAT');
  assert.deepEqual(
    buffer.subarray(strippedIdat.start, strippedIdat.end),
    png.subarray(originalIdat.start, originalIdat.end),
  );
  assert.deepEqual(readHeader(buffer), readHeader(png));
});

test('stripChunks is a no-op for a clean PNG (djxl output needs no surgery)', () => {
  const png = makePng();
  const { buffer, removed } = stripChunks(png);
  assert.deepEqual(removed, []);
  assert.deepEqual(buffer, png);
});

test('chunks() rejects a truncated file rather than reading out of bounds', () => {
  const png = makePng([chunk('cICP', Buffer.from([9, 16, 0, 1]))]);
  const truncated = png.subarray(0, png.length - 6);
  assert.throws(() => [...chunks(truncated)], /Truncated PNG/);
});

test('readHeader rejects a non-PNG', () => {
  assert.throws(() => readHeader(Buffer.from('JFIF nonsense')), /Not a PNG/);
});

test('COLOUR_CHUNKS covers cICP', () => {
  assert.ok(COLOUR_CHUNKS.has('cICP'));
});
