// Binary presence + version capture. Runs on every invocation because scores
// and timings are only comparable within one toolchain version (plan.md §1),
// so the versions get recorded into results.json and the report.

import { createHash } from 'node:crypto';
import { access, constants, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run, setToolPath, toolPath } from './exec.js';
import { LIBAVIF_TOOLS, LOCAL_LIBAVIF_DIR, ensureHdrScorer } from './hdr.js';

// `ssimulacra2` has no version flag -- it prints usage and exits non-zero for
// any argument. We hash the binary instead so a toolchain change is still
// detectable in the cache key.
const TOOLS = [
  { name: 'avifenc', args: ['--version'], required: true },
  { name: 'avifdec', args: ['--version'], required: true },
  { name: 'cjxl', args: ['--version'], required: true },
  { name: 'djxl', args: ['--version'], required: true },
  { name: 'ssimulacra2', args: null, required: true },
  { name: 'cwebp', args: ['-version'], required: false },
  { name: 'dwebp', args: ['-version'], required: false },
  { name: 'magick', args: ['-version'], required: true },
];

// HDR mode only. hdr-ssim2 has no version flag either, so it is hashed too.
const HDR_TOOLS = [
  { name: 'avifgainmaputil', args: ['help'], required: true },
  { name: 'hdr-ssim2', args: null, required: true },
];

function firstLine(text) {
  return text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
}

/** Pull a semver-ish version out of whatever the tool printed. */
function parseVersion(name, stdout, stderr) {
  const text = `${stdout}\n${stderr}`;
  const match = text.match(/(\d+\.\d+\.\d+)/);
  // The line the version came from, not just the first: avifgainmaputil opens
  // with a description and prints its version (and aom's) at the end.
  const line = text.split('\n').map((l) => l.trim()).find((l) => match && l.includes(match[1]));
  return { version: match?.[1] ?? null, detail: line ?? firstLine(text) };
}

async function locate(name) {
  if (toolPath(name) !== name) return toolPath(name);
  try {
    const { stdout } = await run('/usr/bin/which', [name]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function hashBinary(path) {
  try {
    const buffer = await readFile(path);
    return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

async function probe(tool) {
  const path = await locate(tool.name);
  if (!path) {
    return { name: tool.name, present: false, required: tool.required };
  }
  const entry = { name: tool.name, present: true, required: tool.required, path };
  if (tool.args) {
    const { stdout, stderr } = await run(tool.name, tool.args, { allowFailure: true });
    Object.assign(entry, parseVersion(tool.name, stdout, stderr));
  } else {
    // No version flag: identify by binary hash instead.
    entry.version = null;
    entry.binarySha256 = await hashBinary(path);
    entry.detail = `binary sha256:${entry.binarySha256}`;
  }
  return entry;
}

async function isExecutable(filePath) {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe every tool. Returns `{ tools, versions, machine, ok, missing }`.
 * `versions` is the flat map that goes into the cache key.
 *
 * In HDR mode the libavif tools come from LOCAL_LIBAVIF_DIR when it has them
 * (all three from the same build, or the tone mapper and the encoder could
 * disagree), falling back to PATH.
 */
export async function doctor({ hdr = false, log = () => {} } = {}) {
  let localLibavif = false;
  if (hdr) {
    const local = LIBAVIF_TOOLS.map((name) => path.join(LOCAL_LIBAVIF_DIR, name));
    if ((await Promise.all(local.map(isExecutable))).every(Boolean)) {
      LIBAVIF_TOOLS.forEach((name, i) => setToolPath(name, local[i]));
      localLibavif = true;
    }
    setToolPath('hdr-ssim2', await ensureHdrScorer({ log }));
  }

  const tools = await Promise.all([...TOOLS, ...(hdr ? HDR_TOOLS : [])].map(probe));
  const missing = tools.filter((t) => t.required && !t.present).map((t) => t.name);
  const versions = {};
  for (const tool of tools) {
    if (!tool.present) continue;
    // A local libavif build and the system one both report "1.4.2"; only the
    // full line (which names the aom build) tells them apart.
    const localBuild = localLibavif && LIBAVIF_TOOLS.includes(tool.name);
    versions[tool.name] = (localBuild ? tool.detail : tool.version) ?? tool.binarySha256 ?? 'unknown';
  }
  return {
    tools,
    versions,
    missing,
    ok: missing.length === 0,
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cores: os.cpus().length,
      totalMemBytes: os.totalmem(),
      node: process.version,
    },
  };
}

export function formatDoctor(report) {
  const lines = ['Toolchain:'];
  for (const tool of report.tools) {
    if (!tool.present) {
      lines.push(`  ${tool.name.padEnd(15)} MISSING${tool.required ? ' (required)' : ' (optional)'}`);
      continue;
    }
    const where = tool.path.startsWith(LOCAL_LIBAVIF_DIR) ? `  (${tool.path})` : '';
    lines.push(`  ${tool.name.padEnd(15)} ${tool.version ?? tool.binarySha256 ?? '?'}${where}`);
  }
  const m = report.machine;
  lines.push(`  ${'machine'.padEnd(15)} ${m.cpu}, ${m.cores} logical cores, node ${m.node}`);
  return lines.join('\n');
}

/** Throw if a required tool is missing. */
export function assertToolchain(report) {
  if (report.ok) return;
  throw new Error(
    `Missing required tool(s): ${report.missing.join(', ')}.\n` +
      'Install them (e.g. `brew install libavif libjxl imagemagick webp`) and re-run.',
  );
}

/** Whether the optional WebP tools are available for the lossless table. */
export function hasWebp(report) {
  const byName = new Map(report.tools.map((t) => [t.name, t]));
  return Boolean(byName.get('cwebp')?.present && byName.get('dwebp')?.present);
}
