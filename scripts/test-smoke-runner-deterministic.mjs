import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function runNode(cwd, args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const exitError = /** @type {{ code?: number; stdout?: string; stderr?: string }} */ (error);
    return {
      code: typeof exitError.code === 'number' ? exitError.code : 1,
      stdout: exitError.stdout ?? '',
      stderr: exitError.stderr ?? '',
    };
  }
}

async function writeSmokeScript(tempScriptsDir, fileName, marker) {
  const contents = `console.log(${JSON.stringify(marker)});\n`;
  await writeFile(path.join(tempScriptsDir, fileName), contents, 'utf8');
}

const sourceRunnerPath = path.join(process.cwd(), 'scripts', 'smoke-runner.mjs');
const sourceRunner = await readFile(sourceRunnerPath, 'utf8');

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lifeline-smoke-runner-'));
const tempScriptsDir = path.join(tempRoot, 'scripts');

await mkdir(tempScriptsDir, { recursive: true });
await writeFile(path.join(tempScriptsDir, 'smoke-runner.mjs'), sourceRunner, 'utf8');

await writeSmokeScript(tempScriptsDir, 'smoke-runtime-restore-success-alpha.mjs', 'ran:restore-success-alpha');
await writeSmokeScript(tempScriptsDir, 'smoke-runtime-restart-branch-success-beta.mjs', 'ran:restart-branch-success-beta');
await writeSmokeScript(tempScriptsDir, 'smoke-runtime-restore-team-shared.mjs', 'ran:restore-team-shared');
await writeSmokeScript(tempScriptsDir, 'smoke-runtime-restore-prod-shared.mjs', 'ran:restore-prod-shared');

try {
  const missingArgs = await runNode(tempRoot, ['scripts/smoke-runner.mjs']);
  assert(missingArgs.code === 1, `missing args: expected code 1, got ${missingArgs.code}`);
  assert(
    missingArgs.stderr.includes('Usage: node scripts/smoke-runner.mjs <mode> <scenario>'),
    `missing args: expected usage text, got ${JSON.stringify(missingArgs.stderr)}`,
  );

  const unknownMode = await runNode(tempRoot, ['scripts/smoke-runner.mjs', 'bogus', 'anything']);
  assert(unknownMode.code === 1, `unknown mode: expected code 1, got ${unknownMode.code}`);
  assert(
    unknownMode.stderr.includes('Unknown smoke mode: bogus'),
    `unknown mode: expected error text, got ${JSON.stringify(unknownMode.stderr)}`,
  );

  const unknownScenario = await runNode(tempRoot, ['scripts/smoke-runner.mjs', 'runtime', 'totally-missing']);
  assert(unknownScenario.code === 1, `unknown scenario: expected code 1, got ${unknownScenario.code}`);
  assert(
    unknownScenario.stderr.includes('Unknown scenario "totally-missing" for mode "runtime".'),
    `unknown scenario: expected error text, got ${JSON.stringify(unknownScenario.stderr)}`,
  );

  const ambiguousSuffix = await runNode(tempRoot, ['scripts/smoke-runner.mjs', 'runtime', 'shared']);
  assert(ambiguousSuffix.code === 2, `ambiguous suffix: expected code 2, got ${ambiguousSuffix.code}`);
  assert(
    ambiguousSuffix.stderr.includes('Ambiguous scenario selector "shared" for mode "runtime".'),
    `ambiguous suffix: expected ambiguity text, got ${JSON.stringify(ambiguousSuffix.stderr)}`,
  );
  assert(
    ambiguousSuffix.stderr.includes('restore-team-shared') && ambiguousSuffix.stderr.includes('restore-prod-shared'),
    `ambiguous suffix: expected match list, got ${JSON.stringify(ambiguousSuffix.stderr)}`,
  );

  const exactMatch = await runNode(tempRoot, [
    'scripts/smoke-runner.mjs',
    'runtime',
    'restore-success-alpha',
  ]);
  assert(exactMatch.code === 0, `exact match: expected code 0, got ${exactMatch.code}`);
  assert(
    exactMatch.stdout.includes('ran:restore-success-alpha'),
    `exact match: expected dispatched script output, got ${JSON.stringify(exactMatch.stdout)}`,
  );

  const suffixMatch = await runNode(tempRoot, ['scripts/smoke-runner.mjs', 'runtime', 'success-beta']);
  assert(suffixMatch.code === 0, `suffix match: expected code 0, got ${suffixMatch.code}`);
  assert(
    suffixMatch.stdout.includes('ran:restart-branch-success-beta'),
    `suffix match: expected dispatched script output, got ${JSON.stringify(suffixMatch.stdout)}`,
  );

  console.log('Smoke runner deterministic verification passed.');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
