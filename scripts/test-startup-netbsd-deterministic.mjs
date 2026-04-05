import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createNetbsdRcDBackend } from '../dist/core/startup-backends/netbsd-rcd.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const { mkdtemp, access } = await import('node:fs/promises');

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lifeline-netbsd-backend-'));
  const rcDDirectory = path.join(tempRoot, 'etc', 'rc.d');
  const rcConfDirectory = path.join(tempRoot, 'etc', 'rc.conf.d');
  const scriptPath = path.join(rcDDirectory, 'lifeline_restore');
  const rcConfPath = path.join(rcConfDirectory, 'lifeline_restore');

  const backend = createNetbsdRcDBackend({ rcDDirectory, rcConfDirectory });

  const initialStatus = await backend.inspect();
  assert(initialStatus.status === 'not-installed', `Expected initial status not-installed, got ${initialStatus.status}.`);

  const dryRunInstall = await backend.install({
    scope: 'machine-local',
    restoreEntrypoint: 'lifeline restore',
    dryRun: true,
  });
  assert(dryRunInstall.status === 'not-installed', `Expected dry-run install status not-installed, got ${dryRunInstall.status}.`);
  assert(dryRunInstall.detail.includes('Dry-run:'), 'Expected dry-run install detail to include Dry-run marker.');

  await access(scriptPath).then(
    () => {
      throw new Error('Dry-run install must not create rc.d script.');
    },
    () => undefined,
  );
  await access(rcConfPath).then(
    () => {
      throw new Error('Dry-run install must not create rc.conf startup enablement.');
    },
    () => undefined,
  );

  const installResult = await backend.install({
    scope: 'machine-local',
    restoreEntrypoint: 'lifeline restore',
    dryRun: false,
  });
  assert(installResult.status === 'installed', `Expected install status installed, got ${installResult.status}.`);

  const scriptContents = await readFile(scriptPath, 'utf8');
  const rcConfContents = await readFile(rcConfPath, 'utf8');
  assert(scriptContents.includes('lifeline restore'), 'Expected NetBSD rc.d script to preserve canonical restore entrypoint.');
  assert(rcConfContents.includes('lifeline_restore="YES"'), 'Expected NetBSD rc.conf entry to enable startup.');

  const statusAfterInstall = await backend.inspect();
  assert(statusAfterInstall.status === 'installed', `Expected status installed after install, got ${statusAfterInstall.status}.`);

  const dryRunUninstall = await backend.uninstall({
    scope: 'machine-local',
    restoreEntrypoint: 'lifeline restore',
    dryRun: true,
  });
  assert(dryRunUninstall.status === 'installed', `Expected dry-run uninstall status installed, got ${dryRunUninstall.status}.`);
  assert(dryRunUninstall.detail.includes('Dry-run:'), 'Expected dry-run uninstall detail to include Dry-run marker.');

  const uninstallResult = await backend.uninstall({
    scope: 'machine-local',
    restoreEntrypoint: 'lifeline restore',
    dryRun: false,
  });
  assert(uninstallResult.status === 'not-installed', `Expected uninstall status not-installed, got ${uninstallResult.status}.`);

  const finalStatus = await backend.inspect();
  assert(finalStatus.status === 'not-installed', `Expected final status not-installed, got ${finalStatus.status}.`);

  console.log('Deterministic NetBSD startup backend verification passed.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Deterministic NetBSD startup backend verification failed: ${message}`);
  process.exitCode = 1;
});
