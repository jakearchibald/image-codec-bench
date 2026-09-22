// results.json load/append and job hashing (plan.md §5: resumable).
//
// A job's identity is (reference image bytes, codec, all encode params, tool
// versions). Tool versions are in the key because scores and timings are only
// comparable within one toolchain version -- a libavif upgrade must invalidate
// the cache rather than silently mixing numbers.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function hashFileBytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Stable JSON: sorted keys, so key order can't change a hash. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Hash identifying one job's result. `extra` carries anything else that
 * changes the encoder's output or the measurement's meaning.
 */
export function jobKey({ referenceHash, codec, params, versions, extra = {} }) {
  const payload = stableStringify({ referenceHash, codec, params, versions, extra });
  return createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

/** Short hash for the output directory name. */
export function shortHash(text, length = 8) {
  return createHash('sha256').update(text).digest('hex').slice(0, length);
}

export class ResultsStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
    this.byKey = new Map();
    this.writeQueue = Promise.resolve();
  }

  async load({ force = false } = {}) {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.data = JSON.parse(raw);
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      this.data = null;
    }

    if (!this.data || typeof this.data !== 'object') {
      this.data = { schema: 1, run: null, jobs: [], lossless: [] };
    }
    this.data.jobs ??= [];
    this.data.lossless ??= [];

    if (force) {
      this.data.jobs = [];
      this.data.lossless = [];
    }

    this.byKey = new Map(this.data.jobs.filter((j) => j.key).map((j) => [j.key, j]));
    return this.data;
  }

  get(key) {
    return this.byKey.get(key);
  }

  has(key) {
    return this.byKey.has(key);
  }

  setRunMetadata(metadata) {
    this.data.run = metadata;
  }

  /** Add or replace a job result, then persist. */
  async put(result) {
    const existing = this.byKey.get(result.key);
    if (existing) {
      Object.assign(existing, result);
    } else {
      this.byKey.set(result.key, result);
      this.data.jobs.push(result);
    }
    await this.flush();
  }

  async putLossless(results) {
    this.data.lossless = results;
    await this.flush();
  }

  /**
   * Write atomically via a temp file + rename, so Ctrl-C during a write can't
   * leave a truncated results.json behind (plan.md §5: Ctrl-C is safe).
   * Serialised through a queue so concurrent scorers can't interleave writes.
   */
  flush() {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.tmp`;
      await writeFile(temp, `${JSON.stringify(this.data, null, 2)}\n`);
      await rename(temp, this.filePath);
    });
    return this.writeQueue;
  }

  get jobs() {
    return this.data.jobs;
  }

  get lossless() {
    return this.data.lossless;
  }
}
