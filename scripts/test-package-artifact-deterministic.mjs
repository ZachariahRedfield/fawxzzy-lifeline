import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function runCommand(command, args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      env: process.env,
    });
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

const repoRoot = process.cwd();
const packageJsonPath = path.join(repoRoot, 'package.json');
const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
const packageName = packageJson.name;
const packageVersion = packageJson.version;

const buildResult = await runCommand('pnpm', ['build'], repoRoot);
assert(buildResult.code === 0, `pnpm build failed:\n${buildResult.stdout}\n${buildResult.stderr}`);

const tempPackDir = await mkdtemp(path.join(os.tmpdir(), 'lifeline-pack-artifact-'));

try {
  const packResult = await runCommand(
    'pnpm',
    ['pack', '--json', '--pack-destination', tempPackDir],
    repoRoot,
  );
  assert(packResult.code === 0, `pnpm pack failed:\n${packResult.stdout}\n${packResult.stderr}`);

  const packJson = JSON.parse(packResult.stdout);
  const packSummary = Array.isArray(packJson) ? packJson[0] : packJson;
  assert(packSummary && typeof packSummary === 'object', 'pnpm pack did not return JSON summary.');

  const tarballName = packSummary.filename;
  assert(typeof tarballName === 'string' && tarballName.length > 0, `invalid tarball filename: ${tarballName}`);

  const tarballPath = path.isAbsolute(tarballName) ? tarballName : path.join(tempPackDir, tarballName);
  const files = Array.isArray(packSummary.files) ? packSummary.files : [];
  const packedPaths = files.map((entry) => entry.path);

  assert(packedPaths.includes('dist/cli.js'), 'packed artifact is missing dist/cli.js.');
  assert(packedPaths.every((packedPath) => !packedPath.startsWith('src/')), 'packed artifact unexpectedly includes src/.');

  const expectedBinPath = 'dist/cli.js';
  assert(
    packageJson.bin && packageJson.bin.lifeline === expectedBinPath,
    `package bin.lifeline mismatch: expected ${expectedBinPath}, got ${JSON.stringify(packageJson.bin)}`,
  );
  assert(
    Array.isArray(packageJson.files) && packageJson.files.includes('dist'),
    `package files must include dist, got ${JSON.stringify(packageJson.files)}`,
  );

  const tarListResult = await runCommand('tar', ['-tf', tarballPath], repoRoot);
  assert(tarListResult.code === 0, `tar -tf failed:\n${tarListResult.stdout}\n${tarListResult.stderr}`);
  assert(
    tarListResult.stdout.includes('package/dist/cli.js'),
    'tarball listing does not include package/dist/cli.js.',
  );

  assert(
    tarballName.includes(packageName.replace('@', '').replace('/', '-')) && tarballName.includes(packageVersion),
    `unexpected tarball naming: ${tarballName} for ${packageName}@${packageVersion}`,
  );

  console.log('Package artifact deterministic verification passed.');
} finally {
  await rm(tempPackDir, { recursive: true, force: true });
}
