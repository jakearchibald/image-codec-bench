// Process spawning + timing. Every external tool goes through here so that
// timing is measured consistently and failures carry the tool's own stderr.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
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

// Tools resolved somewhere other than PATH (HDR mode's local libavif build).
// Callers keep using the bare name, so nothing else has to know.
const toolPaths = new Map();

export function setToolPath(name, filePath) {
  toolPaths.set(name, filePath);
}

export function toolPath(name) {
  return toolPaths.get(name) ?? name;
}

// Peak memory of a child process. Node has no per-child rusage, so the
// command runs under BSD/GNU `time`, which reports the child's maximum
// resident set size on stderr after it exits. Null where neither is available,
// and memory then just goes unrecorded.
const TIME_BINARY = '/usr/bin/time';
const MEMORY_PROBE = existsSync(TIME_BINARY)
  ? {
      darwin: {
        flag: '-l',
        // BSD reports bytes.
        parse: (text) => Number(text.match(/^\s*(\d+)\s+maximum resident set size$/m)?.[1]),
        start: /^\s+[\d.]+ real\s/m,
      },
      linux: {
        flag: '-v',
        // GNU reports kilobytes.
        parse: (text) => Number(text.match(/Maximum resident set size \(kbytes\): (\d+)/)?.[1]) * 1024,
        start: /^(Command exited with non-zero status \d+\n)?\tCommand being timed:/m,
      },
    }[process.platform] ?? null
  : null;

export const canMeasureMemory = MEMORY_PROBE !== null;

/**
 * Split `time`'s report off the end of the child's stderr. Searches for the
 * last match, so a tool that happened to print something report-like itself
 * keeps its own output.
 */
function splitMemoryReport(stderr) {
  const pattern = new RegExp(MEMORY_PROBE.start.source, 'gm');
  let index = -1;
  for (const match of stderr.matchAll(pattern)) index = match.index;
  if (index === -1) return { stderr, peakBytes: null };
  const peakBytes = MEMORY_PROBE.parse(stderr.slice(index));
  return { stderr: stderr.slice(0, index), peakBytes: Number.isFinite(peakBytes) ? peakBytes : null };
}

/**
 * Run a command to completion.
 * Returns `{ stdout, stderr, code, ms, peakBytes }` where `ms` is wall-clock
 * duration and `peakBytes` the child's peak resident memory -- only when
 * `measureMemory` is set and the platform supports it, otherwise null. The
 * `time` wrapper adds a few ms of spawn cost, so callers comparing timings
 * should either always or never set it.
 * Rejects with a ToolError on non-zero exit unless `allowFailure` is set.
 */
export function run(command, args, { allowFailure = false, env, measureMemory = false } = {}) {
  const wrapped = measureMemory && canMeasureMemory;
  return new Promise((resolve, reject) => {
    const started = performance.now();
    execFile(
      wrapped ? TIME_BINARY : toolPath(command),
      wrapped ? [MEMORY_PROBE.flag, toolPath(command), ...args] : args,
      { maxBuffer: MAX_BUFFER, env: env ? { ...process.env, ...env } : process.env },
      (error, stdout, rawStderr) => {
        const ms = performance.now() - started;
        const code = error?.code ?? 0;
        const { stderr, peakBytes } = wrapped
          ? splitMemoryReport(rawStderr ?? '')
          : { stderr: rawStderr, peakBytes: null };
        if (error && !allowFailure) {
          // Under `time`, a missing binary is `time` exiting 127 rather than ENOENT.
          if (error.code === 'ENOENT' || (wrapped && code === 127)) {
            reject(new Error(`Command not found: ${command}`));
            return;
          }
          reject(new ToolError(command, args, code, stderr ?? ''));
          return;
        }
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code, ms, peakBytes });
      },
    );
  });
}

/**
 * True if the binary exists and is executable.
 *
 * Note the ENOENT check rather than a bare try/catch: with `allowFailure` set,
 * `run` *resolves* for a missing binary (ENOENT arrives as an error object,
 * not a rejection), so catching alone would report every tool as present.
 */
export async function exists(command) {
  const { code } = await run(command, ['--version'], { allowFailure: true });
  return code !== 'ENOENT';
}

/**
 * Measure spawn overhead so the report can state it rather than subtract it
 * (plan.md §3). Uses the cheapest possible process, spawned the way encodes
 * are -- under the memory wrapper -- so the figure includes its cost too.
 */
export async function measureSpawnOverhead(samples = 7) {
  const times = [];
  for (let i = 0; i < samples; i += 1) {
    const { ms } = await run('true', [], { allowFailure: true, measureMemory: true });
    times.push(ms);
  }
  times.sort((a, b) => a - b);
  return {
    bestMs: times[0],
    medianMs: times[Math.floor(times.length / 2)],
    samples,
  };
}
