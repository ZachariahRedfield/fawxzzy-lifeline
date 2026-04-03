import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runNode(args, cwd) {
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
  });
}

const repoRoot = process.cwd();
const tempRoot = mkdtempSync(resolve(tmpdir(), 'lifeline-validate-fitness-script-'));
const tempScriptDir = resolve(tempRoot, 'scripts');
const tempExamplesDir = resolve(tempRoot, 'examples');
const tempDistContractsDir = resolve(tempRoot, 'dist', 'contracts');

mkdirSync(tempScriptDir, { recursive: true });
mkdirSync(tempExamplesDir, { recursive: true });
mkdirSync(tempDistContractsDir, { recursive: true });

copyFileSync(resolve(repoRoot, 'scripts/validate-fitness-mirror.mjs'), resolve(tempScriptDir, 'validate-fitness-mirror.mjs'));
copyFileSync(resolve(repoRoot, 'examples/fitness-app.lifeline.yml'), resolve(tempExamplesDir, 'fitness-app.lifeline.yml'));

const validatorStub = `import { readFile } from 'node:fs/promises';

export async function validateFitnessMirrorManifestFile(filePath) {
  const contents = await readFile(filePath, 'utf8');
  const issues = [];
  const nameLine = contents.split(/\\r?\\n/).find((line) => line.startsWith('name:')) ?? '';
  if (nameLine.trim() !== 'name: fitness') {
    issues.push({
      path: 'name',
      message: "must equal 'fitness' for Fitness mirror boundary",
    });
  }
  return issues;
}
`;

writeFileSync(resolve(tempDistContractsDir, 'fitness-mirror.js'), validatorStub, 'utf8');

const scriptRelativePath = 'scripts/validate-fitness-mirror.mjs';
const scriptAbsolutePath = resolve(tempRoot, scriptRelativePath);
const expectedSuccessStdout = 'Fitness mirror validation passed for examples/fitness-app.lifeline.yml.\n';

try {
  const successRelative = runNode([scriptRelativePath], tempRoot);
  assert(successRelative.status === 0, `relative success run failed:\n${successRelative.stdout}\n${successRelative.stderr}`);
  assert(
    successRelative.stdout === expectedSuccessStdout,
    `relative success stdout drifted:\n${JSON.stringify(successRelative.stdout)}`,
  );
  assert(successRelative.stderr === '', `relative success should not write stderr:\n${successRelative.stderr}`);

  const externalCwd = mkdtempSync(resolve(tmpdir(), 'lifeline-validate-fitness-script-external-cwd-'));
  const successAbsolute = runNode([scriptAbsolutePath], externalCwd);
  assert(successAbsolute.status === 0, `absolute success run failed:\n${successAbsolute.stdout}\n${successAbsolute.stderr}`);
  assert(
    successAbsolute.stdout === expectedSuccessStdout,
    `absolute success stdout drifted:\n${JSON.stringify(successAbsolute.stdout)}`,
  );
  assert(successAbsolute.stderr === '', `absolute success should not write stderr:\n${successAbsolute.stderr}`);

  const corruptedMirror = [
    'name: fitness-mirror',
    'archetype: node-web',
    'port: 4301',
    'healthcheckPath: /login',
    'deploy:',
    '  workingDirectory: ..',
    '',
  ].join('\n');

  const tempMirrorPath = resolve(tempExamplesDir, 'fitness-app.lifeline.yml');
  const originalMirror = readFileSync(tempMirrorPath, 'utf8');
  assert(originalMirror.includes('name: fitness'), 'expected baseline temp mirror to be canonical before corruption');
  writeFileSync(tempMirrorPath, corruptedMirror, 'utf8');

  const failureRun = runNode([scriptRelativePath], tempRoot);
  assert(failureRun.status === 1, `failure run should exit 1:\n${failureRun.stdout}\n${failureRun.stderr}`);
  assert(failureRun.stdout === '', `failure run should not write stdout:\n${failureRun.stdout}`);

  const expectedFailureStderr = [
    'Fitness mirror validation failed for examples/fitness-app.lifeline.yml:',
    "- name: must equal 'fitness' for Fitness mirror boundary",
    '',
  ].join('\n');

  assert(
    failureRun.stderr === expectedFailureStderr,
    [
      'failure stderr drifted',
      `expected: ${JSON.stringify(expectedFailureStderr)}`,
      `actual: ${JSON.stringify(failureRun.stderr)}`,
    ].join('\n'),
  );

  console.log('validate-fitness-mirror script deterministic checks passed');
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
