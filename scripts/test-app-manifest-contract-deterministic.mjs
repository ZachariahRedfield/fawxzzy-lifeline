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

function assertExactIssues(issues, expectedIssues) {
  assert(
    issues.length === expectedIssues.length,
    [
      `Expected ${expectedIssues.length} issues but received ${issues.length}`,
      `Expected: ${JSON.stringify(expectedIssues, null, 2)}`,
      `Actual: ${JSON.stringify(issues, null, 2)}`,
    ].join('\n'),
  );

  for (const expectedIssue of expectedIssues) {
    assertIncludesIssue(issues, expectedIssue.path, expectedIssue.message);
  }
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
assertExactIssues(valid.issues, []);
assert(valid.manifest?.archetype === 'node-web', 'Expected supported node-web archetype to validate.');

const alsoSupportedArchetype = validateAppManifest({
  ...makeValidManifest(),
  archetype: 'next-web',
});
assertExactIssues(alsoSupportedArchetype.issues, []);
assert(alsoSupportedArchetype.manifest?.archetype === 'next-web', 'Expected supported next-web archetype to validate.');

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

const invalidPorts = [0, 65536, 12.5, '4301'];
for (const port of invalidPorts) {
  const result = validateAppManifest({ ...makeValidManifest(), port });
  assertIncludesIssue(result.issues, 'port', 'must be an integer between 1 and 65535');
}

const validLowestPort = validateAppManifest({
  ...makeValidManifest(),
  port: 1,
});
assertExactIssues(validLowestPort.issues, []);

const validHighestPort = validateAppManifest({
  ...makeValidManifest(),
  port: 65535,
});
assertExactIssues(validHighestPort.issues, []);

const legacyRequired = validateAppManifest({
  ...makeValidManifest(),
  env: {
    mode: 'inline',
    required: ['LEGACY_KEY'],
  },
});
assertIncludesIssue(legacyRequired.issues, 'env.required', 'has been renamed to env.requiredKeys');

const requiredKeysPreferredOverLegacy = validateAppManifest({
  ...makeValidManifest(),
  env: {
    mode: 'inline',
    requiredKeys: ['CANONICAL'],
    required: ['LEGACY_IGNORED'],
  },
});
assertExactIssues(requiredKeysPreferredOverLegacy.issues, []);
assert(
  JSON.stringify(requiredKeysPreferredOverLegacy.manifest?.env.requiredKeys) === JSON.stringify(['CANONICAL']),
  'Expected env.requiredKeys to win when both env.requiredKeys and env.required are provided.',
);

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

const runtimeStringBooleans = validateAppManifest({
  ...makeValidManifest(),
  runtime: {
    restartPolicy: 'never',
    restorable: 'false',
  },
});
assertExactIssues(runtimeStringBooleans.issues, []);
assert(runtimeStringBooleans.manifest?.runtime.restorable === false, 'Expected runtime.restorable string false to normalize.');

const defaultedRuntime = validateAppManifest({
  ...makeValidManifest(),
  runtime: undefined,
});
assertExactIssues(defaultedRuntime.issues, []);
assert(defaultedRuntime.manifest?.runtime.restartPolicy === 'on-failure', 'Expected runtime.restartPolicy default when runtime is omitted.');
assert(defaultedRuntime.manifest?.runtime.restorable === true, 'Expected runtime.restorable default when runtime is omitted.');

const partialDefaultsWithoutRunnableFields = validatePartialManifest({
  runtime: {
    restorable: 'false',
  },
});
assertExactIssues(partialDefaultsWithoutRunnableFields.issues, []);
assert(
  partialDefaultsWithoutRunnableFields.manifest === undefined,
  'Expected partial validation without runnable fields to report no issues and no runnable manifest payload.',
);

const partialWithLegacyRequired = validatePartialManifest({
  env: {
    required: ['LEGACY_KEY'],
  },
});
assertExactIssues(partialWithLegacyRequired.issues, [
  { path: 'env.required', message: 'has been renamed to env.requiredKeys' },
]);

const partialDefaultsWithRunnableFields = validatePartialManifest({
  ...makeValidManifest(),
  runtime: {
    restorable: 'false',
  },
});
assertExactIssues(partialDefaultsWithRunnableFields.issues, []);
assert(partialDefaultsWithRunnableFields.manifest?.runtime.restorable === false, 'Expected partial manifest runtime.restorable to normalize to false.');
assert(partialDefaultsWithRunnableFields.manifest?.runtime.restartPolicy === 'on-failure', 'Expected partial manifest runtime.restartPolicy default.');

const optionalDefaultsAlias = validateOptionalAppManifestDefaults({
  ...makeValidManifest(),
  runtime: {
    restorable: 'true',
  },
});
assertExactIssues(optionalDefaultsAlias.issues, []);
assert(optionalDefaultsAlias.manifest?.runtime.restorable === true, 'Expected optional defaults alias to normalize runtime.restorable true.');

console.log('app-manifest contract deterministic checks passed');
