import { resolveStartupBackend } from '../dist/core/startup-backend.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function verifyUnsupportedDefaultSelection(platform) {
  const backend = resolveStartupBackend({ platform });
  const inspection = await backend.inspect();

  assert(
    backend.id === 'unsupported',
    `Expected unsupported backend id for ${platform}, got ${backend.id}.`,
  );
  assert(inspection.supported === false, `Expected unsupported backend for ${platform} to report unsupported.`);
  assert(inspection.status === 'unsupported', `Expected unsupported status for ${platform}, got ${inspection.status}.`);
  assert(
    inspection.mechanism === 'contract-only',
    `Expected contract-only mechanism for ${platform}, got ${inspection.mechanism}.`,
  );
  assert(
    inspection.detail.includes(platform),
    `Expected inspection detail to reference ${platform}, got: ${inspection.detail}`,
  );
}

async function verifyInjectedBackendSelection() {
  const fakeBackend = {
    id: 'deterministic-fake',
    capabilities: ['inspect', 'install', 'uninstall'],
    inspect: async () => ({
      supported: true,
      status: 'installed',
      mechanism: 'deterministic-fake',
      detail: 'deterministic fake backend',
    }),
    install: async () => ({ status: 'installed', detail: 'ok' }),
    uninstall: async () => ({ status: 'not-installed', detail: 'ok' }),
  };

  const backend = resolveStartupBackend({ platform: 'linux', backend: fakeBackend });
  const inspection = await backend.inspect();

  assert(backend.id === 'deterministic-fake', `Expected injected backend selection, got ${backend.id}.`);
  assert(inspection.supported === true, 'Expected injected backend inspect to be returned as-is.');
  assert(inspection.mechanism === 'deterministic-fake', `Expected fake mechanism, got ${inspection.mechanism}.`);
}

async function main() {
  await verifyUnsupportedDefaultSelection('win32');
  await verifyUnsupportedDefaultSelection('linux');
  await verifyUnsupportedDefaultSelection('darwin');
  await verifyInjectedBackendSelection();
  console.log('Deterministic startup backend selection verification passed.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Deterministic startup backend selection verification failed: ${message}`);
  process.exitCode = 1;
});
