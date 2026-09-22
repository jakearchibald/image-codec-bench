import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_TARGETS, TARGETS, parseTargets, resolveTarget } from '../src/browsers.js';
import { DECODE_SCHEMA, decodeIsStale, summarise } from '../src/decode.js';

test('summarise reports the mean, with the spread alongside', () => {
  // The headline is the mean, not the minimum. Browser decode varies both ways
  // -- measured over 60 runs, a lossless JXL had a 9.6ms minimum against a
  // 14.1ms median -- so best-of-N reports a decode nobody experiences.
  const stats = summarise([2.6, 2.4, 2.0, 2.4, 2.6], [5.1, 2.9]);
  assert.equal(stats.runs, 5);
  assert.equal(stats.meanMs, 2.4);
  assert.equal(stats.medianMs, 2.4);
  assert.equal(stats.minMs, 2.0);
  assert.equal(stats.maxMs, 2.6);
  assert.ok(stats.sdMs > 0 && stats.cvPercent > 0, 'spread is reported, not hidden');
  // Warm-up samples are kept for the record but excluded from every statistic.
  assert.deepEqual(stats.warmupMs, [5.1, 2.9]);
  assert.ok(stats.maxMs < 5.1, 'the warm-up outlier must not reach the summary');
});

test('summarise takes the median of an even sample count', () => {
  const stats = summarise([1, 2, 3, 4]);
  assert.equal(stats.medianMs, 2.5);
  assert.equal(stats.meanMs, 2.5);
});

test('summarise is robust to a single slow outlier', () => {
  // A stray 4.5ms against a 2.6ms base was observed in real samples. The mean
  // absorbs it; the median should barely move.
  const clean = summarise([2.5, 2.6, 2.6, 2.7, 2.6]);
  const withOutlier = summarise([2.5, 2.6, 2.6, 2.7, 4.5]);
  assert.ok(withOutlier.meanMs > clean.meanMs);
  assert.equal(withOutlier.medianMs, 2.6, 'median holds steady');
  assert.ok(withOutlier.cvPercent > clean.cvPercent, 'and the noise is visible in cv');
});

test('decode staleness is per browser, and per browser build', () => {
  // Browsers update constantly, and decode times are only comparable within one
  // build. The build is stamped on each measurement rather than folded into the
  // job cache key, where it would also invalidate every encode and throw away
  // hours of work.
  const row = {
    decode: {
      chrome: { schema: DECODE_SCHEMA, meanMs: 2, browser: 'chrome 156.0.8068.0' },
    },
  };
  assert.equal(decodeIsStale(row, 'chrome', 'chrome 156.0.8068.0'), false);
  assert.equal(decodeIsStale(row, 'chrome', 'chrome 157.0.8100.0'), true);
  // Measured in Chrome says nothing about Firefox.
  assert.equal(decodeIsStale(row, 'firefox', 'firefox 158.0a1'), true);
});

test('a row with no decode measurement is stale', () => {
  assert.equal(decodeIsStale({}, 'chrome', 'any'), true);
  assert.equal(decodeIsStale(undefined, 'chrome', 'any'), true);
});

test('parseTargets normalises order and understands all/none', () => {
  assert.deepEqual(parseTargets('firefox,chrome'), ['chrome', 'firefox']);
  assert.deepEqual(parseTargets('chrome,chrome'), ['chrome']);
  assert.deepEqual(parseTargets('all'), ['chrome', 'firefox', 'safari']);
  assert.deepEqual(parseTargets('none'), []);
  // Firefox by default: its 0.02ms timer granularity beats Chrome's 0.1ms,
  // which matters when the fastest decodes are around 1ms.
  assert.deepEqual(DEFAULT_TARGETS, ['firefox']);
});

test('parseTargets rejects an unknown browser by name', () => {
  assert.throws(() => parseTargets('edge'), /Unknown decode browser 'edge'/);
  assert.throws(() => parseTargets('none,chrome'), /cannot be combined/);
});

test('every target declares how to drive it', () => {
  for (const [name, target] of Object.entries(TARGETS)) {
    assert.ok(target.driver, `${name} needs a driver`);
    assert.equal(typeof target.capabilities, 'function', `${name} needs capabilities`);
    assert.equal(typeof target.headless, 'boolean', `${name} must state headlessness`);
    const caps = target.capabilities('/some/binary');
    assert.ok(caps.browserName, `${name} capabilities need browserName`);
  }
});

test('Firefox capabilities carry the two prefs the measurement depends on', () => {
  const prefs = TARGETS.firefox.capabilities('/bin/firefox')['moz:firefoxOptions'].prefs;
  // JXL is behind a flag; without it half the chart is missing.
  assert.equal(prefs['image.jxl.enabled'], true);
  // Firefox otherwise clamps performance.now() to 1ms, which is useless for
  // decodes that take 1-20ms.
  assert.equal(prefs['privacy.reduceTimerPrecision'], false);
});

test('Safari is declared non-headless, with a setup hint', () => {
  // It cannot be enabled programmatically, so the hint is the only way a user
  // finds out why the session was refused.
  assert.equal(TARGETS.safari.headless, false);
  assert.match(TARGETS.safari.setupHint, /Allow Remote Automation/);
});

test('resolveTarget reports unavailability instead of throwing', async () => {
  // A browser that isn't installed costs a note, not a failed run.
  const resolved = await resolveTarget('firefox', {
    browser: '/nope/firefox',
    driver: '/nope/gecko',
  });
  // An explicit path that does not exist is reported here, not left to fail
  // later as an opaque driver error.
  assert.match(resolved.unavailable, /does not exist/);
  assert.equal(resolved.name, 'firefox');
});

test('the lossless table gains a decode column only when measured', async () => {
  const { formatLosslessTable, losslessToCsv } = await import('../src/table.js');
  const rows = [
    { codec: 'jxl', label: 'cjxl -d 0 -e 9', bytes: 333450, bpp: 13.5, score: 100,
      bitExact: true, timings: { multi: { bestMs: 480 } } },
    { codec: 'png', label: 'source PNG', bytes: 343865, bpp: 13.9, score: null,
      bitExact: null, timings: {}, isSource: true },
  ];

  assert.doesNotMatch(formatLosslessTable(rows, ['multi']), /dec /);
  assert.doesNotMatch(losslessToCsv(rows, ['multi']), /decode_/);

  const measured = rows.map((row, i) => ({
    ...row,
    decode: { chrome: { meanMs: [14.4, 1.0][i], sdMs: 0.5, runs: 20 } },
  }));
  const table = formatLosslessTable(measured, ['multi']);
  // One column per browser that measured something.
  assert.match(table, /dec chrome/);
  // At or above 10ms a whole millisecond is precise enough...
  assert.match(table, /\b14ms\b/);
  // ...but below it a decimal is kept, since browser decodes live in single
  // digits where rounding would hide most of the difference between codecs.
  assert.match(table, /1\.0ms/);
  const csv = losslessToCsv(measured, ['multi']);
  assert.match(csv, /decode_chrome_mean_ms/);
  // The spread and run count travel with the mean, so a noisy row is
  // identifiable from the data file alone.
  assert.match(csv, /decode_chrome_sd_ms/);
  assert.match(csv, /decode_chrome_runs/);
});

test('a skipped lossless row still lines up with the decode column', async () => {
  const { formatLosslessTable } = await import('../src/table.js');
  const rows = [
    { codec: 'jxl', label: 'cjxl', bytes: 100, bpp: 1, score: 100, bitExact: true,
      timings: { multi: { bestMs: 1 } }, decode: { chrome: { meanMs: 2 } } },
    { codec: 'webp', label: 'cwebp', skipped: true, warning: 'too big' },
  ];
  const lines = formatLosslessTable(rows, ['multi']).split('\n');
  // A ragged row would throw in the width calculation or silently shift cells.
  const columns = lines.map((line) => line.trim().split(/\s{2,}/).length);
  assert.equal(new Set(columns).size, 1, `column counts differ: ${columns}`);
});

test('decode measurements from an older methodology are stale', async () => {
  const { DECODE_SCHEMA } = await import('../src/decode.js');
  const browser = 'Google Chrome 156.0.8068.0 canary';

  // Regression: staleness compared only the browser version, so a measurement
  // taken under the old best-of-5 methodology survived a re-run on the same
  // browser. It then sat in the chart alongside current numbers, and the
  // report's tooltip threw on the standard deviation it did not have.
  // Schema 1 (flat, best-of-5) and schema 2 (flat, with spread) both predate
  // per-browser keying, so neither can satisfy a lookup by browser name.
  const schema1 = { decode: { bestMs: 2, meanMs: 2.4, runs: 5, browser } };
  assert.equal(decodeIsStale(schema1, 'chrome', browser), true);

  const schema2 = { decode: { schema: 2, meanMs: 2.4, sdMs: 0.2, browser } };
  assert.equal(decodeIsStale(schema2, 'chrome', browser), true);

  const current = {
    decode: { chrome: { schema: DECODE_SCHEMA, meanMs: 2.4, sdMs: 0.2, browser } },
  };
  assert.equal(decodeIsStale(current, 'chrome', browser), false);
});

test('summarise stamps the methodology version', async () => {
  const { DECODE_SCHEMA } = await import('../src/decode.js');
  assert.equal(summarise([1, 2, 3]).schema, DECODE_SCHEMA);
});

test('dropDecodeFromData removes one browser and leaves the rest', async () => {
  const { dropDecodeFromData } = await import('../src/decode.js');
  const measurement = (ms) => ({ schema: DECODE_SCHEMA, meanMs: ms, sdMs: 0.1, runs: 20 });
  const data = {
    run: { browsers: { targets: { chrome: {}, firefox: {}, safari: {} } } },
    jobs: [{ key: 'a', score: 70, decode: { chrome: measurement(1), firefox: measurement(2) } }],
    lossless: [{ codec: 'jxl', decode: { chrome: measurement(3), safari: measurement(4) } }],
  };

  const removed = dropDecodeFromData(data, ['chrome']);
  assert.deepEqual(removed, { chrome: 2 }, 'counts jobs and lossless rows together');
  assert.deepEqual(Object.keys(data.jobs[0].decode), ['firefox']);
  assert.deepEqual(Object.keys(data.lossless[0].decode), ['safari']);
  // Metadata must not advertise a browser whose data is gone.
  assert.deepEqual(Object.keys(data.run.browsers.targets), ['firefox', 'safari']);
  assert.equal(data.jobs[0].score, 70, 'scores are untouched');
});

test('dropDecodeFromData clears the container and metadata when nothing is left', async () => {
  const { dropDecodeFromData } = await import('../src/decode.js');
  const data = {
    run: { browsers: { targets: { chrome: {} } } },
    jobs: [{ key: 'a', decode: { chrome: { schema: DECODE_SCHEMA, meanMs: 1 } } }],
  };
  dropDecodeFromData(data, ['all']);
  // A row with nothing measured should look like one that never had anything.
  assert.equal('decode' in data.jobs[0], false);
  assert.equal(data.run.browsers, null);
});

test('dropDecodeFromData does not mistake schema-2 leftovers for browsers', async () => {
  const { dropDecodeFromData } = await import('../src/decode.js');
  // Regression: merging a schema-3 measurement into a schema-2 row left the old
  // flat fields as siblings of the browser keys, and "drop all" then reported
  // browsers called meanMs, sdMs, samplesMs and so on.
  const data = {
    jobs: [
      {
        key: 'a',
        decode: {
          schema: 2,
          meanMs: 11.58,
          sdMs: 0.34,
          runs: 20,
          samplesMs: [11, 12],
          browser: 'chrome 156.0.8068.0 canary',
          firefox: { schema: DECODE_SCHEMA, meanMs: 2, sdMs: 0.1, runs: 20 },
        },
      },
    ],
  };

  const removed = dropDecodeFromData(data, ['firefox']);
  assert.deepEqual(removed, { firefox: 1 }, 'only the real browser is counted');

  // Dropping everything also clears the residue out.
  dropDecodeFromData(data, ['all']);
  assert.equal('decode' in data.jobs[0], false);
});

test('cleanDecodeMap keeps measurements and discards leftovers', async () => {
  const { cleanDecodeMap } = await import('../src/decode.js');
  const cleaned = cleanDecodeMap({
    schema: 2,
    meanMs: 11.58,
    samplesMs: [1, 2],
    browser: 'chrome 156',
    chrome: { schema: 3, meanMs: 1.2 },
  });
  assert.deepEqual(Object.keys(cleaned), ['chrome']);
  assert.deepEqual(cleanDecodeMap(undefined), {});
});
