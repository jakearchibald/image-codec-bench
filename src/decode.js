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

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from './exec.js';

/** Where Chrome Canary usually lives, by platform. */
const CANARY_PATHS = {
  darwin: ['/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'],
  linux: ['/usr/bin/google-chrome-canary', '/usr/bin/google-chrome-unstable'],
  win32: [
    'C:\\Program Files\\Google\\Chrome SxS\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome SxS\\Application\\chrome.exe',
  ],
};

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
 * Locate the browser. An explicit path always wins, so a different Chromium
 * build can be substituted.
 */
export async function findBrowser(explicitPath) {
  const candidates = explicitPath
    ? [explicitPath]
    : (CANARY_PATHS[process.platform] ?? []);

  for (const candidate of candidates) {
    try {
      const { stdout } = await run(candidate, ['--version'], { allowFailure: true });
      const version = stdout.trim();
      if (version) return { path: candidate, version };
    } catch {
      // Not this one; keep looking.
    }
  }
  return null;
}

/**
 * Decode timings are only comparable within one browser build, and Canary
 * updates most days, so the build string is stored alongside each measurement
 * and used to decide staleness. It is deliberately *not* part of the job cache
 * key: a Canary update would otherwise invalidate every encode too, throwing
 * away hours of work to re-measure something unrelated.
 */
export function decodeIsStale(job, browserVersion) {
  if (!job?.decode) return true;
  return job.decode.browser !== browserVersion;
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

/** Launch headless Chrome and resolve the DevTools WebSocket URL it prints. */
async function launchBrowser(binary, profileDir) {
  const proc = spawn(
    binary,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      // Software decode only, so timings reflect the CPU decoder rather than
      // whatever GPU happens to be in the machine.
      '--disable-gpu',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const browserWs = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(
      () => reject(new Error('Browser did not report a DevTools endpoint within 20s')),
      20_000,
    );
    proc.stderr.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Browser exited early (code ${code})`));
    });
  });

  return { proc, browserWs };
}

/** Attach to the first page target, retrying while the browser starts up. */
async function attachToPage(browserWs) {
  const port = new URL(browserWs).port;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('No page target appeared in the browser');
}

/** Thin CDP client: send a command, await its reply. */
function cdpClient(socket) {
  let nextId = 0;
  return {
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const onMessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.id !== id) return;
          socket.removeEventListener('message', onMessage);
          if (message.error) reject(new Error(`${method}: ${message.error.message}`));
          else resolve(message.result);
        };
        socket.addEventListener('message', onMessage);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    waitForEvent(method) {
      return new Promise((resolve) => {
        const onMessage = (event) => {
          const message = JSON.parse(event.data);
          if (message.method !== method) return;
          socket.removeEventListener('message', onMessage);
          resolve(message.params);
        };
        socket.addEventListener('message', onMessage);
      });
    },
  };
}

/**
 * The in-page benchmark.
 *
 * Fetched once into an ArrayBuffer so the network is never on the clock, then
 * re-wrapped in a fresh Blob per iteration -- verified that repeat timings stay
 * flat and non-zero this way, i.e. nothing is served from a decoded-image
 * cache. The first sample runs warm-up costs (codec init, JIT) and is the
 * reason the headline figure is best-of-N rather than the mean.
 */
function benchmarkExpression(urls, repeats) {
  return `(async () => {
    const files = ${JSON.stringify(urls)};
    const out = {};
    for (const [key, url] of Object.entries(files)) {
      try {
        const buffer = await (await fetch(url)).arrayBuffer();
        const samples = [];
        for (let i = 0; i < ${repeats}; i += 1) {
          const blob = new Blob([buffer.slice(0)]);
          const started = performance.now();
          const bitmap = await createImageBitmap(blob);
          samples.push(performance.now() - started);
          bitmap.close();
        }
        out[key] = { samples };
      } catch (error) {
        out[key] = { error: error.name + ': ' + error.message };
      }
    }
    return out;
  })()`;
}

/**
 * Measure decode time for each entry of `targets` ({ key, url } relative to
 * `rootDir`). Returns a Map of key -> { bestMs, meanMs, runs, samplesMs } or
 * { error }.
 *
 * Runs serially with nothing else in flight, for the same reason the encode
 * phase does: a decode timed against a busy machine is not a decode timing.
 */
export async function measureDecodeTimes({
  binary,
  rootDir,
  targets,
  repeats = 5,
  onProgress = () => {},
}) {
  if (targets.length === 0) return new Map();

  const { server, origin } = await serveDirectory(rootDir);
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'icb-chrome-'));
  let proc = null;
  let socket = null;

  try {
    const launched = await launchBrowser(binary, profileDir);
    proc = launched.proc;
    const pageWs = await attachToPage(launched.browserWs);

    socket = new WebSocket(pageWs);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('CDP socket failed')), { once: true });
    });

    const cdp = cdpClient(socket);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    // Navigate before evaluating. The page target exists before the launch URL
    // has loaded, and about:blank is an opaque origin where every fetch fails
    // CORS -- which looks exactly like a broken decoder.
    const loaded = cdp.waitForEvent('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `${origin}/` });
    await loaded;

    const results = new Map();
    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      const batch = targets.slice(i, i + BATCH_SIZE);
      const urls = Object.fromEntries(
        batch.map(({ key, url }) => [key, `${origin}/${url.split(path.sep).join('/')}`]),
      );

      const evaluated = await cdp.send('Runtime.evaluate', {
        expression: benchmarkExpression(urls, repeats),
        awaitPromise: true,
        returnByValue: true,
      });

      if (evaluated.exceptionDetails) {
        throw new Error(`Decode benchmark threw: ${evaluated.exceptionDetails.text}`);
      }

      for (const [key, value] of Object.entries(evaluated.result.value ?? {})) {
        results.set(key, value.error ? { error: value.error } : summarise(value.samples));
      }
      onProgress(Math.min(i + batch.length, targets.length), targets.length);
    }

    return results;
  } finally {
    socket?.close();
    proc?.kill('SIGKILL');
    server.close();
    await rm(profileDir, { recursive: true, force: true });
  }
}

/** Best-of-N headline with the mean alongside, matching the encode timings. */
export function summarise(samples) {
  return {
    bestMs: Math.min(...samples),
    meanMs: samples.reduce((a, b) => a + b, 0) / samples.length,
    runs: samples.length,
    samplesMs: samples.map((ms) => Number(ms.toFixed(4))),
  };
}
