import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function ensureBuiltDist() {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const distCliPath = path.join(repoRoot, 'dist', 'cli.js');

  try {
    await access(distCliPath);
  } catch {
    await execFileAsync('pnpm', ['build'], {
      cwd: repoRoot,
      env: process.env,
    });
  }

  return repoRoot;
}

async function waitFor(check, { timeoutMs = 5000, intervalMs = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for ${label}.`);
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function main() {
  const repoRoot = await ensureBuiltDist();
  const processManagerModulePath = pathToFileURL(
    path.join(repoRoot, 'dist', 'core', 'process-manager.js'),
  ).href;
  const { findListeningPortOwnerPid } = await import(processManagerModulePath);

  let server;
  let port;

  try {
    server = http.createServer((_, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    assert(address && typeof address === 'object', 'Expected server to expose a bound address object.');
    port = address.port;

    const expectedPid = process.pid;
    const resolvedPid = await waitFor(
      async () => {
        const pid = await findListeningPortOwnerPid(port);
        return pid === expectedPid ? pid : undefined;
      },
      { label: `listener owner pid=${expectedPid} on port ${port}` },
    );

    assert(
      resolvedPid === expectedPid,
      `Expected listener owner pid ${expectedPid}, got ${resolvedPid ?? 'undefined'}.`,
    );

    await closeServer(server);
    server = undefined;

    const afterClosePid = await waitFor(
      async () => {
        const pid = await findListeningPortOwnerPid(port);
        return pid !== expectedPid;
      },
      { label: `port ${port} release from pid ${expectedPid}` },
    );

    assert(
      afterClosePid === undefined || afterClosePid !== expectedPid,
      `Expected closed port to stop reporting pid ${expectedPid}, got ${afterClosePid}.`,
    );

    console.log('Deterministic process-manager listening owner pid verification passed.');
  } finally {
    if (server?.listening) {
      await closeServer(server);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`Deterministic process-manager listening owner pid verification failed: ${message}`);
  process.exitCode = 1;
});
