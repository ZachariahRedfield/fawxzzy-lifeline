import { spawn } from 'node:child_process';
import process from 'node:process';

const cli = ['node', 'dist/cli.js'];
const manifestPath = 'fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml';
const appName = 'runtime-smoke-app';

function run(args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli[0], [...cli.slice(1), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0 && !allowFailure) {
        reject(new Error(`Command failed: ${args.join(' ')}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function cleanup() {
  await run(['down', appName], { allowFailure: true });
}

try {
  await cleanup();
  await run(['up', manifestPath]);

  const status = await run(['status', appName]);
  if (!status.stdout.includes('is running')) {
    throw new Error(`Expected running status, got:\n${status.stdout}\n${status.stderr}`);
  }

  const logs = await run(['logs', appName, '20']);
  if (!logs.stdout.includes('runtime-smoke-app listening on 4310')) {
    throw new Error(`Expected runtime log line, got:\n${logs.stdout}\n${logs.stderr}`);
  }

  await run(['restart', appName]);

  const statusAfterRestart = await run(['status', appName]);
  if (!statusAfterRestart.stdout.includes('is running')) {
    throw new Error(`Expected running status after restart, got:\n${statusAfterRestart.stdout}\n${statusAfterRestart.stderr}`);
  }

  await run(['down', appName]);
} catch (error) {
  await cleanup();
  throw error;
}
