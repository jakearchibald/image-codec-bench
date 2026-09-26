import assert from 'node:assert/strict';
import test from 'node:test';

import { avif, jxl } from '../src/codecs/index.js';
import zlib from 'node:zlib';

import {
  FULL_HEADROOM,
  hasGainMap,
  iccToCicp,
  isHdrPng,
  pngColour,
  readCicp,
  tonemapArgs,
  withOnlyCicp,
} from '../src/hdr.js';
import { chunks } from '../src/png.js';
import { encodeParams, encodeInput } from '../src/run.js';
import { buildSeries } from '../src/schedule.js';

/** A PNG chunk. CRCs are not checked by the chunk walker, so zeros do. */
function chunk(type, data = Buffer.alloc(0)) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(...parts) {
  return Buffer.concat([SIGNATURE, ...parts, chunk('IEND')]);
}

/** A JPEG made of just SOI and the given APPn segments, then SOS. */
function jpeg(...segments) {
  const encoded = segments.map(({ marker, body }) => {
    const header = Buffer.from([0xff, marker, 0, 0]);
    header.writeUInt16BE(body.length + 2, 2);
    return Buffer.concat([header, body]);
  });
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...encoded, Buffer.from([0xff, 0xda, 0, 2])]);
}

const s15 = (value) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(Math.round(value * 65536));
  return b;
};

/**
 * A minimal ICC profile with colorant and TRC tags, enough for iccToCicp.
 * `curve` is ICC parametric type-3 params, or `samples` a sampled curv table.
 */
function icc({ r, g, b, curve = [2.4, 0.948, 0.052, 0.077, 0.039], samples = null, cicp = null }) {
  const xyz = (v) => Buffer.concat([Buffer.from('XYZ \0\0\0\0'), ...v.map(s15)]);
  let trc = Buffer.concat([
    Buffer.from('para\0\0\0\0'), Buffer.from([0, 3, 0, 0]), ...curve.map(s15),
  ]);
  if (samples) {
    const header = Buffer.alloc(12);
    header.write('curv', 0, 'latin1');
    header.writeUInt32BE(samples.length, 8);
    const values = Buffer.alloc(samples.length * 2);
    samples.forEach((v, i) => values.writeUInt16BE(Math.round(v * 65535), i * 2));
    trc = Buffer.concat([header, values]);
  }
  const tags = [
    ['rXYZ', xyz(r)], ['gXYZ', xyz(g)], ['bXYZ', xyz(b)],
    ['rTRC', trc], ['gTRC', trc], ['bTRC', trc],
    ...(cicp ? [['cicp', Buffer.concat([Buffer.from('cicp\0\0\0\0'), Buffer.from(cicp)])]] : []),
  ];
  const table = Buffer.alloc(4 + tags.length * 12);
  table.writeUInt32BE(tags.length, 0);
  let offset = 128 + table.length;
  const bodies = [];
  tags.forEach(([sig, body], i) => {
    table.write(sig, 4 + i * 12, 'latin1');
    table.writeUInt32BE(offset, 8 + i * 12);
    table.writeUInt32BE(body.length, 12 + i * 12);
    bodies.push(body);
    offset += body.length;
  });
  return Buffer.concat([Buffer.alloc(128), table, ...bodies]);
}

const P3 = { r: [0.5151, 0.2412, -0.0011], g: [0.292, 0.6922, 0.0419], b: [0.1571, 0.0666, 0.7841] };

test('hasGainMap spots the Adobe namespace and the ISO 21496-1 URN in a JPEG', () => {
  const xmp = (text) => jpeg({ marker: 0xe1, body: Buffer.from(text) });
  assert.ok(hasGainMap(xmp('xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"')));
  assert.ok(hasGainMap(xmp('urn:iso:std:iso:ts:21496:-1')));
  assert.ok(!hasGainMap(xmp('http://ns.adobe.com/xap/1.0/')));
});

test('hasGainMap ignores the marker in a file that is not a JPEG', () => {
  assert.ok(!hasGainMap(Buffer.from('http://ns.adobe.com/hdr-gain-map/1.0/')));
});

test('iccToCicp recognises Display P3 with Apple’s rounded sRGB curve', () => {
  const cicp = iccToCicp(icc(P3));
  assert.equal(cicp.primaries, 12);
  assert.equal(cicp.transfer, 13);
});

test('iccToCicp accepts the sRGB curve as a sampled table (the classic sRGB profile)', () => {
  const SRGB = { r: [0.4361, 0.2225, 0.0139], g: [0.3851, 0.7169, 0.0971], b: [0.1431, 0.0606, 0.7139] };
  const eotf = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const samples = Array.from({ length: 1024 }, (_, i) => eotf(i / 1023));
  assert.equal(iccToCicp(icc({ ...SRGB, samples })).primaries, 1);
  assert.throws(() => iccToCicp(icc({ ...SRGB, samples: samples.map((v) => v ** 1.1) })), /rTRC/);
});

test('iccToCicp takes a v4.4 cicp tag as-is (Photoshop\u2019s HDR PNGs carry one)', () => {
  // Colorants and curve deliberately wrong: the cicp tag wins.
  const cicp = iccToCicp(icc({ ...P3, curve: [2.2, 1, 0, 0, 0], cicp: [9, 16, 0, 1] }));
  assert.deepEqual([cicp.primaries, cicp.transfer], [9, 16]);
});

test('iccToCicp refuses primaries CICP cannot name rather than approximating', () => {
  assert.throws(() => iccToCicp(icc({ ...P3, r: [0.6, 0.3, 0.0] })), /primaries/);
});

test('iccToCicp refuses a non-sRGB transfer curve', () => {
  assert.throws(() => iccToCicp(icc({ ...P3, curve: [2.2, 1, 0, 0, 0] })), /rTRC/);
});

test('pngColour follows PNG precedence: cICP, then sRGB, then iCCP, else sRGB', () => {
  const iccp = (profile) =>
    chunk('iCCP', Buffer.concat([Buffer.from('p\0\0'), zlib.deflateSync(profile)]));
  const p3 = icc(P3);
  assert.equal(pngColour(png(chunk('IHDR', Buffer.alloc(13)), chunk('cICP', Buffer.from([9, 16, 0, 1])), iccp(p3))).primaries, 9);
  assert.equal(pngColour(png(chunk('IHDR', Buffer.alloc(13)), chunk('sRGB', Buffer.from([0])), iccp(p3))).primaries, 1);
  assert.equal(pngColour(png(chunk('IHDR', Buffer.alloc(13)), iccp(p3))).primaries, 12);
  assert.equal(pngColour(png(chunk('IHDR', Buffer.alloc(13)))).source, 'no colour chunks; assumed sRGB');
});

test('isHdrPng: PQ via cICP, or via an ICC cicp tag with no cICP chunk', () => {
  const iccp = (profile) =>
    chunk('iCCP', Buffer.concat([Buffer.from('p\0\0'), zlib.deflateSync(profile)]));
  assert.ok(isHdrPng(png(chunk('IHDR', Buffer.alloc(13)), chunk('cICP', Buffer.from([12, 16, 0, 1])))));
  assert.ok(isHdrPng(png(chunk('IHDR', Buffer.alloc(13)), iccp(icc({ ...P3, cicp: [12, 16, 0, 1] })))));
  assert.ok(!isHdrPng(png(chunk('IHDR', Buffer.alloc(13)), iccp(icc(P3)))));
});

test('withOnlyCicp keeps the pixels, drops everything else, and writes a valid cICP', () => {
  const buffer = png(
    chunk('IHDR', Buffer.alloc(13)),
    chunk('iCCP', Buffer.alloc(8)),
    chunk('iTXt', Buffer.from('xmp')),
    chunk('IDAT', Buffer.from('pixels')),
  );
  const out = withOnlyCicp(buffer, { primaries: 9, transfer: 16 });
  assert.deepEqual([...chunks(out)].map((c) => c.type), ['IHDR', 'cICP', 'IDAT', 'IEND']);
  assert.deepEqual(readCicp(out), { primaries: 9, transfer: 16, matrix: 0, fullRange: true });
  const cicp = [...chunks(out)].find((c) => c.type === 'cICP');
  assert.equal(out.readUInt32BE(cicp.end - 4), zlib.crc32(out.subarray(cicp.start + 4, cicp.end - 4)));
});

const HDR = {
  primaries: 9,
  transfer: 16,
  sdr: { primaries: 1, transfer: 13 },
};

test('HDR avif encode: combine builds the gain-map image from both PNGs', () => {
  const args = avif.buildEncodeArgs({
    input: { sdr: 'sdr.png', hdr: 'hdr.png' }, output: 'o.avif', quality: 55, effort: 6,
    depth: 10, yuv: '444', threads: 'single', hdr: HDR,
  });
  assert.deepEqual(args.slice(0, 4), ['combine', 'sdr.png', 'hdr.png', 'o.avif']);
  assert.equal(args[args.indexOf('--qgain-map') + 1], '55');
  assert.equal(args[args.indexOf('-d') + 1], '10');
  assert.equal(args[args.indexOf('-j') + 1], '1');
  // --ignore-profile also drops the HDR PNG's cICP, so the alternate's colour
  // must be restated or both images read as SDR.
  assert.ok(args.includes('--ignore-profile'));
  assert.equal(args[args.indexOf('--cicp-base') + 1], '1/13/6');
  assert.equal(args[args.indexOf('--cicp-alternate') + 1], '9/16/0');
  assert.equal(avif.hdrEncoder, 'avifgainmaputil');
});

test('SDR avif encode is untouched by HDR mode', () => {
  const args = avif.buildEncodeArgs({ input: 'r.png', output: 'o.avif', quality: 55, effort: 6 });
  assert.equal(args[0], 'r.png');
  assert.ok(!args.includes('--qgain-map') && !args.includes('combine'));
});

test('HDR decodes: AVIF gain map rendered in full, JXL straight to 16-bit', () => {
  const a = avif.hdrDecode({ input: 'a.avif', output: 'a.png', hdr: HDR });
  assert.equal(a.command, 'avifgainmaputil');
  assert.deepEqual(a.args, tonemapArgs({ input: 'a.avif', output: 'a.png', hdr: HDR }));
  assert.equal(a.args[a.args.indexOf('--headroom') + 1], String(FULL_HEADROOM));
  // No --cicp-input: it would override the file's matrix coefficients too.
  assert.ok(!a.args.includes('--cicp-input'));
  assert.equal(a.args[a.args.indexOf('--cicp-output') + 1], '9/16/0');
  const j = jxl.hdrDecode({ input: 'a.jxl', output: 'a.png' });
  assert.ok(j.args.includes('--bits_per_sample=16'));
});

test('qgainmap is in the cache key only for HDR AVIF jobs', () => {
  const job = { codec: 'avif', quality: 60, effort: 6, depth: 8, yuv: '444', qalpha: 'match' };
  assert.equal(encodeParams({ ...job, hdr: true }).qgainmap, 60);
  // SDR keys must not change, or every existing cache would be invalidated.
  assert.deepEqual(encodeParams({ ...job, hdr: false }), encodeParams(job));
});

test('buildSeries carries HDR mode onto every series', () => {
  const series = buildSeries({
    codecs: ['avif'],
    hdr: true,
    avif: { quality: [50], effort: [6], depth: [8], yuv: ['444'], qalpha: 'match' },
  });
  assert.ok(series.every((s) => s.hdr));
});

test('encodeInput: per-codec in HDR mode, the reference otherwise', () => {
  const pair = { sdr: 'sdr.png', hdr: 'ref.png' };
  const hdrReference = { path: 'ref.png', encodeInputs: { avif: pair, jxl: 'ref.png' } };
  assert.equal(encodeInput(hdrReference, 'avif'), pair);
  assert.equal(encodeInput(hdrReference, 'jxl'), 'ref.png');
  assert.equal(encodeInput({ path: 'ref.png' }, 'avif'), 'ref.png');
});

test('JXL bitstream names and labels carry no depth: it has no depth setting', async () => {
  const { pickVariants } = await import('../src/report/build.js');
  const row = (codec, depth, score) => ({
    key: `${codec}${depth}${score}`, codec, depth, score, effort: codec === 'avif' ? 6 : 7,
    effortLabel: 'x', quality: 50, bytes: 1000, bpp: 0.1, bitstream: 'b', yuv: codec === 'avif' ? '444' : null,
  });
  const { variants } = pickVariants({
    results: [row('avif', 8, 60), row('avif', 10, 70), row('jxl', 8, 60), row('jxl', 8, 70)],
    lossless: [],
    referenceRelPath: 'reference.png',
    targets: [60, 70],
  });
  assert.ok(variants.filter((v) => v.codec === 'avif').some((v) => v.name.includes('-bit')));
  assert.ok(variants.filter((v) => v.codec === 'jxl').every((v) => !v.name.includes('-bit')));
});

test('report original is the input file, SDR and HDR alike', async () => {
  const { originalVariant } = await import('../src/report/build.js');
  const hdr = originalVariant('/runs/neon-1234', {
    input: '/images/neon-hdr.png',
    hdr: { sdr: { input: '/images/neon-sdr.png' } },
  });
  assert.equal(hdr.src, '../../images/neon-hdr.png');
  assert.match(hdr.detail, /neon-sdr\.png/);
  const sdr = originalVariant('/runs/f1-1234', {
    input: '/images/f1.png', reference: { resized: true, width: 1000, height: 500 },
  });
  assert.equal(sdr.src, '../../images/f1.png');
  assert.match(sdr.detail, /downscaled to 1000×500/);
});
