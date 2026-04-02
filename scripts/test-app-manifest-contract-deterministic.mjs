import {
  validateAppManifest,
  validateOptionalAppManifestDefaults,
  validatePartialManifest,
} from '../dist/contracts/app-manifest.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertIncludesIssue(issues, expectedPath, expectedMessage) {
  const match = issues.find((issue) => issue.path === expectedPath && issue.message === expectedMessage);
  assert(
    Boolean(match),
    [
      `Expected issue { path: ${expectedPath}, message: ${expectedMessage} }`,
      `Actual issues: ${JSON.stringify(issues, null, 2)}`,
    ].join('\n'),
  );
}

function makeValidManifest() {
  return {
    name: 'demo',
    archetype: 'node-web',
    repo: 'https://example.com/repo.git',
    branch: 'main',
    installCommand: 'pnpm install',
    buildCommand: 'pnpm build',
    startCommand: 'node dist/server.js',
    port: 4301,
    healthcheckPath: '/health',
    env: {
      mode: 'inline',
      requiredKeys: ['API_KEY'],
    },
    deploy: {
      strategy: 'restart',
    },
    runtime: {
      restartPolicy: 'on-failure',
      restorable: true,
    },
  };
}

const valid = validateAppManifest(makeValidManifest());
assert(valid.issues.length === 0, `Expected valid manifest to have no issues: ${JSON.stringify(valid.issues)}`);
assert(valid.manifest?.runtime.restartPolicy === 'on-failure', 'Expected valid manifest runtime.restartPolicy to be preserved.');

const unsupportedArchetype = validateAppManifest({
  ...makeValidManifest(),
  archetype: 'python-web',
});
assertIncludesIssue(unsupportedArchetype.issues, 'archetype', 'must be one of: next-web, node-web');

const invalidHealthcheckPath = validateAppManifest({
  ...makeValidManifest(),
  healthcheckPath: 'health',
});
assertIncludesIssue(invalidHealthcheckPath.issues, 'healthcheckPath', "must start with '/'");

const invalidPorts = [0, 65536, 12.5];
for (const port of invalidPorts) {
  const result = validateAppManifest({ ...makeValidManifest(), port });
  assertIncludesIssue(result.issues, 'port', 'must be an integer between 1 and 65535');
}

const legacyRequired = validateAppManifest({
  ...makeValidManifest(),
  env: {
    mode: 'inline',
    required: ['LEGACY_KEY'],
  },
});
assertIncludesIssue(legacyRequired.issues, 'env.required', 'has been renamed to env.requiredKeys');

const invalidRequiredKeysShape = validateAppManifest({
  ...makeValidManifest(),
  env: {
    mode: 'inline',
    requiredKeys: [42],
  },
});
assertIncludesIssue(
  invalidRequiredKeysShape.issues,
  'env.requiredKeys',
  'must be an array when provided, and each key must be a non-empty string',
);

const fileModeMissingFile = validateAppManifest({
  ...makeValidManifest(),
  env: {
    mode: 'file',
    requiredKeys: [],
  },
});
assertIncludesIssue(fileModeMissingFile.issues, 'env.file', "is required when env.mode is 'file'");

const invalidRuntimeRestartPolicy = validateAppManifest({
  ...makeValidManifest(),
  runtime: {
    restartPolicy: 'always',
    restorable: true,
  },
});
assertIncludesIssue(
  invalidRuntimeRestartPolicy.issues,
  'runtime.restartPolicy',
  'must be one of: on-failure, never',
);

const invalidRuntimeRestorable = validateAppManifest({
  ...makeValidManifest(),
  runtime: {
    restartPolicy: 'never',
    restorable: 'sometimes',
  },
});
assertIncludesIssue(invalidRuntimeRestorable.issues, 'runtime.restorable', 'must be a boolean');

const defaultedRuntime = validateAppManifest({
  ...makeValidManifest(),
  runtime: undefined,
});
assert(defaultedRuntime.issues.length === 0, `Expected runtime omission to default cleanly: ${JSON.stringify(defaultedRuntime.issues)}`);
assert(defaultedRuntime.manifest?.runtime.restartPolicy === 'on-failure', 'Expected runtime.restartPolicy default when runtime is omitted.');
assert(defaultedRuntime.manifest?.runtime.restorable === true, 'Expected runtime.restorable default when runtime is omitted.');

const partialDefaults = validatePartialManifest({
  ...makeValidManifest(),
  runtime: {
    restorable: 'false',
  },
});
assert(partialDefaults.issues.length === 0, `Expected partial manifest to accept string booleans for runtime.restorable: ${JSON.stringify(partialDefaults.issues)}`);
assert(partialDefaults.manifest?.runtime.restorable === false, 'Expected partial manifest runtime.restorable to normalize to false.');
assert(partialDefaults.manifest?.runtime.restartPolicy === 'on-failure', 'Expected partial manifest runtime.restartPolicy default.');

const optionalDefaultsAlias = validateOptionalAppManifestDefaults({
  ...makeValidManifest(),
  runtime: {
    restorable: 'true',
  },
});
assert(optionalDefaultsAlias.issues.length === 0, `Expected optional defaults alias to validate cleanly: ${JSON.stringify(optionalDefaultsAlias.issues)}`);
assert(optionalDefaultsAlias.manifest?.runtime.restorable === true, 'Expected optional defaults alias to normalize runtime.restorable true.');

console.log('app-manifest contract deterministic checks passed');
