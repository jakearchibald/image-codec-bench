// Browser decode timing via createImageBitmap, driven over the Chrome DevTools
// Protocol (plan.md §3).
//
// Why a browser at all: decode speed is a property of the decoder a *user*
// actually runs, and avifdec/djxl are not that decoder. createImageBitmap is
// the closest thing to an isolated decode in the platform -- no layout, no
// paint, no CSS scaling -- and it resolves only once the image is fully
// decoded, so awaiting it measures the decode and nothing else.
//
// Why Chrome Canary specifically: verified on this machine that Canary 156
// decodes JPEG XL through createImageBitmap while stable Chrome 153 fails with
// "The source image could not be decoded". Canary needs no flag for it --
// `--disable-features=JXL` still decodes -- so the requirement is the channel,
// not a switch. Without JXL the decode chart would only cover AVIF, which
// defeats the point of comparing.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { openSession } from './webdriver.js';

const MIME = {
  '.avif': 'image/avif',
  '.jxl': 'image/jxl',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.html': 'text/html; charset=utf-8',
};

/** How many files share one Runtime.evaluate call. */
const BATCH_SIZE = 20;

/**
 * Iterations discarded before measuring. The first decode of a given codec
 * carries one-off costs -- codec init, JIT -- and measured 5.0ms against a
 * 2.0ms steady state on a JXL file.
 */
export const WARMUP_RUNS = 2;

/**
 * Stop collecting once this much time has gone into one image, provided
 * MIN_RUNS samples are in hand. Decodes are milliseconds at small sizes but
 * hundreds of milliseconds at full resolution, where 20 runs per image across
 * a full grid would add up to many minutes.
 */
export const DEFAULT_BUDGET_MS = 2000;
export const MIN_RUNS = 5;

/**
 * Methodology version for a stored decode measurement. Bump this whenever what
 * is measured or how it is summarised changes, so existing runs re-measure
 * instead of mixing methodologies in one chart.
 *
 * 1: best-of-5, no spread recorded.
 * 2: mean of up to 20 after discarded warm-up, with median/sd/cv.
 * 3: keyed per browser, driven over classic WebDriver.
 */
export const DECODE_SCHEMA = 3;

/**
 * Decode timings are only comparable within one browser build, and Canary
 * updates most days, so the build string is stored alongside each measurement
 * and used to decide staleness. It is deliberately *not* part of the job cache
 * key: a Canary update would otherwise invalidate every encode too, throwing
 * away hours of work to re-measure something unrelated.
 */
export function decodeIsStale(row, browserName, browserVersion) {
  const measured = row?.decode?.[browserName];
  if (!measured) return true;
  // Measured under an older methodology: the numbers are not comparable with
  // current ones, and the fields the report expects may not even be there.
  if (measured.schema !== DECODE_SCHEMA) return true;
  return measured.browser !== browserVersion;
}

/**
 * Is this value a decode measurement, as opposed to a leftover field?
 *
 * `decode` used to be a single flat measurement (schema 2) before it became a
 * map keyed by browser (schema 3). Merging a new measurement into an old row
 * left the flat fields sitting as siblings of the browser keys, so "every key
 * of decode" is not the same as "every browser measured".
 */
function isMeasurement(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (typeof value.meanMs === 'number' || typeof value.bestMs === 'number')
  );
}

/**
 * Keep only per-browser measurements, discarding schema-2 leftovers. Used
 * before merging a new measurement in, so the old shape doesn't accumulate.
 */
export function cleanDecodeMap(decode) {
  if (!decode) return {};
  return Object.fromEntries(Object.entries(decode).filter(([, value]) => isMeasurement(value)));
}

/**
 * Remove stored decode measurements for `names`, or for every browser present
 * when `names` includes 'all'. Mutates `data`; returns a count per browser.
 *
 * Exists because dropping one browser's results by hand is a fiddly edit: the
 * measurements are nested per row, they live in two files, and the run metadata
 * separately lists which browsers were used -- leaving that behind makes the
 * report advertise data that is gone.
 */
export function dropDecodeFromData(data, names) {
  const wantsAll = names.includes('all');
  const removed = {};

  for (const row of [...(data.jobs ?? []), ...(data.lossless ?? [])]) {
    if (!row.decode) continue;
    for (const [name, value] of Object.entries(row.decode)) {
      // Only real measurements count as browsers. Without this, schema-2
      // leftovers get reported as browsers named "meanMs", "sdMs" and so on.
      if (!isMeasurement(value)) {
        // Dropping everything is also a chance to clear that residue out.
        if (wantsAll) delete row.decode[name];
        continue;
      }
      if (!wantsAll && !names.includes(name)) continue;
      removed[name] = (removed[name] ?? 0) + 1;
      delete row.decode[name];
    }
    // Drop the container once empty, so a row with nothing measured looks the
    // same as one that never had anything.
    if (Object.keys(row.decode).length === 0) delete row.decode;
  }

  const targets = data.run?.browsers?.targets;
  if (targets) {
    for (const name of Object.keys(targets)) {
      if (wantsAll || names.includes(name)) delete targets[name];
    }
    if (Object.keys(targets).length === 0) data.run.browsers = null;
  }

  return removed;
}

/** Serve `rootDir` read-only on a random localhost port. */
async function serveDirectory(rootDir) {
  const server = createServer(async (req, res) => {
    const relative = decodeURIComponent(req.url.split('?')[0]);

    // The benchmark page itself. Served rather than left to 404: the harness
    // navigates here first, and a failed navigation leaves the document on an
    // error page whose origin cannot fetch anything -- which shows up as
    // "TypeError: Failed to fetch" for every image and looks like a broken
    // decoder rather than a broken harness.
    if (relative === '/' || relative === '/index.html') {
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
      res.end('<!doctype html><meta charset="utf-8"><title>decode benchmark</title>');
      return;
    }

    try {
      const file = path.join(rootDir, relative);
      // Don't serve outside the run directory.
      if (!file.startsWith(path.resolve(rootDir))) {
        res.writeHead(403);
        res.end();
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        // No caching: a decoded-image cache hit would read as a 0ms decode.
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/**
 * The in-page benchmark, as a classic-WebDriver async script.
 *
 * WebDriver hands the script a callback as its last argument, so the body ends
 * by calling it rather than returning a promise.
 *
 * Fetched once into an ArrayBuffer so the network is never on the clock, then
 * re-wrapped in a fresh Blob per iteration -- verified that repeat timings stay
 * flat and non-zero this way, i.e. nothing is served from a decoded-image
 * cache. Warm-up iterations are run and discarded, then samples are collected
 * until the repeat count or the time budget is reached.
 */
function benchmarkScript({ repeats, warmup, budgetMs, minRuns }) {
  return `
    const urls = arguments[0];
    const done = arguments[arguments.length - 1];
    (async () => {
      const out = {};
      const decode = async (buffer) => {
        const blob = new Blob([buffer.slice(0)]);
        const started = performance.now();
        const bitmap = await createImageBitmap(blob);
        const elapsed = performance.now() - started;
        bitmap.close();
        return elapsed;
      };
      for (const entry of urls) {
        try {
          const buffer = await (await fetch(entry.url)).arrayBuffer();
          const warmupMs = [];
          for (let i = 0; i < ${warmup}; i += 1) warmupMs.push(await decode(buffer));
          const samples = [];
          let spent = 0;
          while (samples.length < ${repeats}) {
            const elapsed = await decode(buffer);
            samples.push(elapsed);
            spent += elapsed;
            if (samples.length >= ${minRuns} && spent > ${budgetMs}) break;
          }
          out[entry.key] = { samples: samples, warmupMs: warmupMs };
        } catch (error) {
          out[entry.key] = { error: error.name + ': ' + error.message };
        }
      }
      return out;
    })().then(done, (error) => done({ __fatal: String(error) }));
  `;
}

/** Report the timer granularity, which bounds how fine a decode can be read. */
const TIMER_SCRIPT = `
  const done = arguments[arguments.length - 1];
  const deltas = new Set();
  let last = performance.now();
  for (let i = 0; i < 200000; i += 1) {
    const now = performance.now();
    if (now !== last) { deltas.add(Number((now - last).toFixed(6))); last = now; }
  }
  done(Math.min.apply(null, Array.from(deltas)));
`;

/**
 * Measure decode time for each entry of `targets` ({ key, url } relative to
 * `rootDir`) in one browser.
 *
 * Runs serially with nothing else in flight, for the same reason the encode
 * phase does: a decode timed against a busy machine is not a decode timing.
 */
export async function measureDecodeTimes({
  target,
  rootDir,
  targets,
  repeats = 20,
  warmup = WARMUP_RUNS,
  budgetMs = DEFAULT_BUDGET_MS,
  onProgress = () => {},
}) {
  if (targets.length === 0) return { results: new Map() };

  const { server, origin } = await serveDirectory(rootDir);
  let session = null;

  try {
    session = await openSession({
      driverPath: target.driverPath,
      capabilities: target.capabilities,
    });

    // Navigate before running anything: a blank document has no origin that
    // can fetch, which shows up as a fetch failure for every image and looks
    // exactly like a broken decoder.
    await session.navigate(`${origin}/`);

    const timerGranularityMs = await session.executeAsync(TIMER_SCRIPT).catch(() => null);

    const results = new Map();
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      const batch = targets.slice(i, i + BATCH_SIZE);
      const urls = batch.map(({ key, url }) => ({
        key,
        url: `${origin}/${url.split(path.sep).join('/')}`,
      }));

      const value = await session.executeAsync(
        benchmarkScript({ repeats, warmup, budgetMs, minRuns: Math.min(MIN_RUNS, repeats) }),
        [urls],
      );

      if (value?.__fatal) throw new Error(`Decode benchmark threw: ${value.__fatal}`);

      for (const [key, entry] of Object.entries(value ?? {})) {
        results.set(
          key,
          entry.error ? { error: entry.error } : summarise(entry.samples, entry.warmupMs),
        );
      }
      onProgress(Math.min(i + batch.length, targets.length), targets.length);
    }

    return { results, version: session.version, timerGranularityMs };
  } finally {
    await session?.quit().catch(() => {});
    server.close();
  }
}

/**
 * Summarise decode samples. The headline is the **mean**, not best-of-N.
 *
 * Encode timings use best-of-N because process-spawn noise is one-sided --
 * interference only ever makes a run slower. Browser decode is not like that:
 * over 60 runs the minimum for a lossless JXL came out at 9.6ms against a
 * 14.1ms median, a 33% underestimate, because the spread goes both ways
 * (thread scheduling, and performance.now() quantised to 0.1ms). Taking the
 * minimum there reports a decode nobody actually experiences.
 *
 * The median and standard deviation come along so the spread stays visible
 * rather than being hidden behind a single number.
 */
export function summarise(samples, warmupMs = []) {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = sorted.reduce((sum, ms) => sum + (ms - mean) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  const round = (ms) => Number(ms.toFixed(4));

  return {
    schema: DECODE_SCHEMA,
    meanMs: mean,
    medianMs: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
    minMs: sorted[0],
    maxMs: sorted[n - 1],
    sdMs: sd,
    // Relative spread, so a noisy measurement is obvious without comparing
    // against the absolute scale of the image.
    cvPercent: mean > 0 ? (sd / mean) * 100 : 0,
    runs: n,
    warmupMs: warmupMs.map(round),
    samplesMs: sorted.map(round),
  };
}
