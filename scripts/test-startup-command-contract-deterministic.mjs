import { access, mkdtemp, readFile } from 'node:fs/promises';
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

async function ensureBuiltCli() {
  const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  try {
    await access(cliPath);
  } catch {
    await execFileAsync('pnpm', ['build'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: process.env,
    });
  }
  return cliPath;
}

async function runLifeline(cwd, ...args) {
  const cliPath = await ensureBuiltCli();

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd,
      env: process.env,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const exitError = /** @type {{ code?: number; stdout?: string; stderr?: string }} */ (error);
    return {
      code: typeof exitError.code === 'number' ? exitError.code : 1,
      stdout: exitError.stdout ?? '',
      stderr: exitError.stderr ?? '',
    };
  }
}

async function readStartupIntent(cwd) {
  const statePath = path.join(cwd, '.lifeline', 'startup.json');
  const raw = await readFile(statePath, 'utf8');
  const state = JSON.parse(raw);
  return state.intent;
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lifeline-startup-contract-'));

  const enable = await runLifeline(tempDir, 'startup', 'enable');
  assert(enable.code === 0, `Expected startup enable to succeed, got exit code ${enable.code}.`);

  const intentAfterEnable = await readStartupIntent(tempDir);
  assert(intentAfterEnable === 'enabled', `Expected enabled intent, got ${intentAfterEnable}.`);

  const dryRunDisable = await runLifeline(tempDir, 'startup', 'disable', '--dry-run');
  assert(
    dryRunDisable.code === 0,
    `Expected startup disable --dry-run to succeed, got exit code ${dryRunDisable.code}.`,
  );

  const intentAfterDryRunDisable = await readStartupIntent(tempDir);
  assert(
    intentAfterDryRunDisable === 'enabled',
    `Expected disable --dry-run to avoid state mutation, got ${intentAfterDryRunDisable}.`,
  );

  const disable = await runLifeline(tempDir, 'startup', 'disable');
  assert(disable.code === 0, `Expected startup disable to succeed, got exit code ${disable.code}.`);

  const intentAfterDisable = await readStartupIntent(tempDir);
  assert(intentAfterDisable === 'disabled', `Expected disabled intent, got ${intentAfterDisable}.`);

  const dryRunEnable = await runLifeline(tempDir, 'startup', 'enable', '--dry-run');
  assert(
    dryRunEnable.code === 0,
    `Expected startup enable --dry-run to succeed, got exit code ${dryRunEnable.code}.`,
  );

  const intentAfterDryRunEnable = await readStartupIntent(tempDir);
  assert(
    intentAfterDryRunEnable === 'disabled',
    `Expected enable --dry-run to avoid state mutation, got ${intentAfterDryRunEnable}.`,
  );

  const statusDryRun = await runLifeline(tempDir, 'startup', 'status', '--dry-run');
  assert(
    statusDryRun.code !== 0,
    'Expected startup status --dry-run to fail with non-zero exit code.',
  );
  assert(
    statusDryRun.stderr.includes('The --dry-run option is only valid with startup enable|disable.'),
    `Expected status --dry-run error message, got: ${statusDryRun.stderr.trim() || '(empty stderr)'}`,
  );

  const invalidOption = await runLifeline(tempDir, 'startup', 'enable', '--bogus');
  assert(
    invalidOption.code !== 0,
    'Expected startup invalid option to fail with non-zero exit code.',
  );
  assert(
    invalidOption.stderr.includes('Unknown startup option: --bogus. Only --dry-run is supported.'),
    `Expected invalid option error message, got: ${invalidOption.stderr.trim() || '(empty stderr)'}`,
  );

  const invalidAction = await runLifeline(tempDir, 'startup', 'bogus');
  assert(
    invalidAction.code !== 0,
    'Expected startup invalid action to fail with non-zero exit code.',
  );
  assert(
    invalidAction.stderr.includes('Unknown startup action: bogus. Use one of: enable, disable, status.'),
    `Expected invalid action error message, got: ${invalidAction.stderr.trim() || '(empty stderr)'}`,
  );

  console.log('Deterministic startup command contract verification passed.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Deterministic startup command contract verification failed: ${message}`);
  process.exitCode = 1;
});
