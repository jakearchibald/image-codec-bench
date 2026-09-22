// Process spawning + timing. Every external tool goes through here so that
// timing is measured consistently and failures carry the tool's own stderr.

import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const MAX_BUFFER = 64 * 1024 * 1024;

export class ToolError extends Error {
  constructor(command, args, code, stderr) {
    super(`${command} exited with code ${code}\n${stderr.trim()}`);
    this.name = 'ToolError';
    this.command = command;
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Run a command to completion.
 * Returns `{ stdout, stderr, code, ms }` where `ms` is wall-clock duration.
 * Rejects with a ToolError on non-zero exit unless `allowFailure` is set.
 */
export function run(command, args, { allowFailure = false, env } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    execFile(
      command,
      args,
      { maxBuffer: MAX_BUFFER, env: env ? { ...process.env, ...env } : process.env },
      (error, stdout, stderr) => {
        const ms = performance.now() - started;
        const code = error?.code ?? 0;
        if (error && !allowFailure) {
          if (error.code === 'ENOENT') {
            reject(new Error(`Command not found: ${command}`));
            return;
          }
          reject(new ToolError(command, args, code, stderr ?? ''));
          return;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code, ms });
      },
    );
  });
}

/** True if the binary exists and is executable. */
export async function exists(command) {
  try {
    await run('command', ['-v', command]);
    return true;
  } catch {
    // `command` is a shell builtin, so execFile can't see it. Fall back to
    // running the tool itself and treating "not found" as the only failure.
    try {
      await run(command, ['--version'], { allowFailure: true });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Measure spawn overhead so the report can state it rather than subtract it
 * (plan.md §3). Uses the cheapest possible process.
 */
export async function measureSpawnOverhead(samples = 7) {
  const times = [];
  for (let i = 0; i < samples; i += 1) {
    const { ms } = await run('true', [], { allowFailure: true });
    times.push(ms);
  }
  times.sort((a, b) => a - b);
  return {
    bestMs: times[0],
    medianMs: times[Math.floor(times.length / 2)],
    samples,
  };
}
