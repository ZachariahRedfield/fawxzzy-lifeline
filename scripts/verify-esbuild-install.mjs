import fs from 'node:fs';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const toolchainDeps = {
  ...(packageJson.dependencies ?? {}),
  ...(packageJson.devDependencies ?? {}),
};

const requiresEsbuild =
  'esbuild' in toolchainDeps || 'vite' in toolchainDeps || 'vitest' in toolchainDeps;

if (!requiresEsbuild) {
  console.log('No vite/vitest/esbuild dependency detected; esbuild resolution check skipped.');
  process.exit(0);
}

const { version } = await import('esbuild');

const platform = process.platform;
const arch = process.arch;

if (platform === 'linux' && arch === 'x64') {
  require.resolve('@esbuild/linux-x64');
}

console.log(`esbuild resolved (version ${version}) on ${platform}/${arch}`);
