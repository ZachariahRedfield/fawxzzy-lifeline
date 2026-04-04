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

async function readStartupState(cwd) {
  const statePath = path.join(cwd, '.lifeline', 'startup.json');
  const raw = await readFile(statePath, 'utf8');
  return JSON.parse(raw);
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'lifeline-startup-contract-'));

  const enable = await runLifeline(tempDir, 'startup', 'enable');
  assert(enable.code === 0, `Expected startup enable to succeed, got exit code ${enable.code}.`);
  assert(enable.stdout.includes('Startup intent enabled.'), 'Expected enable confirmation output.');

  const stateAfterEnable = await readStartupState(tempDir);
  assert(stateAfterEnable.intent === 'enabled', `Expected enabled intent, got ${stateAfterEnable.intent}.`);
  assert(
    stateAfterEnable.backendStatus === 'unsupported',
    `Expected startup enable to persist unsupported backendStatus from seam, got ${stateAfterEnable.backendStatus}.`,
  );

  const statusAfterEnable = await runLifeline(tempDir, 'startup', 'status');
  assert(statusAfterEnable.code === 0, 'Expected startup status after enable to succeed.');
  assert(statusAfterEnable.stdout.includes('Startup enabled: yes'), 'Expected enabled status after enable.');
  assert(statusAfterEnable.stdout.includes('Startup supported: no'), 'Expected unsupported backend status to be explicit.');
  assert(
    statusAfterEnable.stdout.includes('- mechanism: contract-only'),
    'Expected status mechanism to remain contract-only when backend is unsupported.',
  );

  const dryRunDisable = await runLifeline(tempDir, 'startup', 'disable', '--dry-run');
  assert(
    dryRunDisable.code === 0,
    `Expected startup disable --dry-run to succeed, got exit code ${dryRunDisable.code}.`,
  );

  const stateAfterDryRunDisable = await readStartupState(tempDir);
  assert(
    stateAfterDryRunDisable.intent === 'enabled',
    `Expected disable --dry-run to avoid intent mutation, got ${stateAfterDryRunDisable.intent}.`,
  );
  assert(
    stateAfterDryRunDisable.backendStatus === 'unsupported',
    `Expected disable --dry-run to avoid backendStatus mutation, got ${stateAfterDryRunDisable.backendStatus}.`,
  );

  const disable = await runLifeline(tempDir, 'startup', 'disable');
  assert(disable.code === 0, `Expected startup disable to succeed, got exit code ${disable.code}.`);
  assert(disable.stdout.includes('Startup intent disabled.'), 'Expected disable confirmation output.');

  const stateAfterDisable = await readStartupState(tempDir);
  assert(stateAfterDisable.intent === 'disabled', `Expected disabled intent, got ${stateAfterDisable.intent}.`);
  assert(
    stateAfterDisable.backendStatus === 'unsupported',
    `Expected startup disable to persist unsupported backendStatus from seam, got ${stateAfterDisable.backendStatus}.`,
  );

  const dryRunEnable = await runLifeline(tempDir, 'startup', 'enable', '--dry-run');
  assert(
    dryRunEnable.code === 0,
    `Expected startup enable --dry-run to succeed, got exit code ${dryRunEnable.code}.`,
  );

  const stateAfterDryRunEnable = await readStartupState(tempDir);
  assert(
    stateAfterDryRunEnable.intent === 'disabled',
    `Expected enable --dry-run to avoid intent mutation, got ${stateAfterDryRunEnable.intent}.`,
  );
  assert(
    stateAfterDryRunEnable.backendStatus === 'unsupported',
    `Expected enable --dry-run to avoid backendStatus mutation, got ${stateAfterDryRunEnable.backendStatus}.`,
  );

  const statusAfterDisable = await runLifeline(tempDir, 'startup', 'status');
  assert(statusAfterDisable.code === 0, 'Expected startup status after disable to succeed.');
  assert(statusAfterDisable.stdout.includes('Startup enabled: no'), 'Expected disabled status after disable.');

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
