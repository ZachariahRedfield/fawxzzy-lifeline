import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function runLifeline(cwd, ...args) {
  const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd,
    env: process.env,
  });
  if (stderr.trim().length > 0) {
    throw new Error(`Unexpected stderr for startup ${args.join(' ')}: ${stderr.trim()}`);
  }
  return stdout;
}

async function readStartupState(cwd) {
  const statePath = path.join(cwd, '.lifeline', 'startup.json');
  const raw = await readFile(statePath, 'utf8');
  return JSON.parse(raw);
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lifeline-startup-roundtrip-'));

  const enableOutput = await runLifeline(tempDir, 'startup', 'enable');
  assert(enableOutput.includes('Startup intent enabled.'), 'Expected startup enable confirmation.');

  const enabledState = await readStartupState(tempDir);
  assert(enabledState.intent === 'enabled', `Expected enabled intent, got ${enabledState.intent}`);
  assert(
    enabledState.restoreEntrypoint === 'lifeline restore',
    `Expected canonical restore entrypoint, got ${enabledState.restoreEntrypoint}`,
  );

  const statusOutput = await runLifeline(tempDir, 'startup', 'status');
  assert(statusOutput.includes('Startup enabled: yes'), 'Expected startup status to report enabled.');
  assert(
    statusOutput.includes('- restore entrypoint: lifeline restore'),
    'Expected startup status restore entrypoint to remain canonical.',
  );
  assert(
    statusOutput.includes('- mechanism: contract-only'),
    'Expected startup status to report contract-only mechanism.',
  );

  const disableOutput = await runLifeline(tempDir, 'startup', 'disable');
  assert(disableOutput.includes('Startup intent disabled.'), 'Expected startup disable confirmation.');

  const disabledState = await readStartupState(tempDir);
  assert(disabledState.intent === 'disabled', `Expected disabled intent, got ${disabledState.intent}`);

  console.log('Deterministic startup roundtrip verification passed (enable/status/disable).');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Deterministic startup roundtrip verification failed: ${message}`);
  process.exitCode = 1;
});
