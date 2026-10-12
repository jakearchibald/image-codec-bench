// JPEG bitstream helpers for the JPEG -> JXL transcode tool.

/** APP0..APP15 and COM: the segments that carry metadata rather than image data. */
function isMetadataMarker(marker) {
  return (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
}

/** Markers that stand alone, with no length field. */
function isStandalone(marker) {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9);
}

/**
 * Every marker segment in a JPEG, as `{ marker, offset, length }` (length
 * includes the marker). Walks the entropy-coded data after each SOS too,
 * since a progressive file has tables and further scans in between.
 */
export function jpegSegments(buffer) {
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) throw new Error('Not a JPEG (no SOI marker)');
  const segments = [{ marker: 0xd8, offset: 0, length: 2 }];
  let i = 2;
  while (i < buffer.length) {
    if (buffer[i] !== 0xff) throw new Error(`Expected a marker at byte ${i}`);
    // Any number of 0xff fill bytes may precede a marker.
    while (buffer[i] === 0xff) i += 1;
    const marker = buffer[i];
    const offset = i - 1;
    i += 1;
    if (marker === 0xd9) {
      segments.push({ marker, offset, length: 2 });
      break;
    }
    if (isStandalone(marker)) {
      segments.push({ marker, offset, length: 2 });
      continue;
    }
    const length = buffer.readUInt16BE(i);
    segments.push({ marker, offset, length: length + 2 });
    i += length;
    if (marker === 0xda) {
      // Entropy-coded data runs to the next marker that isn't a stuffed zero
      // or a restart marker.
      while (i < buffer.length) {
        if (buffer[i] === 0xff && buffer[i + 1] !== 0x00 && !(buffer[i + 1] >= 0xd0 && buffer[i + 1] <= 0xd7)) {
          break;
        }
        i += 1;
      }
    }
  }
  return segments;
}

/** The metadata segments (APPn, COM) in a JPEG, as marker names. */
export function jpegMetadata(buffer) {
  return jpegSegments(buffer)
    .filter((s) => isMetadataMarker(s.marker))
    .map((s) => (s.marker === 0xfe ? 'COM' : `APP${s.marker - 0xe0}`));
}

/**
 * The candidate to keep: smallest file, ties to the lowest effort since it is
 * the cheaper encode for the same bytes.
 */
export function smallest(candidates) {
  return candidates.reduce((best, c) =>
    c.bytes < best.bytes || (c.bytes === best.bytes && c.effort < best.effort) ? c : best,
  );
}
