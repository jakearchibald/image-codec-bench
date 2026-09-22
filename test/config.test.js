import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseArgs } from 'node:util';

import { OPTIONS, parseDuration, parsePixels, resolveConfig } from '../src/config.js';

/** Parse an argv array the way cli.js does. */
function parse(argv) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
}

async function resolve(argv) {
  const { values, positionals } = parse(argv);
  return resolveConfig(values, positionals);
}

test('parseDuration understands s, ms, m and bare seconds', () => {
  assert.equal(parseDuration('2s'), 2000);
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('1.5s'), 1500);
  assert.equal(parseDuration('2'), 2000);
  assert.equal(parseDuration('1m'), 60_000);
});

test('parseDuration rejects nonsense', () => {
  assert.throws(() => parseDuration('soon'), /Bad duration/);
});

test('parsePixels understands MP suffix and plain counts', () => {
  assert.equal(parsePixels('0'), 0);
  assert.equal(parsePixels('2MP'), 2_000_000);
  assert.equal(parsePixels('12mp'), 12_000_000);
  assert.equal(parsePixels('250000'), 250_000);
});

test('parsePixels rejects negatives', () => {
  assert.throws(() => parsePixels('-5'), /Bad --max-pixels/);
});

test('defaults match the plan: AVIF q20:90:5 x s0..6, JXL q15:90:5 x e7..10', async () => {
  const config = await resolve(['photo.png']);
  assert.deepEqual(config.avif.quality, [20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90]);
  assert.deepEqual(config.avif.effort, [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(config.avif.depth, [8]);
  assert.deepEqual(config.avif.yuv, ['444']);
  assert.equal(config.avif.qalpha, 'match');
  assert.deepEqual(config.jxl.quality, [15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90]);
  assert.deepEqual(config.jxl.effort, [7, 8, 9, 10]);
  assert.deepEqual(config.timing, ['single', 'multi']);
  assert.equal(config.repeats, 3);
  assert.equal(config.repeatBudgetMs, 2000);
  assert.equal(config.maxPixels, 0);
});

test('CLI flags override the defaults', async () => {
  const config = await resolve([
    'photo.png',
    '--avif-quality', '20:90:5',
    '--avif-speed', '0-6',
    '--avif-depth', '8,10',
    '--avif-yuv', '444',
    '--avif-qalpha', 'match',
    '--jxl-quality', '15:90:5',
    '--jxl-effort', '7-10',
    '--timing', 'single,multi',
    '--repeats', '3',
    '--repeat-budget', '2s',
    '--max-pixels', '0',
    '--score-concurrency', '8',
    '--lossless',
    '--out', 'out/',
  ]);
  // This is the exact invocation from plan.md §4.
  assert.deepEqual(config.avif.depth, [8, 10]);
  assert.deepEqual(config.jxl.effort, [7, 8, 9, 10]);
  assert.equal(config.scoreConcurrency, 8);
  assert.equal(config.lossless, true);
});

test('--timing is normalised to a stable order', async () => {
  const a = await resolve(['photo.png', '--timing', 'multi,single']);
  const b = await resolve(['photo.png', '--timing', 'single,multi']);
  assert.deepEqual(a.timing, b.timing);
  assert.deepEqual(a.timing, ['single', 'multi']);
});

test('--timing accepts a single mode', async () => {
  const config = await resolve(['photo.png', '--timing', 'multi']);
  assert.deepEqual(config.timing, ['multi']);
});

test('--timing rejects an unknown mode', async () => {
  await assert.rejects(resolve(['photo.png', '--timing', 'turbo']), /Bad --timing/);
});

test('a config file supplies values, and CLI flags still win', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'icb-config-'));
  const file = path.join(dir, 'bench.json');
  await writeFile(file, JSON.stringify({
    input: 'from-file.png',
    avifSpeed: '4,6',
    jxlEffort: '7',
    repeats: 5,
  }));

  const fromFile = await resolve(['--config', file]);
  assert.deepEqual(fromFile.avif.effort, [4, 6]);
  assert.equal(fromFile.repeats, 5);
  assert.ok(fromFile.input.endsWith('from-file.png'));

  const overridden = await resolve(['--config', file, '--repeats', '2']);
  assert.equal(overridden.repeats, 2);
});

test('missing input is an error', async () => {
  await assert.rejects(resolve([]), /No input image/);
});

test('out-of-range encoder settings are rejected before any encoding', async () => {
  await assert.rejects(resolve(['p.png', '--avif-quality', '101']), /-q out of range/);
  await assert.rejects(resolve(['p.png', '--avif-speed', '11']), /-s out of range/);
  await assert.rejects(resolve(['p.png', '--avif-depth', '9']), /must be 8, 10 or 12/);
  await assert.rejects(resolve(['p.png', '--jxl-effort', '11']), /-e out of range/);
  await assert.rejects(resolve(['p.png', '--avif-yuv', '411']), /--avif-yuv must be/);
  await assert.rejects(resolve(['p.png', '--avif-qalpha', 'high']), /--avif-qalpha must be/);
  await assert.rejects(resolve(['p.png', '--repeats', '0']), /--repeats must be/);
  await assert.rejects(resolve(['p.png', '--score-concurrency', '0']), /--score-concurrency/);
});

test('--avif-qalpha accepts a fixed number as well as match', async () => {
  const config = await resolve(['p.png', '--avif-qalpha', '90']);
  assert.equal(config.avif.qalpha, '90');
});

test('WebP is rejected from the lossy sweep (it is lossless-only here)', async () => {
  await assert.rejects(resolve(['p.png', '--codecs', 'avif,webp']), /not part of the lossy sweep/);
});

test('--no-lossless disables the lossless suite', async () => {
  const off = await resolve(['p.png', '--no-lossless']);
  assert.equal(off.lossless, false);
  const on = await resolve(['p.png']);
  assert.equal(on.lossless, true);
});

test('boolean flags parse', async () => {
  const config = await resolve(['p.png', '--dry-run', '--force', '--quiet', '--no-report']);
  assert.equal(config.dryRun, true);
  assert.equal(config.force, true);
  assert.equal(config.quiet, true);
  assert.equal(config.report, false);
});

test("--timing none disables timing entirely", async () => {
  const config = await resolve(['photo.png', '--timing', 'none']);
  assert.deepEqual(config.timing, []);
});

test('--no-timing is an alias for --timing none', async () => {
  const config = await resolve(['photo.png', '--no-timing']);
  assert.deepEqual(config.timing, []);
});

test('--no-timing overrides an explicit --timing', async () => {
  // The fast path should win when both are given, rather than silently timing.
  const config = await resolve(['photo.png', '--timing', 'single,multi', '--no-timing']);
  assert.deepEqual(config.timing, []);
});

test("--timing none cannot be combined with a real mode", async () => {
  await assert.rejects(
    resolve(['photo.png', '--timing', 'none,multi']),
    /cannot be combined/,
  );
});

test('a config file can request no timing', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'icb-notiming-'));
  const file = path.join(dir, 'bench.json');
  await writeFile(file, JSON.stringify({ input: 'x.png', timing: 'none' }));
  const config = await resolve(['--config', file]);
  assert.deepEqual(config.timing, []);
});

test('--avif-yuv accepts a comma list, one series per mode', async () => {
  const config = await resolve(['p.png', '--avif-yuv', '444,420']);
  assert.deepEqual(config.avif.yuv, ['444', '420']);
});

test('--avif-yuv normalises order and duplicates, so keys stay stable', async () => {
  // Canonical order regardless of how it was typed: series ordering and cache
  // keys must not depend on argument order.
  const typed = await resolve(['p.png', '--avif-yuv', '420,444,420']);
  assert.deepEqual(typed.avif.yuv, ['444', '420']);
});

test('--avif-yuv still rejects an unknown mode inside a list', async () => {
  await assert.rejects(resolve(['p.png', '--avif-yuv', '444,411']), /--avif-yuv must be/);
});

test('--avif-yuv rejects an empty list', async () => {
  await assert.rejects(resolve(['p.png', '--avif-yuv', ',']), /at least one mode/);
});
