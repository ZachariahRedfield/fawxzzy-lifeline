import { validateFitnessMirrorManifest } from '../dist/contracts/fitness-mirror.js';

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

function makeValidMirror() {
  return {
    name: 'fitness',
    archetype: 'node-web',
    port: 4301,
    healthcheckPath: '/login',
    deploy: {
      workingDirectory: '..',
    },
  };
}

const valid = validateFitnessMirrorManifest(makeValidMirror());
assertExactIssues(valid, []);

const nonObject = validateFitnessMirrorManifest('not-an-object');
assertExactIssues(nonObject, [{ path: '$', message: 'manifest must be a YAML object' }]);

const wrongTopLevelKeys = validateFitnessMirrorManifest({
  ...makeValidMirror(),
  runtime: { restorable: true },
});
assertIncludesIssue(
  wrongTopLevelKeys,
  '$',
  'expected top-level keys: archetype, deploy, healthcheckPath, name, port',
);

const missingDeploy = validateFitnessMirrorManifest({
  name: 'fitness',
  archetype: 'node-web',
  port: 4301,
  healthcheckPath: '/login',
});
assertExactIssues(missingDeploy, [
  {
    path: '$',
    message: 'expected top-level keys: archetype, deploy, healthcheckPath, name, port',
  },
  { path: 'deploy', message: 'must be an object' },
]);

const wrongFieldValues = validateFitnessMirrorManifest({
  ...makeValidMirror(),
  name: 'fitness-mirror',
  archetype: 'next-web',
  port: 4400,
  healthcheckPath: '/health',
});
assertExactIssues(wrongFieldValues, [
  { path: 'name', message: "must equal 'fitness' for Fitness mirror boundary" },
  { path: 'archetype', message: "must equal 'node-web' for Fitness mirror boundary" },
  { path: 'port', message: 'must equal 4301 for Fitness mirror boundary' },
  { path: 'healthcheckPath', message: "must equal '/login' for Fitness mirror boundary" },
]);

const deployWrongType = validateFitnessMirrorManifest({
  ...makeValidMirror(),
  deploy: 'not-an-object',
});
assertExactIssues(deployWrongType, [{ path: 'deploy', message: 'must be an object' }]);

const deployWrongKeys = validateFitnessMirrorManifest({
  ...makeValidMirror(),
  deploy: {
    workingDirectory: '..',
    extra: 'value',
  },
});
assertExactIssues(deployWrongKeys, [{ path: 'deploy', message: 'expected deploy keys: workingDirectory' }]);

const deployWrongWorkingDirectory = validateFitnessMirrorManifest({
  ...makeValidMirror(),
  deploy: {
    workingDirectory: '.',
  },
});
assertExactIssues(deployWrongWorkingDirectory, [
  {
    path: 'deploy.workingDirectory',
    message: "must equal '..' for Fitness mirror boundary",
  },
]);

const deployNestedMismatches = validateFitnessMirrorManifest({
  ...makeValidMirror(),
  deploy: {
    wrongKey: 'x',
  },
});
assertExactIssues(deployNestedMismatches, [
  { path: 'deploy', message: 'expected deploy keys: workingDirectory' },
  {
    path: 'deploy.workingDirectory',
    message: "must equal '..' for Fitness mirror boundary",
  },
]);

console.log('fitness-mirror contract deterministic checks passed');
