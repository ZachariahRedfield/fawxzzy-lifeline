import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function parseStringLiteralUnion(source, typeName) {
  const match = source.match(new RegExp(`type ${typeName} = ([^;]+);`));
  assert(match, `Could not find ${typeName} union in startup contract source.`);
  const values = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  assert(values.length > 0, `${typeName} union appears empty.`);
  return values;
}

function parseDefaultStartupRegistryPlatforms(source) {
  const registryBlockMatch = source.match(
    /DEFAULT_STARTUP_BACKEND_REGISTRY:[\s\S]*?byPlatform:\s*{([\s\S]*?)\n\s*},\n};/,
  );
  assert(
    registryBlockMatch,
    "Could not parse DEFAULT_STARTUP_BACKEND_REGISTRY.byPlatform from startup backend source.",
  );

  const platforms = [...registryBlockMatch[1].matchAll(/^\s*([a-z0-9_-]+)\s*:/gm)].map(
    (entry) => entry[1],
  );
  assert(platforms.length > 0, "Startup backend registry platform list appears empty.");
  return platforms;
}

async function main() {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));

  const [startupSource, startupBackendSource, startupDocs, readme] = await Promise.all([
    readFile(path.join(repoRoot, 'src/core/startup-contract.ts'), 'utf8'),
    readFile(path.join(repoRoot, 'src/core/startup-backend.ts'), 'utf8'),
    readFile(path.join(repoRoot, 'docs/startup-contract.md'), 'utf8'),
    readFile(path.join(repoRoot, 'README.md'), 'utf8'),
  ]);

  const actions = ['status', 'enable', 'disable'];
  const scope = 'machine-local';
  const restoreEntrypoint = 'lifeline restore';
  const backendStatus = 'not-installed';
  const startupIntents = parseStringLiteralUnion(startupSource, 'StartupIntent');
  const registryPlatforms = parseDefaultStartupRegistryPlatforms(startupBackendSource);

  for (const platform of registryPlatforms) {
    assert(
      startupDocs.includes(`\`${platform}\``),
      `docs/startup-contract.md must list startup backend registry platform \`${platform}\`.`,
    );
    assert(
      readme.includes(`\`${platform}\``),
      `README.md must list startup backend registry platform \`${platform}\`.`,
    );
  }

  for (const action of actions) {
    assert(
      startupDocs.includes(`lifeline startup ${action}`),
      `docs/startup-contract.md is missing startup action ${action} from CLI contract.`,
    );
    assert(
      readme.includes(`pnpm lifeline startup ${action}`),
      `README.md is missing startup action ${action} from CLI contract.`,
    );
  }

  assert(
    startupDocs.includes('enable [--dry-run]') && startupDocs.includes('disable [--dry-run]'),
    'docs/startup-contract.md must document --dry-run support for enable/disable.',
  );
  assert(
    readme.includes('startup enable --dry-run') && readme.includes('startup disable --dry-run'),
    'README.md must document --dry-run support for startup enable/disable.',
  );

  for (const surface of [startupSource, startupDocs, readme]) {
    assert(
      surface.includes(scope),
      `Startup contract parity drift: missing scope value \`${scope}\` in one startup contract surface.`,
    );
    assert(
      surface.includes(restoreEntrypoint),
      `Startup contract parity drift: missing restore entrypoint \`${restoreEntrypoint}\` in one startup contract surface.`,
    );
  }

  assert(
    startupSource.includes(`backendStatus: "${backendStatus}"`) ||
      startupSource.includes(`backendStatus': '${backendStatus}'`),
    `startup-contract.ts is expected to persist backendStatus \`${backendStatus}\`.`,
  );
  assert(
    startupDocs.includes(`\`${backendStatus}\``),
    `docs/startup-contract.md must mention backend readiness marker \`${backendStatus}\`.`,
  );

  const persistedFields = [
    'version',
    'scope',
    'restoreEntrypoint',
    'intent',
    'backendStatus',
    'updatedAt',
  ];

  for (const field of persistedFields) {
    assert(
      startupDocs.includes(`\`${field}\``),
      `docs/startup-contract.md missing persisted startup metadata field \`${field}\`.`,
    );
  }

  for (const intent of startupIntents) {
    assert(
      startupDocs.includes(`\`${intent}\``) || startupDocs.includes(intent),
      `docs/startup-contract.md must document startup intent value \`${intent}\`.`,
    );
  }

  assert(
    readme.includes('mechanism (`contract-only`)') || readme.includes('mechanism (\`contract-only\`)'),
    'README.md must document startup status mechanism contract value contract-only.',
  );

  assert(
    startupDocs.includes('contract-only') && readme.includes('contract-only'),
    'Startup docs and README must both explain contract-only startup behavior.',
  );

  assert(
    startupDocs.includes('win32') && readme.includes('win32'),
    'Startup docs and README must both document current Windows (win32) backend status.',
  );

  assert(
    startupDocs.includes('without writing state') && readme.includes('without mutating'),
    'Startup docs and README must both explain dry-run as non-mutating behavior.',
  );

  console.log('Doc/code startup contract parity deterministic verification passed.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Doc/code startup parity deterministic verification failed: ${message}`);
  process.exitCode = 1;
});
