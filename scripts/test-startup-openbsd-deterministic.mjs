import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createOpenbsdRcctlBackend } from '../dist/core/startup-backends/openbsd-rcctl.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createFakeRunner() {
  const state = {
    enabled: false,
    flags: '',
  };

  const calls = [];

  const runner = async (args) => {
    calls.push(args);

    if (args[0] === 'get' && args[1] === 'lifeline_restore' && args[2] === 'status') {
      return { code: 0, stdout: state.enabled ? 'on' : 'off', stderr: '' };
    }

    if (args[0] === 'get' && args[1] === 'lifeline_restore' && args[2] === 'flags') {
      return { code: 0, stdout: state.flags, stderr: '' };
    }

    if (args[0] === 'set' && args[1] === 'lifeline_restore' && args[2] === 'flags') {
      state.flags = args[3] ?? '';
      return { code: 0, stdout: '', stderr: '' };
    }

    if (args[0] === 'enable' && args[1] === 'lifeline_restore') {
      state.enabled = true;
      return { code: 0, stdout: '', stderr: '' };
    }

    if (args[0] === 'disable' && args[1] === 'lifeline_restore') {
      state.enabled = false;
      return { code: 0, stdout: '', stderr: '' };
    }

    return { code: 1, stdout: '', stderr: `Unexpected rcctl command: ${args.join(' ')}` };
  };

  return {
    runner,
    state,
    calls,
  };
}

async function main() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'lifeline-openbsd-'));
  const rcDDirectory = path.join(tempRoot, 'rc.d');

  const fakeRunner = createFakeRunner();
  const backend = createOpenbsdRcctlBackend(fakeRunner.runner, { rcDDirectory });

  const initialInspection = await backend.inspect();
  assert(initialInspection.status === 'not-installed', `Expected initial status not-installed, got ${initialInspection.status}.`);

  const dryRunInstall = await backend.install({
    scope: 'machine-local',
    restoreEntrypoint: 'lifeline restore',
    dryRun: true,
  });
  assert(dryRunInstall.detail.includes('Dry-run:'), 'Expected dry-run install detail to include Dry-run marker.');
  assert(fakeRunner.state.enabled === false, 'Dry-run install must not mutate rcctl enabled state.');
  assert(fakeRunner.state.flags === '', 'Dry-run install must not mutate rcctl flags state.');

  const installResult = await backend.install({
    scope: 'machine-local',
    restoreEntrypoint: 'lifeline restore',
    dryRun: false,
  });
  assert(installResult.status === 'installed', `Expected install status installed, got ${installResult.status}.`);
  assert(fakeRunner.state.enabled === true, 'Install must enable rcctl service state.');
  assert(fakeRunner.state.flags === 'restore', `Install must set restore flags, got ${fakeRunner.state.flags}.`);

  const scriptPath = path.join(rcDDirectory, 'lifeline_restore');
  const scriptContents = await readFile(scriptPath, 'utf8');
  assert(scriptContents.includes('daemon="/usr/local/bin/lifeline"'), 'Expected script to set daemon path to lifeline binary.');
  assert(scriptContents.includes('daemon_flags="restore"'), 'Expected script to set daemon flags to restore.');

  const installedInspection = await backend.inspect();
  assert(installedInspection.status === 'installed', `Expected status installed after installation, got ${installedInspection.status}.`);

  const dryRunUninstall = await backend.uninstall({
    scope: 'machine-local',
    restoreEntrypoint: 'lifeline restore',
    dryRun: true,
  });
  assert(dryRunUninstall.detail.includes('Dry-run:'), 'Expected dry-run uninstall detail to include Dry-run marker.');
  assert(fakeRunner.state.enabled === true, 'Dry-run uninstall must not mutate rcctl enabled state.');

  const uninstallResult = await backend.uninstall({
    scope: 'machine-local',
    restoreEntrypoint: 'lifeline restore',
    dryRun: false,
  });
  assert(uninstallResult.status === 'not-installed', `Expected uninstall status not-installed, got ${uninstallResult.status}.`);
  assert(fakeRunner.state.enabled === false, 'Uninstall must disable rcctl service state.');
  assert(fakeRunner.state.flags === '', 'Uninstall should clear rcctl flags state.');

  const finalInspection = await backend.inspect();
  assert(finalInspection.status === 'not-installed', `Expected final status not-installed, got ${finalInspection.status}.`);

  console.log('Deterministic OpenBSD startup backend verification passed.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Deterministic OpenBSD startup backend verification failed: ${message}`);
  process.exitCode = 1;
});
