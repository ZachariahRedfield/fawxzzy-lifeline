import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ensureBuilt } from './lib/ensure-built.mjs';

const execFileAsync = promisify(execFile);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function runCli(args) {
  const cliPath = './dist/cli.js';

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
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

function assertUsagePrinted(result, scenario) {
  assert(
    result.stdout.includes('Usage:'),
    `${scenario}: expected usage output in stdout, received ${JSON.stringify(result.stdout)}`,
  );
}

await ensureBuilt();

const noArgs = await runCli([]);
assert(noArgs.code === 0, `no args: expected exit code 0, got ${noArgs.code}`);
assertUsagePrinted(noArgs, 'no args');

const longHelp = await runCli(['--help']);
assert(longHelp.code === 0, `--help: expected exit code 0, got ${longHelp.code}`);
assertUsagePrinted(longHelp, '--help');

const shortHelp = await runCli(['-h']);
assert(shortHelp.code === 0, `-h: expected exit code 0, got ${shortHelp.code}`);
assertUsagePrinted(shortHelp, '-h');

const unknownCommand = await runCli(['definitely-unknown-command']);
assert(unknownCommand.code === 1, `unknown command: expected exit code 1, got ${unknownCommand.code}`);
assert(
  unknownCommand.stderr.includes('Unknown command: definitely-unknown-command'),
  `unknown command: expected unknown command message, got ${JSON.stringify(unknownCommand.stderr)}`,
);
assertUsagePrinted(unknownCommand, 'unknown command');

const missingManifestValidate = await runCli(['validate']);
assert(
  missingManifestValidate.code === 1,
  `validate missing manifest: expected exit code 1, got ${missingManifestValidate.code}`,
);
assert(
  missingManifestValidate.stderr.includes('Missing manifest path.'),
  `validate missing manifest: expected error, got ${JSON.stringify(missingManifestValidate.stderr)}`,
);
assertUsagePrinted(missingManifestValidate, 'validate missing manifest');

const missingManifestResolve = await runCli(['resolve']);
assert(
  missingManifestResolve.code === 1,
  `resolve missing manifest: expected exit code 1, got ${missingManifestResolve.code}`,
);
assert(
  missingManifestResolve.stderr.includes('Missing manifest path.'),
  `resolve missing manifest: expected error, got ${JSON.stringify(missingManifestResolve.stderr)}`,
);
assertUsagePrinted(missingManifestResolve, 'resolve missing manifest');

const missingManifestUp = await runCli(['up']);
assert(missingManifestUp.code === 1, `up missing manifest: expected exit code 1, got ${missingManifestUp.code}`);
assert(
  missingManifestUp.stderr.includes('Missing manifest path.'),
  `up missing manifest: expected error, got ${JSON.stringify(missingManifestUp.stderr)}`,
);
assertUsagePrinted(missingManifestUp, 'up missing manifest');

const missingAppDown = await runCli(['down']);
assert(missingAppDown.code === 1, `down missing app: expected exit code 1, got ${missingAppDown.code}`);
assert(
  missingAppDown.stderr.includes('Missing app name.'),
  `down missing app: expected error, got ${JSON.stringify(missingAppDown.stderr)}`,
);
assertUsagePrinted(missingAppDown, 'down missing app');

const missingAppStatus = await runCli(['status']);
assert(missingAppStatus.code === 1, `status missing app: expected exit code 1, got ${missingAppStatus.code}`);
assert(
  missingAppStatus.stderr.includes('Missing app name.'),
  `status missing app: expected error, got ${JSON.stringify(missingAppStatus.stderr)}`,
);
assertUsagePrinted(missingAppStatus, 'status missing app');

const missingAppLogs = await runCli(['logs']);
assert(missingAppLogs.code === 1, `logs missing app: expected exit code 1, got ${missingAppLogs.code}`);
assert(
  missingAppLogs.stderr.includes('Missing app name.'),
  `logs missing app: expected error, got ${JSON.stringify(missingAppLogs.stderr)}`,
);
assertUsagePrinted(missingAppLogs, 'logs missing app');

const invalidLogsLineCount = await runCli(['logs', 'demo-app', 'not-a-number']);
assert(
  invalidLogsLineCount.code === 1,
  `logs invalid line count: expected exit code 1, got ${invalidLogsLineCount.code}`,
);
assert(
  invalidLogsLineCount.stderr.includes('Invalid line count: not-a-number'),
  `logs invalid line count: expected error, got ${JSON.stringify(invalidLogsLineCount.stderr)}`,
);

console.log('CLI dispatch deterministic verification passed.');
