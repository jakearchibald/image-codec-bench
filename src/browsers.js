// Browser decode targets: where to find each browser, which driver it needs,
// and the capabilities and quirks that make its timings trustworthy.

import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';

import { run } from './exec.js';

/** Where downloaded drivers are cached between runs. */
export const DRIVER_CACHE = path.join(os.homedir(), '.cache', 'image-codec-bench', 'drivers');

export const TARGETS = {
  chrome: {
    label: 'Chrome Canary',
    driver: 'chromedriver',
    // Canary, not stable: verified that Canary decodes JPEG XL through
    // createImageBitmap while stable Chrome fails with "The source image could
    // not be decoded".
    binaries: [
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/usr/bin/google-chrome-canary',
      'C:\\Program Files\\Google\\Chrome SxS\\Application\\chrome.exe',
    ],
    headless: true,
    capabilities(binary) {
      return {
        browserName: 'chrome',
        'goog:chromeOptions': {
          ...(binary ? { binary } : {}),
          args: [
            '--headless=new',
            '--no-first-run',
            '--disable-extensions',
            '--disable-background-networking',
            // Software decode, so timings reflect the CPU decoder rather than
            // whatever GPU is in the machine.
            '--disable-gpu',
          ],
        },
      };
    },
  },

  firefox: {
    label: 'Firefox Nightly',
    driver: 'geckodriver',
    binaries: [
      '/Applications/Firefox Nightly.app/Contents/MacOS/firefox',
      '/usr/bin/firefox-nightly',
      'C:\\Program Files\\Firefox Nightly\\firefox.exe',
    ],
    headless: true,
    capabilities(binary) {
      return {
        browserName: 'firefox',
        'moz:firefoxOptions': {
          ...(binary ? { binary } : {}),
          args: ['-headless'],
          prefs: {
            // JPEG XL is behind a flag, Nightly only.
            'image.jxl.enabled': true,
            // Without this Firefox clamps performance.now() to 1ms for
            // fingerprinting resistance, which is useless for decodes that
            // take 1-20ms. Off, its granularity is 0.02ms -- finer than
            // Chrome's 0.1ms.
            'privacy.reduceTimerPrecision': false,
            'browser.shell.checkDefaultBrowser': false,
          },
        },
      };
    },
  },

  safari: {
    label: 'Safari',
    driver: 'safaridriver',
    // safaridriver ships with macOS and drives the installed Safari; there is
    // no binary to point at.
    binaries: [],
    // Safari has no headless mode, so a window appears and takes focus.
    headless: false,
    capabilities() {
      return { browserName: 'safari' };
    },
    /** Shown when a session can't be created, which is nearly always this. */
    setupHint:
      "Enable Safari \u2192 Settings \u2192 Advanced \u2192 'Show features for web developers', " +
      "then Develop \u2192 'Allow Remote Automation'. " +
      'It cannot be enabled programmatically.',
  },

  'safari-preview': {
    label: 'Safari Technology Preview',
    driver: 'safaridriver-preview',
    binaries: [],
    headless: false,
    capabilities() {
      return { browserName: 'safari' };
    },
    setupHint:
      "In Safari Technology Preview: Develop \u2192 'Allow Remote Automation'.",
  },
};

/**
 * Firefox Nightly is the default target.
 *
 * It is the better instrument: with `privacy.reduceTimerPrecision` off its
 * `performance.now()` granularity is 0.02ms against Chrome's 0.1ms, which
 * matters because the fastest decodes here are around 1ms, where Chrome's
 * quantisation is several percent of the measurement on its own.
 */
export const DEFAULT_TARGETS = ['firefox'];

export function parseTargets(spec) {
  const names = String(spec)
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);

  if (names.includes('none')) {
    if (names.length > 1) throw new Error("--decode-browsers 'none' cannot be combined");
    return [];
  }
  if (names.includes('all')) return ['chrome', 'firefox', 'safari'];

  for (const name of names) {
    if (!TARGETS[name]) {
      throw new Error(
        `Unknown decode browser '${name}'. Known: ${Object.keys(TARGETS).join(', ')}, all, none`,
      );
    }
  }
  if (names.length === 0) throw new Error('--decode-browsers needs at least one browser');
  // Stable order, so column layout and stored keys don't depend on argument order.
  return Object.keys(TARGETS).filter((name) => names.includes(name));
}

/** First existing path from a candidate list. */
async function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

/** Look the command up on PATH. */
async function onPath(command) {
  try {
    const { stdout } = await run('/usr/bin/which', [command]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

const SAFARIDRIVER_PATHS = {
  safaridriver: ['/usr/bin/safaridriver'],
  'safaridriver-preview': [
    '/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver',
  ],
};

/**
 * Resolve chromedriver, downloading a matching build if necessary.
 *
 * chromedriver must match Chrome's *major* version -- verified that
 * chromedriver 156.0.8067.0 drives Chrome 156.0.8068.0 -- and Canary moves
 * daily, so a driver that merely exists is not good enough.
 */
async function resolveChromedriver(browserBinary, override) {
  if (override) return override;

  const wanted = await chromeMajor(browserBinary);
  const existing = await onPath('chromedriver');
  if (existing && (await driverMajor(existing)) === wanted) return existing;

  const cached = path.join(DRIVER_CACHE, `chromedriver-${wanted}`, 'chromedriver');
  if (await firstExisting([cached])) return cached;

  return downloadChromedriver(wanted, cached);
}

async function chromeMajor(binary) {
  const { stdout } = await run(binary, ['--version'], { allowFailure: true });
  return stdout.match(/(\d+)\./)?.[1] ?? null;
}

async function driverMajor(driverPath) {
  const { stdout } = await run(driverPath, ['--version'], { allowFailure: true });
  return stdout.match(/(\d+)\./)?.[1] ?? null;
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'image-codec-bench' } });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return response.json();
}

async function downloadAndExtract(url, destDir, { strip = true } = {}) {
  await mkdir(destDir, { recursive: true });
  const temp = await mkdtemp(path.join(os.tmpdir(), 'icb-driver-'));
  try {
    const archive = path.join(temp, path.basename(new URL(url).pathname));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
    await pipeline(response.body, createWriteStream(archive));

    if (archive.endsWith('.zip')) {
      await run('/usr/bin/unzip', ['-qo', archive, '-d', temp]);
    } else {
      await run('/usr/bin/tar', ['-xzf', archive, '-C', temp]);
    }

    // Find the executable and move it into place.
    const { stdout } = await run('/usr/bin/find', [
      temp,
      '-type', 'f',
      '-name', strip ? '*driver' : '*',
      '-perm', '+111',
    ]);
    const found = stdout.trim().split('\n').filter(Boolean)[0];
    if (!found) throw new Error(`No driver executable found in ${url}`);

    const target = path.join(destDir, path.basename(found));
    await run('/bin/cp', [found, target]);
    await chmod(target, 0o755);
    // Downloaded binaries are quarantined on macOS, which blocks execution.
    await run('/usr/bin/xattr', ['-d', 'com.apple.quarantine', target], { allowFailure: true });
    return target;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function downloadChromedriver(major, cachedPath) {
  const platform = driverPlatform('chrome');
  const data = await fetchJson(
    'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json',
  );
  const channel = Object.values(data.channels).find((c) => c.version.startsWith(`${major}.`));
  if (!channel) {
    throw new Error(
      `No published chromedriver for Chrome ${major}. Pass --chromedriver PATH, or ` +
        'exclude chrome from --decode-browsers.',
    );
  }
  const asset = channel.downloads.chromedriver.find((d) => d.platform === platform);
  if (!asset) throw new Error(`No chromedriver build for platform ${platform}`);
  return downloadAndExtract(asset.url, path.dirname(cachedPath));
}

async function resolveGeckodriver(override) {
  if (override) return override;
  const existing = await onPath('geckodriver');
  if (existing) return existing;

  const data = await fetchJson('https://api.github.com/repos/mozilla/geckodriver/releases/latest');
  const suffix = driverPlatform('firefox');
  const asset = data.assets.find((a) => a.name.includes(suffix) && a.name.endsWith('.tar.gz'));
  if (!asset) throw new Error(`No geckodriver build for platform ${suffix}`);
  return downloadAndExtract(
    asset.browser_download_url,
    path.join(DRIVER_CACHE, `geckodriver-${data.tag_name}`),
  );
}

function driverPlatform(kind) {
  const arm = process.arch === 'arm64';
  if (process.platform === 'darwin') {
    return kind === 'chrome' ? (arm ? 'mac-arm64' : 'mac-x64') : arm ? 'macos-aarch64' : 'macos';
  }
  if (process.platform === 'linux') {
    return kind === 'chrome' ? 'linux64' : arm ? 'linux-aarch64' : 'linux64';
  }
  return kind === 'chrome' ? 'win64' : 'win64';
}

/**
 * Resolve everything needed to drive `name`, or explain why it can't be.
 * Returns `{ name, label, driverPath, capabilities, headless }` or
 * `{ name, label, unavailable }`.
 */
export async function resolveTarget(name, overrides = {}) {
  const target = TARGETS[name];
  if (!target) throw new Error(`Unknown decode browser '${name}'`);

  // An explicitly given path is checked too. Taking it on trust just moves the
  // failure to session creation, where it surfaces as an opaque driver error.
  if (overrides.browser && !(await firstExisting([overrides.browser]))) {
    return {
      name,
      label: target.label,
      unavailable: `${overrides.browser} does not exist`,
      hint: `Check the --${name} path.`,
    };
  }
  if (overrides.driver && !(await firstExisting([overrides.driver]))) {
    return {
      name,
      label: target.label,
      unavailable: `${overrides.driver} does not exist`,
      hint: `Check the --${target.driver} path.`,
    };
  }

  const browserBinary = overrides.browser ?? (await firstExisting(target.binaries));
  if (target.binaries.length > 0 && !browserBinary) {
    return {
      name,
      label: target.label,
      unavailable: `${target.label} not found`,
      hint: `Install it, or pass --${name} PATH.`,
    };
  }

  let driverPath = null;
  try {
    if (target.driver === 'chromedriver') {
      driverPath = await resolveChromedriver(browserBinary, overrides.driver);
    } else if (target.driver === 'geckodriver') {
      driverPath = await resolveGeckodriver(overrides.driver);
    } else {
      driverPath = overrides.driver ?? (await firstExisting(SAFARIDRIVER_PATHS[target.driver] ?? []));
    }
  } catch (error) {
    return { name, label: target.label, unavailable: error.message };
  }

  if (!driverPath) {
    return {
      name,
      label: target.label,
      unavailable: `${target.driver} not found`,
      hint: target.setupHint,
    };
  }

  return {
    name,
    label: target.label,
    driverPath,
    headless: target.headless,
    setupHint: target.setupHint,
    capabilities: { alwaysMatch: target.capabilities(browserBinary) },
  };
}
