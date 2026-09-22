// The lossless table (plan.md §7): AVIF, JXL and WebP at max effort.
//
// Each output is decoded and asserted bit-exact against the reference *and*
// asserted to score exactly 100.00. Either check failing aborts the run rather
// than reporting a bogus "lossless" size -- a table claiming losslessness has
// to earn it.
//
// Bit-exactness is compared on *raw pixels*, not PNG file bytes: two PNGs can
// encode identical pixels with different filtering and compression, so
// comparing files would produce false failures (verified during the spike).

import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { jobKey } from './cache.js';
import { losslessCodecs } from './codecs/index.js';
import { run as exec } from './exec.js';
import { CANONICAL_THREADS } from './run.js';
import { assertLosslessScore, decodeAndScore } from './score.js';

/**
 * Extract raw RGBA pixels via ImageMagick so codecs with different PNG writers
 * can still be compared bit-for-bit.
 */
async function rawPixels(imagePath, outPath) {
  await exec('magick', [imagePath, '-depth', '8', `RGBA:${outPath}`]);
  return readFile(outPath);
}

/** Compare decoded pixels against the reference's pixels. */
async function isBitExact(referencePixels, decodedPath, tempDir) {
  const rawPath = path.join(tempDir, `${path.basename(decodedPath)}.rgba`);
  try {
    const pixels = await rawPixels(decodedPath, rawPath);
    return pixels.equals(referencePixels);
  } finally {
    await rm(rawPath, { force: true });
  }
}

/**
 * Run the lossless suite. Returns one row per codec, or a skip entry where the
 * codec can't handle the image (WebP's 16,383px cap).
 */
export async function losslessSuite({
  reference,
  referenceHeader,
  referenceHash,
  versions = {},
  config,
  assetsDir,
  tempDir,
  hasWebp = true,
  cachedRows = [],
  force = false,
  log = () => {},
}) {
  await mkdir(assetsDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });

  const cachedByKey = new Map(
    (cachedRows ?? []).filter((row) => row.key).map((row) => [row.key, row]),
  );

  // Reuse before doing any work: `avifenc --lossless -s 0` is the single most
  // expensive encode in the whole tool (minutes at full resolution), so a
  // resume that re-ran it would make --force the only sane way to work.
  const reusable = async (key) => {
    if (force) return null;
    const row = cachedByKey.get(key);
    if (!row || row.skipped) return null;
    // The row is only usable if its bitstream is still on disk: the report
    // links it directly, so a stale row would produce a broken image.
    if (!row.bitstream) return null;
    try {
      await stat(path.join(path.dirname(assetsDir), row.bitstream));
      return row;
    } catch {
      return null;
    }
  };

  const rows = [];
  let referencePixels = null;
  const referenceRaw = path.join(tempDir, 'reference.rgba');

  try {
    for (const codec of losslessCodecs) {
      if (codec.name === 'webp' && !hasWebp) {
        rows.push({
          codec: codec.name,
          skipped: true,
          warning: 'cwebp/dwebp not installed; WebP row omitted.',
        });
        continue;
      }

      const support = codec.checkSupport({
        width: referenceHeader.width,
        height: referenceHeader.height,
      });
      if (!support.supported) {
        // Skip with a warning rather than failing the whole grid (plan.md §7).
        for (const warning of support.warnings) log(warning);
        rows.push({ codec: codec.name, skipped: true, warning: support.warnings.join(' ') });
        continue;
      }

      // One point per configured effort level: lossless size and lossless
      // encode time trade off against each other, and a single point per codec
      // hides the whole curve.
      const points = codec.losslessConfigs(config[codec.name]?.effort);

      for (const settings of points) {
      const output = path.join(
        assetsDir,
        `lossless-${codec.name}-${settings.effortLabel}.${codec.extension}`,
      );
      const key = jobKey({
        referenceHash,
        codec: codec.name,
        params: { lossless: true, effort: settings.effort ?? null, label: settings.label },
        versions,
        extra: { timing: config.timing },
      });

      const cached = await reusable(key);
      if (cached) {
        rows.push(cached);
        log(`lossless ${settings.label}: ${cached.bytes} bytes (cached)`);
        continue;
      }

      const timings = {};
      const scratch = path.join(
        tempDir,
        `lossless-${codec.name}-${settings.effortLabel}.timing.${codec.extension}`,
      );

      const encodeTo = (target, threads) =>
        exec(
          codec.encoder,
          codec.buildEncodeArgs({
            input: reference.path,
            output: target,
            effort: settings.effort,
            lossless: true,
            threads,
          }),
        );

      // Canonical encode, exactly as in the lossy sweep: `avifenc --lossless`
      // is also thread-dependent (353,489 vs 353,496 bytes measured), so the
      // timing sweep must not be able to replace the file we report.
      const canonical = await encodeTo(output, CANONICAL_THREADS);
      for (const mode of config.timing) {
        const ms = mode === CANONICAL_THREADS
          ? canonical.ms
          : (await encodeTo(scratch, mode)).ms;
        timings[mode] = { bestMs: ms, meanMs: ms, runs: 1, canonical: mode === CANONICAL_THREADS };
      }
      await rm(scratch, { force: true });

      const { size: bytes } = await stat(output);

      // Only now is the raw-pixel reference needed, so a fully cached suite
      // never pays for the magick round-trip.
      if (referencePixels === null) {
        referencePixels = await rawPixels(reference.path, referenceRaw);
      }

      const scored = await decodeAndScore({
        codec,
        bitstream: output,
        reference: reference.path,
        referenceHeader,
        workDir: tempDir,
        keepDecoded: true,
      });

      let bitExact = false;
      try {
        bitExact = await isBitExact(referencePixels, scored.decodedPath, tempDir);
      } finally {
        await rm(scored.decodedPath, { force: true });
      }

      // Both assertions are hard failures: a "lossless" row that isn't
      // lossless is worse than no row at all.
      assertLosslessScore(scored.score, settings.label);
      if (!bitExact) {
        throw new Error(
          `${settings.label}: round-trip is not bit-exact against the reference. ` +
            (codec.name === 'webp'
              ? 'For WebP this usually means -exact was dropped (plan.md §2 finding 6).'
              : 'The encode claimed lossless but pixels changed.'),
        );
      }

      rows.push({
        key,
        codec: codec.name,
        effort: settings.effort ?? null,
        effortLabel: settings.effortLabel ?? null,
        label: settings.label,
        bytes,
        bpp: (bytes * 8) / (referenceHeader.width * referenceHeader.height),
        score: scored.score,
        bitExact,
        timings,
        bitstream: path.relative(path.dirname(assetsDir), output),
        skipped: false,
      });
      log(`lossless ${settings.label}: ${bytes} bytes, score ${scored.score.toFixed(2)}, bit-exact`);
      }
    }
  } finally {
    await rm(referenceRaw, { force: true });
  }

  // The source PNG, for reference -- not a codec result, so no score. Rebuilt
  // every run rather than cached by key, since it is just a stat of a file we
  // already have.
  const { size: sourceBytes } = await stat(reference.path);
  const cachedSource = (cachedRows ?? []).find((row) => row.codec === 'png');
  rows.push({
    codec: 'png',
    label: 'source PNG (normalised reference)',
    bytes: sourceBytes,
    bpp: (sourceBytes * 8) / (referenceHeader.width * referenceHeader.height),
    score: null,
    bitExact: null,
    timings: {},
    // Carry over any decode measurement. Being rebuilt each run would
    // otherwise drop it, and this row would be the one image re-measured in
    // the browser on every resume.
    ...(!force && cachedSource?.decode ? { decode: cachedSource.decode } : {}),
    isSource: true,
    skipped: false,
  });

  // Grouped by codec and ordered by effort, so each codec reads as a curve.
  // Sorting purely by size would interleave the codecs and hide that shape.
  rows.sort((a, b) => {
    if (a.skipped !== b.skipped) return a.skipped ? 1 : -1;
    if (a.isSource !== b.isSource) return a.isSource ? 1 : -1;
    return (
      String(a.codec).localeCompare(String(b.codec)) ||
      (a.effort ?? 0) - (b.effort ?? 0)
    );
  });

  return rows;
}
