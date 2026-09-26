// HDR mode: an HDR PNG (PQ) plus an SDR PNG of the same image.
//
// The two codecs get the idiomatic input for each format:
//  - AVIF is a gain-map image: the SDR PNG as its base, plus a gain map that
//    libavif computes (`avifgainmaputil combine`) so that applying it in full
//    reproduces the HDR PNG. The gain map is at the same quality as the base.
//  - JXL encodes the HDR PNG directly, as PQ. (Linear-light JXL displayed
//    closer to the gain map in Chrome, but not at all in Safari, and a lot of
//    the difference turned out to depend on monitor brightness.)
//
// Both are scored against the HDR PNG at full precision. The SDR rendition is
// not scored.

import { access, constants, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { run } from './exec.js';
import { chunks, readHeader } from './png.js';

/**
 * Where a local libavif build is looked for first, falling back to PATH. All
 * three tools come from the same build so the encoder and tone mapper agree.
 */
export const LOCAL_LIBAVIF_DIR =
  process.env.LIBAVIF_BUILD ?? path.join(os.homedir(), 'dev/libavif/build');

/** The libavif tools HDR mode uses, which must all come from the same build. */
export const LIBAVIF_TOOLS = ['avifenc', 'avifdec', 'avifgainmaputil'];

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const HDR_SCORER_DIR = path.join(ROOT, 'tools', 'hdr-ssim2');
export const HDR_SCORER = path.join(HDR_SCORER_DIR, 'target', 'release', 'hdr-ssim2');

/** CICP transfer characteristics: SMPTE ST 2084 (PQ) and the sRGB curve. */
export const PQ = 16;
export const SRGB_TRANSFER = 13;

/** SDR white in PQ, per BT.2408 and libavif's gain-map maths. Display only. */
export const SDR_WHITE_NITS = 203;

/**
 * Tone-map headroom that applies any gain map in full. `combine` caps an
 * image's alternate headroom at 4 stops by default (--max-headroom), and the
 * weight clamps at 1 beyond it, so this always renders the full HDR image.
 */
export const FULL_HEADROOM = 4;

// Markers that identify a gain map in a JPEG: Adobe's XMP namespace (also
// what Android's Ultra HDR writes) and the ISO 21496-1 URN.
const GAIN_MAP_MARKERS = [
  Buffer.from('http://ns.adobe.com/hdr-gain-map/'),
  Buffer.from('urn:iso:std:iso:ts:21496:-1'),
];

/**
 * Does this file look like a JPEG carrying a gain map? Those are no longer an
 * input format, but running one as a plain JPEG would silently throw the HDR
 * away, so the CLI refuses them with a pointer to the PNG flow.
 */
export function hasGainMap(buffer) {
  if (buffer.length < 3 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    return false;
  }
  return GAIN_MAP_MARKERS.some((marker) => buffer.includes(marker));
}

// D50-adapted colorant tags as they appear in real profiles, for the
// primaries CICP can name. Matched to 3 decimals, which is well inside the
// distance between any two of them.
const KNOWN_PRIMARIES = [
  {
    name: 'srgb',
    cicp: 1,
    rXYZ: [0.4361, 0.2225, 0.0139],
    gXYZ: [0.3851, 0.7169, 0.0971],
    bXYZ: [0.1431, 0.0606, 0.7139],
  },
  {
    name: 'p3',
    cicp: 12,
    rXYZ: [0.5151, 0.2412, -0.0011],
    gXYZ: [0.2920, 0.6922, 0.0419],
    bXYZ: [0.1571, 0.0666, 0.7841],
  },
  {
    name: 'bt2020',
    cicp: 9,
    rXYZ: [0.6734, 0.2790, -0.0019],
    gXYZ: [0.1656, 0.6753, 0.0299],
    bXYZ: [0.1251, 0.0457, 0.7973],
  },
];

export const PRIMARIES_BY_CICP = new Map(KNOWN_PRIMARIES.map((p) => [p.cicp, p.name]));

function iccTags(icc) {
  const tags = new Map();
  const count = icc.readUInt32BE(128);
  for (let i = 0; i < count; i += 1) {
    const at = 132 + i * 12;
    const sig = icc.toString('latin1', at, at + 4);
    const offset = icc.readUInt32BE(at + 4);
    const size = icc.readUInt32BE(at + 8);
    tags.set(sig, icc.subarray(offset, offset + size));
  }
  return tags;
}

const s15 = (buffer, at) => buffer.readInt32BE(at) / 65536;
const srgbEotf = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/**
 * Is this ICC TRC tag the sRGB curve? Accepts the parametric form (type 3) and
 * sampled tables, which is how the classic "sRGB IEC61966-2.1" profile stores
 * it. Tolerance 0.002 because Apple's profiles round the parameters (a 0.948,
 * d 0.039) -- still far from any other curve a profile would carry.
 */
function isSrgbCurve(tag) {
  if (!tag) return false;
  const type = tag.toString('latin1', 0, 4);
  if (type === 'para') {
    const params = [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045];
    return tag.readUInt16BE(8) === 3 &&
      params.every((v, i) => Math.abs(s15(tag, 12 + i * 4) - v) < 0.002);
  }
  if (type === 'curv') {
    const count = tag.readUInt32BE(8);
    if (count < 2) return false; // identity or a pure gamma: not sRGB
    for (let i = 0; i < count; i += 1) {
      const x = i / (count - 1);
      if (Math.abs(tag.readUInt16BE(12 + i * 2) / 65535 - srgbEotf(x)) > 0.002) return false;
    }
    return true;
  }
  return false;
}

/**
 * Map an ICC profile to CICP primaries + transfer, or throw.
 *
 * The AVIF gain-map encoder is given CICP rather than the ICC (it needs
 * `--ignore-profile`, which also discards a PNG's cICP chunk), and that is
 * only honest if the profile is exactly one CICP can name. A v4.4 profile's
 * own `cicp` tag (Photoshop's HDR exports carry one) is taken as-is; anything
 * else must be recognisable primaries with the sRGB curve.
 */
export function iccToCicp(icc) {
  const tags = iccTags(icc);
  const cicpTag = tags.get('cicp');
  if (cicpTag && cicpTag.toString('latin1', 0, 4) === 'cicp') {
    return { primaries: cicpTag[8], transfer: cicpTag[9], source: 'ICC cicp tag' };
  }

  const xyz = (sig) => {
    const tag = tags.get(sig);
    if (!tag || tag.toString('latin1', 0, 4) !== 'XYZ ') return null;
    return [s15(tag, 8), s15(tag, 12), s15(tag, 16)];
  };
  const close = (a, b) => a && a.every((v, i) => Math.abs(v - b[i]) < 0.002);
  const match = KNOWN_PRIMARIES.find(
    (p) => close(xyz('rXYZ'), p.rXYZ) && close(xyz('gXYZ'), p.gXYZ) && close(xyz('bXYZ'), p.bXYZ),
  );
  if (!match) {
    throw new Error(
      'ICC profile has primaries that are not sRGB, Display P3 or BT.2020, so they cannot be ' +
        'expressed as CICP.',
    );
  }
  for (const sig of ['rTRC', 'gTRC', 'bTRC']) {
    if (!isSrgbCurve(tags.get(sig))) {
      throw new Error(`ICC profile has a ${sig} that is not the sRGB curve, so it cannot be expressed as CICP.`);
    }
  }
  return { primaries: match.cicp, transfer: SRGB_TRANSFER, source: 'ICC profile' };
}

/** Read a PNG's cICP chunk as `{ primaries, transfer, matrix, fullRange }`, or null. */
export function readCicp(buffer) {
  for (const chunk of chunks(buffer)) {
    if (chunk.type !== 'cICP') continue;
    const d = buffer.subarray(chunk.start + 8, chunk.end - 4);
    return { primaries: d[0], transfer: d[1], matrix: d[2], fullRange: d[3] === 1 };
  }
  return null;
}

/**
 * A PNG's colour as CICP `{ primaries, transfer, source }`, following PNG's own
 * precedence: cICP, then sRGB, then iCCP. With none of them the PNG spec says
 * sRGB, and that is what every browser assumes too.
 */
export function pngColour(buffer) {
  const cicp = readCicp(buffer);
  if (cicp) return { primaries: cicp.primaries, transfer: cicp.transfer, source: 'cICP chunk' };
  let icc = null;
  for (const chunk of chunks(buffer)) {
    if (chunk.type === 'sRGB') return { primaries: 1, transfer: SRGB_TRANSFER, source: 'sRGB chunk' };
    if (chunk.type === 'iCCP') {
      const body = buffer.subarray(chunk.start + 8, chunk.end - 4);
      // Profile name, NUL, compression method byte, then zlib data.
      icc = zlib.inflateSync(body.subarray(body.indexOf(0) + 2));
    }
  }
  if (icc) return iccToCicp(icc);
  return { primaries: 1, transfer: SRGB_TRANSFER, source: 'no colour chunks; assumed sRGB' };
}

/** Is this PNG an HDR (PQ) image? */
export function isHdrPng(buffer) {
  try {
    return pngColour(buffer).transfer === PQ;
  } catch {
    return false;
  }
}

function pngChunk(type, data) {
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * The image-defining chunks only (IHDR, IDAT, IEND) plus a cICP chunk stating
 * `cicp`. Nothing else rides into the JXL: Photoshop's PNGs carry tens of KB
 * of XMP, and a cICP-less one describes PQ only inside its ICC profile.
 */
export function withOnlyCicp(buffer, cicp) {
  const keep = [buffer.subarray(0, 8)];
  for (const chunk of chunks(buffer)) {
    if (chunk.type === 'IHDR') {
      keep.push(buffer.subarray(chunk.start, chunk.end));
      keep.push(pngChunk('cICP', Buffer.from([cicp.primaries, cicp.transfer, 0, 1])));
    } else if (chunk.type === 'IDAT' || chunk.type === 'IEND') {
      keep.push(buffer.subarray(chunk.start, chunk.end));
    }
  }
  return Buffer.concat(keep);
}

/** avifgainmaputil args to render a gain-map AVIF in full, as a 16-bit PQ PNG. */
export function tonemapArgs({ input, output, hdr }) {
  return [
    'tonemap', input, output,
    '--headroom', String(FULL_HEADROOM),
    // -d 12 is the widest the tone mapper offers; PNG stores it as 16-bit.
    '-d', '12',
    '--cicp-output', `${hdr.primaries}/${PQ}/0`,
    '--ignore-exif', '--ignore-xmp',
  ];
}

/**
 * Check the two inputs and write the reference: the HDR PNG's pixels with
 * nothing but a cICP chunk. Returns the reference description the rest of the
 * pipeline uses.
 */
export async function prepareHdrReference({ hdrInput, hdrBytes, sdrInput, sdrBytes, output }) {
  const hdrHeader = readHeader(hdrBytes);
  const sdrHeader = readHeader(sdrBytes);
  for (const [name, header] of [['HDR PNG', hdrHeader], ['SDR PNG', sdrHeader]]) {
    if (header.channels !== 3) {
      throw new Error(`${name} must be RGB without alpha, got ${header.channels} channel(s).`);
    }
    if (header.interlaced) throw new Error(`${name} must not be interlaced.`);
  }
  if (hdrHeader.width !== sdrHeader.width || hdrHeader.height !== sdrHeader.height) {
    throw new Error(
      `HDR PNG is ${hdrHeader.width}x${hdrHeader.height} but SDR PNG is ` +
        `${sdrHeader.width}x${sdrHeader.height}; they must be the same image.`,
    );
  }
  if (hdrHeader.depth !== 16) {
    throw new Error(`HDR PNG must be 16-bit, got ${hdrHeader.depth}-bit.`);
  }

  const hdrColour = pngColour(hdrBytes);
  const sdrColour = pngColour(sdrBytes);
  if (hdrColour.transfer !== PQ || !PRIMARIES_BY_CICP.has(hdrColour.primaries)) {
    throw new Error(
      `HDR PNG must be PQ in sRGB, Display P3 or BT.2020 primaries; its ${hdrColour.source} says ` +
        `${hdrColour.primaries}/${hdrColour.transfer}.`,
    );
  }
  if (sdrColour.transfer !== SRGB_TRANSFER || !PRIMARIES_BY_CICP.has(sdrColour.primaries)) {
    throw new Error(
      `SDR PNG must use the sRGB curve in sRGB, Display P3 or BT.2020 primaries; its ` +
        `${sdrColour.source} says ${sdrColour.primaries}/${sdrColour.transfer}.`,
    );
  }

  await writeFile(output, withOnlyCicp(hdrBytes, hdrColour));
  const peakNits = Number((await run('hdr-ssim2', ['--peak', output])).stdout.trim());

  const hdr = {
    input: hdrInput,
    primaries: hdrColour.primaries,
    primariesName: PRIMARIES_BY_CICP.get(hdrColour.primaries),
    colourSource: hdrColour.source,
    transfer: PQ,
    peakNits,
    headroom: Math.log2(peakNits / SDR_WHITE_NITS),
    sdr: {
      input: sdrInput,
      primaries: sdrColour.primaries,
      transfer: sdrColour.transfer,
      primariesName: PRIMARIES_BY_CICP.get(sdrColour.primaries),
      colourSource: sdrColour.source,
      depth: sdrHeader.depth,
    },
  };

  return {
    path: output,
    width: hdrHeader.width,
    height: hdrHeader.height,
    depth: hdrHeader.depth,
    channels: 3,
    hasAlpha: false,
    megapixels: (hdrHeader.width * hdrHeader.height) / 1e6,
    strippedChunks: [],
    resized: false,
    hdr,
    // AVIF builds a gain-map image from both; JXL encodes the HDR PNG.
    encodeInputs: { avif: { sdr: sdrInput, hdr: output }, jxl: output },
  };
}

/** Every HDR decode must be 16-bit RGB PQ in the run's primaries. */
export function assertHdrImage({ header, cicp, hdr, what }) {
  if (header.depth !== 16 || header.channels !== 3) {
    throw new Error(`${what}: expected a 16-bit RGB PNG, got ${header.depth}-bit with ${header.channels} channel(s).`);
  }
  if (!cicp || cicp.primaries !== hdr.primaries || cicp.transfer !== PQ) {
    throw new Error(
      `${what}: expected cICP ${hdr.primaries}/${PQ} (PQ), got ` +
        `${cicp ? `${cicp.primaries}/${cicp.transfer}` : 'no cICP chunk'}.`,
    );
  }
}

/**
 * Build the HDR scorer, a small Rust wrapper around fast-ssim2's experimental
 * PU21 mode (tools/hdr-ssim2). Runs cargo every time rather than only when the
 * binary is missing, so a source change can't leave a stale scorer behind;
 * it's a no-op when nothing changed.
 */
export async function ensureHdrScorer({ log = () => {} } = {}) {
  const built = await access(HDR_SCORER, constants.X_OK).then(() => true, () => false);
  if (!built) log('Building the HDR scorer (tools/hdr-ssim2, one-off)...');
  try {
    await run('cargo', ['build', '--release', '--quiet', '--manifest-path', path.join(HDR_SCORER_DIR, 'Cargo.toml')]);
  } catch (error) {
    throw new Error(
      `Could not build tools/hdr-ssim2 (needs cargo): ${error.message}\n` +
        `Build it by hand with: cargo build --release --manifest-path ${path.relative(process.cwd(), path.join(HDR_SCORER_DIR, 'Cargo.toml'))}`,
    );
  }
  return HDR_SCORER;
}
