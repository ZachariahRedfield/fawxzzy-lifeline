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
assert(valid.length === 0, `Expected canonical fitness mirror to have no issues: ${JSON.stringify(valid)}`);

const nonObject = validateFitnessMirrorManifest('not-an-object');
assertIncludesIssue(nonObject, '$', 'manifest must be a YAML object');

const wrongTopLevelKeys = validateFitnessMirrorManifest({
  ...makeValidMirror(),
  runtime: { restorable: true },
});
assertIncludesIssue(
  wrongTopLevelKeys,
  '$',
  'expected top-level keys: archetype, deploy, healthcheckPath, name, port',
);

const wrongFieldValues = validateFitnessMirrorManifest({
  ...makeValidMirror(),
  name: 'fitness-mirror',
  archetype: 'next-web',
  port: 4400,
  healthcheckPath: '/health',
});
assertIncludesIssue(wrongFieldValues, 'name', "must equal 'fitness' for Fitness mirror boundary");
assertIncludesIssue(wrongFieldValues, 'archetype', "must equal 'node-web' for Fitness mirror boundary");
assertIncludesIssue(wrongFieldValues, 'port', 'must equal 4301 for Fitness mirror boundary');
assertIncludesIssue(
  wrongFieldValues,
  'healthcheckPath',
  "must equal '/login' for Fitness mirror boundary",
);

const deployWrongType = validateFitnessMirrorManifest({
  ...makeValidMirror(),
  deploy: 'not-an-object',
});
assertIncludesIssue(deployWrongType, 'deploy', 'must be an object');

const deployWrongKeys = validateFitnessMirrorManifest({
  ...makeValidMirror(),
  deploy: {
    workingDirectory: '..',
    extra: 'value',
  },
});
assertIncludesIssue(deployWrongKeys, 'deploy', 'expected deploy keys: workingDirectory');

const deployWrongWorkingDirectory = validateFitnessMirrorManifest({
  ...makeValidMirror(),
  deploy: {
    workingDirectory: '.',
  },
});
assertIncludesIssue(
  deployWrongWorkingDirectory,
  'deploy.workingDirectory',
  "must equal '..' for Fitness mirror boundary",
);

console.log('fitness-mirror contract deterministic checks passed');
