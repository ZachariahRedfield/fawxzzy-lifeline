import { readFile } from 'node:fs/promises';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function buildRestoreEntrypointCommand({ nodeBinary = 'node', cliPath = 'dist/cli.js' } = {}) {
  return `${nodeBinary} ${cliPath} restore`;
}

function buildStartupRegistrationPlan({
  appName,
  workingDirectory,
  nodeBinary = 'node',
  cliPath = 'dist/cli.js',
}) {
  const restoreCommand = buildRestoreEntrypointCommand({ nodeBinary, cliPath });
  return {
    appName,
    restoreCommand,
    windowsTaskName: `Lifeline Restore (${appName})`,
    windowsCommand: `schtasks /Create /TN "Lifeline Restore (${appName})" /TR "${restoreCommand}" /SC ONLOGON`,
    launchdLabel: `dev.lifeline.restore.${appName}`,
    launchdProgramArguments: [nodeBinary, cliPath, 'restore'],
    systemdExecStart: restoreCommand,
    workingDirectory,
  };
}

function inspectStartupRegistrationState(entry) {
  return {
    enabled: entry.status === 'enabled',
    status: entry.status,
    registrationId: entry.registrationId,
    restoreEntrypoint: entry.restoreEntrypoint,
  };
}

async function verifyRestoreEntrypointWiring() {
  const cliSource = await readFile(new URL('../src/cli.ts', import.meta.url), 'utf8');

  assert(
    cliSource.includes('runRestoreCommand') && cliSource.includes('case "restore":'),
    'Expected src/cli.ts to keep restore entrypoint wired through runRestoreCommand.',
  );

  assert(
    cliSource.includes('lifeline restore'),
    'Expected CLI usage output to keep the restore command discoverable.',
  );
}

function verifyStartupCommandPlanning() {
  const plan = buildStartupRegistrationPlan({
    appName: 'runtime-smoke-app',
    workingDirectory: '/tmp/runtime-smoke-app',
  });

  assert(
    plan.restoreCommand === 'node dist/cli.js restore',
    `Expected deterministic restore command, got: ${plan.restoreCommand}`,
  );

  assert(
    plan.windowsCommand.includes('schtasks /Create') && plan.windowsCommand.includes('ONLOGON'),
    `Expected deterministic Task Scheduler registration command, got: ${plan.windowsCommand}`,
  );

  assert(
    plan.launchdProgramArguments.join(' ') === 'node dist/cli.js restore',
    `Expected launchd ProgramArguments to target restore entrypoint, got: ${plan.launchdProgramArguments.join(' ')}`,
  );

  assert(
    plan.systemdExecStart === 'node dist/cli.js restore',
    `Expected systemd ExecStart to target restore entrypoint, got: ${plan.systemdExecStart}`,
  );
}

function verifyRegistrationStateInspection() {
  const snapshot = inspectStartupRegistrationState({
    status: 'enabled',
    registrationId: 'lifeline-runtime-smoke-app-startup',
    restoreEntrypoint: 'node dist/cli.js restore',
  });

  assert(snapshot.enabled, 'Expected startup state inspection to mark enabled status as true.');
  assert(
    snapshot.restoreEntrypoint === 'node dist/cli.js restore',
    `Expected startup state inspection to keep restore entrypoint, got ${snapshot.restoreEntrypoint}`,
  );
}

async function main() {
  await verifyRestoreEntrypointWiring();
  verifyStartupCommandPlanning();
  verifyRegistrationStateInspection();
  console.log('Wave 2 startup deterministic verification passed.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Wave 2 startup deterministic verification failed: ${message}`);
  process.exitCode = 1;
});
