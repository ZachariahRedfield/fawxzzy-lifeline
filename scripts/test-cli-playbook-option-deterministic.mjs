import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ensureBuilt } from './lib/ensure-built.mjs';

const execFileAsync = promisify(execFile);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function runCli(args) {
  const cliPath = './dist/cli.js';

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
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

await ensureBuilt();

const beforePositional = await runCli(['down', '--playbook-path', '/tmp/example-playbook', 'demo-app']);
assert(
  beforePositional.code === 1,
  `--playbook-path before positional: expected exit code 1, got ${beforePositional.code}`,
);
assert(
  beforePositional.stderr.includes('No runtime state found for app demo-app.'),
  `--playbook-path before positional: expected command routing to keep target as app name, got ${JSON.stringify(beforePositional.stderr)}`,
);

const afterPositional = await runCli(['down', 'demo-app', '--playbook-path', '/tmp/example-playbook']);
assert(
  afterPositional.code === 1,
  `--playbook-path after positional: expected exit code 1, got ${afterPositional.code}`,
);
assert(
  afterPositional.stderr.includes('No runtime state found for app demo-app.'),
  `--playbook-path after positional: expected command routing to keep target as app name, got ${JSON.stringify(afterPositional.stderr)}`,
);

const missingPlaybookValue = await runCli(['down', 'demo-app', '--playbook-path']);
assert(
  missingPlaybookValue.code === 1,
  `missing playbook value: expected exit code 1, got ${missingPlaybookValue.code}`,
);
assert(
  missingPlaybookValue.stderr.includes('Missing value for --playbook-path.'),
  `missing playbook value: expected error message, got ${JSON.stringify(missingPlaybookValue.stderr)}`,
);

const optionNotPositional = await runCli(['down', '--playbook-path', '/tmp/example-playbook']);
assert(
  optionNotPositional.code === 1,
  `option not positional: expected exit code 1, got ${optionNotPositional.code}`,
);
assert(
  optionNotPositional.stderr.includes('Missing app name.'),
  `option not positional: expected missing app error, got ${JSON.stringify(optionNotPositional.stderr)}`,
);
assert(
  optionNotPositional.stdout.includes('Usage:'),
  `option not positional: expected usage output, got ${JSON.stringify(optionNotPositional.stdout)}`,
);

console.log('CLI --playbook-path option deterministic verification passed.');
