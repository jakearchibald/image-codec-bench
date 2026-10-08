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
 * Resolves to `{ quality, score }`, or null if even `max` falls short.
 */
export async function searchQuality({ min, max, step, target, probe, known = new Map() }) {
  const count = Math.round((max - min) / step) + 1;
  const qualityAt = (i) => Math.round((min + i * step) * 1e6) / 1e6;
  const scoreAt = async (i) => {
    const quality = qualityAt(i);
    if (!known.has(quality)) known.set(quality, await probe(quality));
    return known.get(quality);
  };

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

  while (hi - lo > 1) {
    let mid = Math.floor((lo + hi) / 2);
    if (lo >= 0 && hi < count) {
      const loScore = known.get(qualityAt(lo));
      const hiScore = known.get(qualityAt(hi));
      if (hiScore > loScore) {
        const guess = Math.ceil(lo + ((target - loScore) / (hiScore - loScore)) * (hi - lo));
        const margin = Math.max(1, Math.floor((hi - lo) / 8));
        mid = Math.min(hi - margin, Math.max(lo + margin, guess));
        mid = Math.min(hi - 1, Math.max(lo + 1, mid));
      }
    }
    if ((await scoreAt(mid)) >= target) hi = mid;
    else lo = mid;
  }

  // Still the virtual end: `max` itself was probed and fell short.
  if (hi === count) return null;
  return { quality: qualityAt(hi), score: known.get(qualityAt(hi)) };
}
