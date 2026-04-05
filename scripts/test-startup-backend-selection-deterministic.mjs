import { resolveStartupBackend } from '../dist/core/startup-backend.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}


async function verifyDarwinDefaultSelection() {
  const backend = resolveStartupBackend({ platform: 'darwin' });
  const inspection = await backend.inspect();

  assert(
    backend.id === 'launchd-agent',
    `Expected launchd-agent backend id for darwin, got ${backend.id}.`,
  );
  assert(inspection.mechanism === 'launchd-agent', `Expected launchd-agent mechanism for darwin, got ${inspection.mechanism}.`);
  assert(
    ['installed', 'not-installed', 'unsupported'].includes(inspection.status),
    `Expected darwin inspection status to be installed|not-installed|unsupported, got ${inspection.status}.`,
  );
}

async function verifyLinuxDefaultSelection() {
  const backend = resolveStartupBackend({ platform: 'linux' });
  const inspection = await backend.inspect();

  assert(
    backend.id === 'systemd-user',
    `Expected systemd-user backend id for linux, got ${backend.id}.`,
  );
  assert(
    inspection.mechanism === 'systemd-user',
    `Expected systemd-user mechanism for linux, got ${inspection.mechanism}.`,
  );
}

async function verifyFreebsdDefaultSelection() {
  const backend = resolveStartupBackend({ platform: 'freebsd' });
  const inspection = await backend.inspect();

  assert(
    backend.id === 'freebsd-rc.d',
    `Expected freebsd-rc.d backend id for freebsd, got ${backend.id}.`,
  );
  assert(
    inspection.mechanism === 'freebsd-rc.d',
    `Expected freebsd-rc.d mechanism for freebsd, got ${inspection.mechanism}.`,
  );
  assert(
    ['installed', 'not-installed'].includes(inspection.status),
    `Expected freebsd inspection status to be installed|not-installed, got ${inspection.status}.`,
  );
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

async function verifyRegistrySelectionAndFallback() {
  const registryBackend = {
    id: 'registry-backend',
    capabilities: ['inspect', 'install', 'uninstall'],
    inspect: async () => ({
      supported: true,
      status: 'installed',
      mechanism: 'registry-backend',
      detail: 'registry backend selected',
    }),
    install: async () => ({ status: 'installed', detail: 'ok' }),
    uninstall: async () => ({ status: 'not-installed', detail: 'ok' }),
  };

  const selected = resolveStartupBackend({
    platform: 'linux',
    registry: {
      byPlatform: {
        linux: () => registryBackend,
      },
    },
  });
  const selectedInspection = await selected.inspect();
  assert(selected.id === 'registry-backend', `Expected registry backend to be selected, got ${selected.id}.`);
  assert(selectedInspection.mechanism === 'registry-backend', 'Expected registry inspection result.');

  const fallback = resolveStartupBackend({
    platform: 'darwin',
    registry: {
      byPlatform: {
        linux: () => registryBackend,
      },
    },
  });
  const fallbackInspection = await fallback.inspect();
  assert(fallback.id === 'unsupported', `Expected unsupported fallback backend, got ${fallback.id}.`);
  assert(fallbackInspection.status === 'unsupported', `Expected unsupported fallback status, got ${fallbackInspection.status}.`);
}

async function main() {
  const windowsDefault = resolveStartupBackend({ platform: 'win32' });
  const windowsInspection = await windowsDefault.inspect();
  assert(
    windowsDefault.id === 'windows-task-scheduler',
    `Expected Windows default backend id windows-task-scheduler, got ${windowsDefault.id}.`,
  );
  assert(
    windowsInspection.mechanism === 'windows-task-scheduler',
    `Expected Windows mechanism windows-task-scheduler, got ${windowsInspection.mechanism}.`,
  );
  await verifyDarwinDefaultSelection();
  await verifyLinuxDefaultSelection();
  await verifyFreebsdDefaultSelection();
  await verifyUnsupportedDefaultSelection('openbsd');
  await verifyInjectedBackendSelection();
  await verifyRegistrySelectionAndFallback();
  console.log('Deterministic startup backend selection verification passed.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Deterministic startup backend selection verification failed: ${message}`);
  process.exitCode = 1;
});
