import assert from 'node:assert/strict';
import test from 'node:test';

import { ToolError, canMeasureMemory, run } from '../src/exec.js';

test('measureMemory reports peak bytes and leaves the tool\'s own stderr intact', { skip: !canMeasureMemory }, async () => {
  const { stderr, peakBytes } = await run('sh', ['-c', 'echo from-tool >&2'], { measureMemory: true });
  assert.equal(stderr, 'from-tool\n');
  assert.ok(peakBytes > 0);
});

test('measureMemory keeps the exit code and stderr of a failing tool', { skip: !canMeasureMemory }, async () => {
  await assert.rejects(
    run('sh', ['-c', 'echo broken >&2; exit 3'], { measureMemory: true }),
    (error) => error instanceof ToolError && error.code === 3 && error.stderr === 'broken\n',
  );
});

test('measureMemory still reports a missing binary as not found', { skip: !canMeasureMemory }, async () => {
  await assert.rejects(run('no-such-tool-xyz', [], { measureMemory: true }), /Command not found/);
});

test('without measureMemory, peakBytes is null', async () => {
  const { peakBytes } = await run('true', []);
  assert.equal(peakBytes, null);
});
