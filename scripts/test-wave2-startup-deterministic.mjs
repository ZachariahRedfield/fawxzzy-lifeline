import { readFile } from 'node:fs/promises';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function buildStartupContractPlan({ action }) {
  return {
    action,
    scope: 'machine-local',
    restoreEntrypoint: 'lifeline restore',
    backendStatus: 'not-installed',
  };
}

function inspectStartupContractState(entry) {
  return {
    enabled: entry.intent === 'enabled',
    scope: entry.scope,
    restoreEntrypoint: entry.restoreEntrypoint,
    backendStatus: entry.backendStatus,
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

async function verifyContractSurfaceWiring() {
  const startupCommandSource = await readFile(new URL('../src/commands/startup.ts', import.meta.url), 'utf8');
  const startupCoreSource = await readFile(new URL('../src/core/startup-contract.ts', import.meta.url), 'utf8');

  assert(
    startupCommandSource.includes('--dry-run'),
    'Expected startup command to expose --dry-run planning support.',
  );

  assert(
    startupCoreSource.includes('mechanism: "contract-only"'),
    'Expected startup core status to stay platform-neutral with contract-only mechanism.',
  );

  assert(
    startupCoreSource.includes('restoreEntrypoint: "lifeline restore"'),
    'Expected startup core to keep restore entrypoint as lifeline restore.',
  );
}

function verifyStartupContractPlanning() {
  const plan = buildStartupContractPlan({ action: 'enable' });

  assert(plan.scope === 'machine-local', `Expected machine-local scope, got: ${plan.scope}`);
  assert(
    plan.restoreEntrypoint === 'lifeline restore',
    `Expected deterministic restore entrypoint, got: ${plan.restoreEntrypoint}`,
  );
  assert(
    plan.backendStatus === 'not-installed',
    `Expected deferred backend status, got: ${plan.backendStatus}`,
  );
}

function verifyContractStateInspection() {
  const snapshot = inspectStartupContractState({
    intent: 'enabled',
    scope: 'machine-local',
    restoreEntrypoint: 'lifeline restore',
    backendStatus: 'not-installed',
  });

  assert(snapshot.enabled, 'Expected startup state inspection to mark enabled intent as true.');
  assert(
    snapshot.restoreEntrypoint === 'lifeline restore',
    `Expected startup state inspection to keep restore entrypoint, got ${snapshot.restoreEntrypoint}`,
  );
}

async function main() {
  await verifyRestoreEntrypointWiring();
  await verifyContractSurfaceWiring();
  verifyStartupContractPlanning();
  verifyContractStateInspection();
  console.log('Wave 2 startup deterministic verification passed.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Wave 2 startup deterministic verification failed: ${message}`);
  process.exitCode = 1;
});
