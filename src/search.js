// Quality search for a target score: the lowest quality whose score reaches
// the target. Used by src/target.js.
//
// Assumes score rises with quality, which holds closely but not exactly; where
// it doesn't, the result is still a quality that reaches the target, just not
// necessarily the lowest one.

/**
 * Find the lowest quality on the grid `min, min + step, ..., max` scoring at
 * least `target`. `probe(quality)` resolves to a score; `known` is a Map of
 * quality -> score already measured (shared across targets in a series, so a
 * second target starts from a tight bracket), and is filled in as it goes.
 *
 * Bisects, but where both ends of the bracket have scores, probes at the
 * interpolated quality instead (kept away from the ends so a bad guess still
 * halves-ish the bracket). Scores are close to linear over a narrow bracket,
 * so this usually lands in two or three probes.
 *
 * With a `tolerance`, the first quality scoring within it of the target (on
 * either side) is good enough, for quick looks where the exact step doesn't
 * matter.
 *
 * Resolves to `{ quality, score }`, or null if even `max` falls short.
 */
export async function searchQuality({ min, max, step, target, probe, known = new Map(), tolerance = 0 }) {
  const count = Math.round((max - min) / step) + 1;
  const qualityAt = (i) => Math.round((min + i * step) * 1e6) / 1e6;
  const scoreAt = async (i) => {
    const quality = qualityAt(i);
    if (!known.has(quality)) known.set(quality, await probe(quality));
    return known.get(quality);
  };

  if (tolerance > 0) {
    let close = null;
    for (const [quality, score] of known) {
      if (Math.abs(score - target) <= tolerance && (!close || Math.abs(score - target) < Math.abs(close.score - target))) {
        close = { quality, score };
      }
    }
    if (close) return close;
  }

  // Bracket from what is already known. `lo` fails, `hi` passes; -1 and
  // `count` are virtual ends, standing for "below the grid" and "unreached".
  let lo = -1;
  let hi = count;
  for (let i = 0; i < count; i += 1) {
    const score = known.get(qualityAt(i));
    if (score !== undefined && score < target) lo = i;
  }
  for (let i = count - 1; i > lo; i -= 1) {
    const score = known.get(qualityAt(i));
    if (score !== undefined && score >= target) hi = i;
  }

  // With only one end of the bracket measured, step out from it, doubling
  // each time, rather than bisecting towards the far end of the grid: the
  // answer is usually near what's already known (a previous target, or the
  // previous setting's answer), and the far end can be very slow to encode.
  let gap = Math.max(1, Math.floor(count / 16));
  while (hi - lo > 1) {
    let mid = Math.floor((lo + hi) / 2);
    if (lo >= 0 && hi === count) {
      mid = Math.min(count - 1, lo + gap);
      gap *= 2;
    } else if (lo === -1 && hi < count) {
      mid = Math.max(0, hi - gap);
      gap *= 2;
    } else if (lo >= 0 && hi < count) {
      const loScore = known.get(qualityAt(lo));
      const hiScore = known.get(qualityAt(hi));
      if (hiScore > loScore) {
        const guess = Math.ceil(lo + ((target - loScore) / (hiScore - loScore)) * (hi - lo));
        const margin = Math.max(1, Math.floor((hi - lo) / 8));
        mid = Math.min(hi - margin, Math.max(lo + margin, guess));
        mid = Math.min(hi - 1, Math.max(lo + 1, mid));
      }
    }
    const score = await scoreAt(mid);
    if (tolerance > 0 && Math.abs(score - target) <= tolerance) return { quality: qualityAt(mid), score };
    if (score >= target) hi = mid;
    else lo = mid;
  }

  // Still the virtual end: `max` itself was probed and fell short.
  if (hi === count) return null;
  return { quality: qualityAt(hi), score: known.get(qualityAt(hi)) };
}
