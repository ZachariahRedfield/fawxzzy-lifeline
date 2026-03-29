import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateFitnessMirrorManifestFile } from '../dist/contracts/fitness-mirror.js';

function runCliValidate(manifestPath) {
  return spawnSync('node', ['dist/cli.js', 'validate', manifestPath], {
    encoding: 'utf8',
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const canonicalPartial = runCliValidate(
  'fixtures/runtime-smoke-app/runtime-smoke-app.playbook.lifeline.yml',
);
assert(canonicalPartial.status === 1, 'canonical partial manifest should fail raw validation');
assert(
  (canonicalPartial.stderr + canonicalPartial.stdout).includes('installCommand: must be a non-empty string'),
  'canonical failure should mention missing required runtime fields',
);

const fitnessMirror = runCliValidate('examples/fitness-app.lifeline.yml');
assert(fitnessMirror.status === 0, 'fitness mirror should pass via narrow validation path');
assert(
  (fitnessMirror.stderr + fitnessMirror.stdout).includes('Fitness mirror manifest is valid'),
  'fitness mirror success should identify narrow boundary path',
);

const tempDir = mkdtempSync(join(tmpdir(), 'fitness-mirror-invalid-'));
const invalidPath = join(tempDir, 'invalid-fitness.lifeline.yml');
writeFileSync(
  invalidPath,
  [
    'name: fitness',
    'archetype: node-web',
    'port: 9999',
    'healthcheckPath: /login',
    'deploy:',
    '  workingDirectory: ..',
  ].join('\n'),
);

const mirrorIssues = await validateFitnessMirrorManifestFile(invalidPath);
assert(mirrorIssues.length > 0, 'invalid narrow mirror should fail');
assert(
  mirrorIssues.some((issue) => issue.path === 'port'),
  'invalid narrow mirror should report a clear port diagnostic',
);

rmSync(tempDir, { recursive: true, force: true });
console.log('validate boundary checks passed');
