import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeOutput(text) {
  return text.replace(/\r\n/g, '\n');
}

async function ensureBuiltCli(repoRoot) {
  const cliPath = path.join(repoRoot, 'dist', 'cli.js');
  try {
    await access(cliPath);
  } catch {
    await execFileAsync('pnpm', ['build'], {
      cwd: repoRoot,
      env: process.env,
    });
  }
  return cliPath;
}

async function runValidate(cliPath, repoRoot, envOverrides = {}, extraArgs = []) {
  const manifestPath = 'fixtures/runtime-smoke-app/runtime-smoke-app.playbook.lifeline.yml';

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cliPath, 'validate', manifestPath, ...extraArgs],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          ...envOverrides,
        },
      },
    );
    return { code: 0, stdout: normalizeOutput(stdout), stderr: normalizeOutput(stderr) };
  } catch (error) {
    const exitError = /** @type {{ code?: number; stdout?: string; stderr?: string }} */ (error);
    return {
      code: typeof exitError.code === 'number' ? exitError.code : 1,
      stdout: normalizeOutput(exitError.stdout ?? ''),
      stderr: normalizeOutput(exitError.stderr ?? ''),
    };
  }
}

function pickSemanticLines(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter(
      (line) =>
        line.startsWith('Resolved manifest is valid:') ||
        line.startsWith('- app:') ||
        line.startsWith('- archetype:') ||
        line.startsWith('- port:') ||
        line.startsWith('- playbook:'),
    );
}

async function main() {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const cliPath = await ensureBuiltCli(repoRoot);

  const playbookPath = 'fixtures/playbook-export';
  const expectedPlaybookAbs = path.resolve(repoRoot, playbookPath).replace(/\\/g, '/');

  const explicit = await runValidate(cliPath, repoRoot, {}, ['--playbook-path', playbookPath]);
  assert(explicit.code === 0, `Expected explicit --playbook-path validate to succeed, got ${explicit.code}.`);
  assert(
    explicit.stdout.includes('Resolved manifest is valid'),
    `Expected explicit --playbook-path output to include validation banner, got:\n${explicit.stdout}\n${explicit.stderr}`,
  );

  const envVar = await runValidate(cliPath, repoRoot, {
    LIFELINE_PLAYBOOK_PATH: playbookPath,
  });
  assert(envVar.code === 0, `Expected env-var validate to succeed, got ${envVar.code}.`);
  assert(
    envVar.stdout.includes('Resolved manifest is valid'),
    `Expected env-var output to include validation banner, got:\n${envVar.stdout}\n${envVar.stderr}`,
  );

  const explicitPlaybookLine = pickSemanticLines(explicit.stdout).find((line) => line.startsWith('- playbook:'));
  const envPlaybookLine = pickSemanticLines(envVar.stdout).find((line) => line.startsWith('- playbook:'));

  assert(explicitPlaybookLine, `Expected explicit output to include resolved playbook line, got:\n${explicit.stdout}`);
  assert(envPlaybookLine, `Expected env-var output to include resolved playbook line, got:\n${envVar.stdout}`);
  assert(
    explicitPlaybookLine.includes(expectedPlaybookAbs),
    `Expected explicit playbook line to include resolved absolute path ${expectedPlaybookAbs}, got: ${explicitPlaybookLine}`,
  );
  assert(
    envPlaybookLine.includes(expectedPlaybookAbs),
    `Expected env-var playbook line to include resolved absolute path ${expectedPlaybookAbs}, got: ${envPlaybookLine}`,
  );

  const explicitSemantics = pickSemanticLines(explicit.stdout);
  const envSemantics = pickSemanticLines(envVar.stdout);

  assert(
    JSON.stringify(explicitSemantics) === JSON.stringify(envSemantics),
    [
      'Expected env-var and explicit --playbook-path validation semantics to match.',
      `explicit: ${JSON.stringify(explicitSemantics, null, 2)}`,
      `env-var: ${JSON.stringify(envSemantics, null, 2)}`,
    ].join('\n'),
  );

  console.log('Deterministic validate playbook env-path verification passed.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Deterministic validate playbook env-path verification failed: ${message}`);
  process.exitCode = 1;
});
