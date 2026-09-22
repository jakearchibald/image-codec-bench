// Classic W3C WebDriver client, and the driver processes behind it.
//
// Classic rather than BiDi or CDP because the decode benchmark needs exactly
// three things -- navigate, run an async script, get JSON back -- and classic
// WebDriver does all three on every driver that exists, including safaridriver.
// BiDi would work for Chrome and Firefox but Safari's support is still landing,
// and CDP is Chrome-only.

import { spawn } from 'node:child_process';

/** Driver HTTP call. Errors carry the driver's own message, which is usually good. */
async function call(base, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`WebDriver ${method} ${path}: unparseable response: ${text.slice(0, 200)}`);
  }
  if (json?.value?.error) {
    const message = (json.value.message ?? '').split('\n')[0];
    throw new WebDriverError(json.value.error, message);
  }
  if (!response.ok) {
    throw new Error(`WebDriver ${method} ${path}: HTTP ${response.status}`);
  }
  return json.value;
}

export class WebDriverError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'WebDriverError';
    this.code = code;
    this.detail = message;
  }
}

/** Wait for the driver's HTTP port to answer. */
async function waitForDriver(base, { attempts = 60, delayMs = 250 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await call(base, 'GET', '/status');
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

/** An unused localhost port, so parallel runs don't collide. */
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Start a driver, open one session, and return a handle.
 *
 * `scriptTimeoutMs` has to be generous: one `executeAsync` call benchmarks a
 * whole batch of images, and at full resolution that is seconds of real work.
 */
export async function openSession({
  driverPath,
  driverArgs = [],
  capabilities,
  scriptTimeoutMs = 600_000,
}) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(driverPath, [...driverArgs, `--port=${port}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exited = new Promise((resolve) => proc.once('exit', (code) => resolve(code)));

  if (!(await waitForDriver(base))) {
    proc.kill('SIGKILL');
    throw new Error(
      `Driver ${driverPath} did not start listening.${stderr ? `\n${stderr.trim().split('\n').slice(0, 3).join('\n')}` : ''}`,
    );
  }

  let session;
  try {
    session = await call(base, 'POST', '/session', { capabilities });
  } catch (error) {
    proc.kill('SIGKILL');
    throw error;
  }

  const sessionId = session.sessionId;
  const sessionBase = `${base}/session/${sessionId}`;

  // Script timeout is set after creation: passing it in capabilities is legal
  // but not honoured consistently across drivers.
  await call(sessionBase, 'POST', '/timeouts', { script: scriptTimeoutMs }).catch(() => {});

  return {
    capabilities: session.capabilities ?? {},
    /** Browser version string, for stamping measurements. */
    version: `${session.capabilities?.browserName ?? '?'} ${session.capabilities?.browserVersion ?? '?'}`,

    async navigate(url) {
      await call(sessionBase, 'POST', '/url', { url });
    },

    /**
     * Run an async function body in the page and return its JSON result.
     *
     * Classic WebDriver hands the script a callback as its last argument; the
     * script must call it to resolve. Results cross as JSON, so the benchmark
     * returns plain objects.
     */
    async executeAsync(functionBody, args = []) {
      return call(sessionBase, 'POST', '/execute/async', {
        script: functionBody,
        args,
      });
    },

    async quit() {
      await call(sessionBase, 'DELETE', '').catch(() => {});
      proc.kill('SIGTERM');
      // Give it a moment to exit cleanly, then insist.
      const timer = setTimeout(() => proc.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timer);
    },
  };
}
