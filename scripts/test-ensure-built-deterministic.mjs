import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function runEnsureBuiltScript(cwd) {
  const scriptPath = path.join(cwd, 'scripts', 'lib', 'ensure-built.mjs');

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath], { cwd });
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

const sourceEnsureBuiltPath = path.join(process.cwd(), 'scripts', 'lib', 'ensure-built.mjs');
const sourceEnsureBuilt = await readFile(sourceEnsureBuiltPath, 'utf8');

const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'lifeline-ensure-built-'));
const tempScriptsLibDir = path.join(tempRoot, 'scripts', 'lib');
const tempDistDir = path.join(tempRoot, 'dist');
const tempSrcDir = path.join(tempRoot, 'src');

await mkdir(tempScriptsLibDir, { recursive: true });
await mkdir(tempDistDir, { recursive: true });
await mkdir(tempSrcDir, { recursive: true });

await writeFile(path.join(tempScriptsLibDir, 'ensure-built.mjs'), sourceEnsureBuilt, 'utf8');
await writeFile(path.join(tempSrcDir, 'main.ts'), 'export const marker = 1;\n', 'utf8');

try {
  const missingBuild = await runEnsureBuiltScript(tempRoot);
  assert(missingBuild.code === 1, `missing dist/cli.js: expected code 1, got ${missingBuild.code}`);
  assert(
    missingBuild.stderr.includes('Missing dist/cli.js.'),
    `missing dist/cli.js: expected missing-build text, got ${JSON.stringify(missingBuild.stderr)}`,
  );

  const cliPath = path.join(tempDistDir, 'cli.js');
  const sourcePath = path.join(tempSrcDir, 'main.ts');
  await writeFile(cliPath, 'console.log("cli");\n', 'utf8');

  const staleBase = new Date('2026-01-01T00:00:00.000Z');
  const sourceNewer = new Date('2026-01-01T00:00:10.000Z');
  await utimes(cliPath, staleBase, staleBase);
  await utimes(sourcePath, sourceNewer, sourceNewer);

  const staleBuild = await runEnsureBuiltScript(tempRoot);
  assert(staleBuild.code === 1, `stale dist/cli.js: expected code 1, got ${staleBuild.code}`);
  assert(
    staleBuild.stderr.includes('Detected stale build artifacts: dist/cli.js is older than source files in src/.'),
    `stale dist/cli.js: expected stale-build text, got ${JSON.stringify(staleBuild.stderr)}`,
  );

  const cliNewer = new Date('2026-01-01T00:00:20.000Z');
  await utimes(cliPath, cliNewer, cliNewer);

  const upToDateBuild = await runEnsureBuiltScript(tempRoot);
  assert(upToDateBuild.code === 0, `up-to-date dist/cli.js: expected code 0, got ${upToDateBuild.code}`);
  assert(
    upToDateBuild.stderr.includes('[smoke preflight] OK: dist/cli.js is present and up to date.'),
    `up-to-date dist/cli.js: expected OK banner, got ${JSON.stringify(upToDateBuild.stderr)}`,
  );

  console.log('Ensure-built deterministic verification passed.');
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
