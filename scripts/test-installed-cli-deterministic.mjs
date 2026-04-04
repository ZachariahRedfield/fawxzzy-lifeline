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
const localCliPath = path.join(repoRoot, 'dist', 'cli.js');

const buildResult = await runCommand('pnpm', ['build'], repoRoot);
assert(buildResult.code === 0, `pnpm build failed:\n${buildResult.stdout}\n${buildResult.stderr}`);

const tempPackDir = await mkdtemp(path.join(os.tmpdir(), 'lifeline-pack-install-'));
const tempInstallRoot = await mkdtemp(path.join(os.tmpdir(), 'lifeline-install-workspace-'));
const tempProjectDir = path.join(tempInstallRoot, 'workspace');

await mkdir(tempProjectDir, { recursive: true });
await writeFile(
  path.join(tempProjectDir, 'package.json'),
  JSON.stringify(
    {
      name: 'lifeline-installed-cli-test',
      private: true,
      version: '0.0.0',
    },
    null,
    2,
  ),
  'utf8',
);

const tempManifestPath = path.join(tempProjectDir, 'tiny.lifeline.yml');
await writeFile(
  tempManifestPath,
  [
    'name: tiny-app',
    'archetype: node-web',
    'repo: https://example.invalid/tiny-app.git',
    'branch: main',
    'installCommand: pnpm install --frozen-lockfile',
    'buildCommand: pnpm build',
    'startCommand: pnpm start',
    'port: 4310',
    'healthcheckPath: /healthz',
    'env:',
    '  mode: inline',
    '  values: {}',
    'deploy:',
    '  strategy: rebuild',
    '  workingDirectory: .',
  ].join('\n') + '\n',
  'utf8',
);

try {
  const packResult = await runCommand(
    'pnpm',
    ['pack', '--json', '--pack-destination', tempPackDir],
    repoRoot,
  );
  assert(packResult.code === 0, `pnpm pack failed:\n${packResult.stdout}\n${packResult.stderr}`);

  const packJson = JSON.parse(packResult.stdout);
  const packSummary = Array.isArray(packJson) ? packJson[0] : packJson;
  const tarballName = packSummary?.filename;
  assert(typeof tarballName === 'string' && tarballName.length > 0, 'unable to read packed tarball filename.');
  const tarballPath = path.isAbsolute(tarballName) ? tarballName : path.join(tempPackDir, tarballName);

  const installResult = await runCommand('pnpm', ['add', tarballPath], tempProjectDir);
  assert(installResult.code === 0, `installing packed tarball failed:\n${installResult.stdout}\n${installResult.stderr}`);

  const installedCliPath = path.join(tempProjectDir, 'node_modules', '.bin', 'lifeline');
  const installedHelp = await runCommand(installedCliPath, ['--help'], tempProjectDir);
  const localHelp = await runCommand(process.execPath, [localCliPath, '--help'], repoRoot);

  assert(installedHelp.code === 0, `installed lifeline --help failed:\n${installedHelp.stdout}\n${installedHelp.stderr}`);
  assert(localHelp.code === 0, `local lifeline --help failed:\n${localHelp.stdout}\n${localHelp.stderr}`);
  assert(
    installedHelp.stdout === localHelp.stdout,
    [
      'help output mismatch between installed and local cli',
      `installed: ${JSON.stringify(installedHelp.stdout)}`,
      `local: ${JSON.stringify(localHelp.stdout)}`,
    ].join('\n'),
  );

  const installedValidate = await runCommand(installedCliPath, ['validate', tempManifestPath], tempProjectDir);
  const localValidate = await runCommand(process.execPath, [localCliPath, 'validate', tempManifestPath], repoRoot);

  assert(
    installedValidate.code === 0,
    `installed lifeline validate failed:\n${installedValidate.stdout}\n${installedValidate.stderr}`,
  );
  assert(localValidate.code === 0, `local lifeline validate failed:\n${localValidate.stdout}\n${localValidate.stderr}`);

  assert(
    installedValidate.stdout === localValidate.stdout,
    [
      'validate stdout mismatch between installed and local cli',
      `installed: ${JSON.stringify(installedValidate.stdout)}`,
      `local: ${JSON.stringify(localValidate.stdout)}`,
    ].join('\n'),
  );
  assert(
    installedValidate.stderr === localValidate.stderr,
    [
      'validate stderr mismatch between installed and local cli',
      `installed: ${JSON.stringify(installedValidate.stderr)}`,
      `local: ${JSON.stringify(localValidate.stderr)}`,
    ].join('\n'),
  );

  const localPackageJson = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));
  const installedPackageJson = JSON.parse(
    await readFile(path.join(tempProjectDir, 'node_modules', localPackageJson.name, 'package.json'), 'utf8'),
  );
  assert(
    installedPackageJson.bin?.lifeline === localPackageJson.bin?.lifeline,
    `installed bin contract drifted: local=${JSON.stringify(localPackageJson.bin)} installed=${JSON.stringify(installedPackageJson.bin)}`,
  );

  console.log('Installed CLI deterministic verification passed.');
} finally {
  await rm(tempPackDir, { recursive: true, force: true });
  await rm(tempInstallRoot, { recursive: true, force: true });
}
