import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseConstArray(source, constName) {
  const match = source.match(
    new RegExp(`export const ${constName} = \\[(.*?)\\] as const;`, 's'),
  );
  assert(match, `Could not find ${constName} in app-manifest contract source.`);

  const values = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  assert(values.length > 0, `${constName} appears to be empty; expected non-empty contract list.`);
  return values;
}

function parseStringConst(source, constName) {
  const match = source.match(new RegExp(`${constName}\\s*=\\s*"([^"]+)"`));
  assert(match, `Could not read ${constName} from source.`);
  return match[1];
}

async function main() {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));

  const [
    manifestContractSource,
    playbookExportsSource,
    resolveConfigSource,
    manifestDocs,
    readme,
  ] = await Promise.all([
    readFile(path.join(repoRoot, 'src/contracts/app-manifest.ts'), 'utf8'),
    readFile(path.join(repoRoot, 'src/core/load-playbook-exports.ts'), 'utf8'),
    readFile(path.join(repoRoot, 'src/core/resolve-config.ts'), 'utf8'),
    readFile(path.join(repoRoot, 'docs/contracts/app-manifest.md'), 'utf8'),
    readFile(path.join(repoRoot, 'README.md'), 'utf8'),
  ]);

  const archetypes = parseConstArray(manifestContractSource, 'SUPPORTED_ARCHETYPES');
  const envModes = parseConstArray(manifestContractSource, 'SUPPORTED_ENV_MODES');
  const deployStrategies = parseConstArray(
    manifestContractSource,
    'SUPPORTED_DEPLOY_STRATEGIES',
  );
  const restartPolicies = parseConstArray(
    manifestContractSource,
    'SUPPORTED_RESTART_POLICIES',
  );

  for (const archetype of archetypes) {
    assert(
      manifestDocs.includes(`\`${archetype}\``),
      `docs/contracts/app-manifest.md is missing archetype \`${archetype}\` from code constants.`,
    );
  }

  for (const mode of envModes) {
    assert(
      manifestDocs.includes(`\`${mode}\``),
      `docs/contracts/app-manifest.md is missing env mode \`${mode}\` from code constants.`,
    );
  }

  for (const strategy of deployStrategies) {
    assert(
      manifestDocs.includes(`\`${strategy}\``),
      `docs/contracts/app-manifest.md is missing deploy strategy \`${strategy}\` from code constants.`,
    );
  }

  for (const policy of restartPolicies) {
    assert(
      manifestDocs.includes(`\`${policy}\``),
      `docs/contracts/app-manifest.md is missing restart policy \`${policy}\` from code constants.`,
    );
  }

  const docsSupportedArchetypesBlock = archetypes
    .map((value) => `- \`${value}\``)
    .join('\n');
  assert(
    manifestDocs.includes(docsSupportedArchetypesBlock),
    'docs/contracts/app-manifest.md supported archetypes list drifted from source constants ordering/content.',
  );

  const supportedSchemaVersionMatch = playbookExportsSource.match(
    /SUPPORTED_PLAYBOOK_SCHEMA_VERSION\s*=\s*(\d+)/,
  );
  assert(
    supportedSchemaVersionMatch,
    'Could not read SUPPORTED_PLAYBOOK_SCHEMA_VERSION from load-playbook-exports source.',
  );

  const canonicalFamily = parseStringConst(
    playbookExportsSource,
    'CANONICAL_PLAYBOOK_EXPORT_FAMILY',
  );
  const legacyFamily = parseStringConst(
    playbookExportsSource,
    'LEGACY_PLAYBOOK_EXPORT_FAMILY',
  );

  for (const docSurface of [manifestDocs, readme]) {
    assert(
      docSurface.includes('schemaVersion') && docSurface.includes('version'),
      'Playbook export docs must state schemaVersion/version compatibility behavior.',
    );
    assert(
      docSurface.includes('schemaVersion') &&
        (docSurface.includes('takes precedence') || docSurface.includes('is used')),
      'Playbook export docs must state schemaVersion precedence/selection over version.',
    );
    assert(
      docSurface.includes(`\`${canonicalFamily}\``),
      `Playbook export docs missing canonical export family \`${canonicalFamily}\` from source constants.`,
    );
    assert(
      docSurface.includes(`\`${legacyFamily}\``),
      `Playbook export docs missing legacy export family \`${legacyFamily}\` from source constants.`,
    );
  }

  assert(
    new RegExp(`normalize(?:s|d)?.*\`${escapeRegExp(canonicalFamily)}\``, 'i').test(
      manifestDocs,
    ),
    'docs/contracts/app-manifest.md must state normalization to canonical export family.',
  );

  assert(
    /if \(defaults\?\.runtime \|\| isRecord\(manifest\.runtime\)\)/.test(
      resolveConfigSource,
    ),
    'resolve-config.ts no longer shows explicit runtime merge behavior; update parity test expectations.',
  );

  assert(
    /nested `env` and `deploy` sections/.test(readme) === false,
    'README.md merge-precedence section is stale: it must include runtime section merge behavior.',
  );
  assert(
    readme.includes('nested `env`, `deploy`, and `runtime` sections'),
    'README.md must document runtime merge behavior to match resolve-config contract.',
  );

  console.log('Doc/code manifest + Playbook export contract parity deterministic verification passed.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Doc/code manifest parity deterministic verification failed: ${message}`);
  process.exitCode = 1;
});
