import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function ensurePathExists(filePath) {
  try {
    await access(filePath);
  } catch {
    throw new Error(`Expected path to exist: ${path.relative(process.cwd(), filePath)}`);
  }
}

function extractCommands(readmeText, prefix) {
  const commands = [];
  const codeBlockPattern = /```bash\n([\s\S]*?)```/g;
  for (const match of readmeText.matchAll(codeBlockPattern)) {
    const block = match[1] ?? '';
    const mergedLines = [];
    let pending = '';

    for (const rawLine of block.split('\n')) {
      const trimmed = rawLine.trim();
      if (!trimmed) {
        continue;
      }

      if (pending) {
        pending = `${pending} ${trimmed}`;
      } else {
        pending = trimmed;
      }

      if (pending.endsWith('\\')) {
        pending = pending.slice(0, -1).trim();
        continue;
      }

      mergedLines.push(pending);
      pending = '';
    }

    if (pending) {
      mergedLines.push(pending);
    }

    for (const line of mergedLines) {
      if (line.startsWith(prefix)) {
        commands.push(line);
      }
    }
  }
  return commands;
}

async function main() {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const readmePath = path.join(repoRoot, 'README.md');
  const readmeText = await readFile(readmePath, 'utf8');
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  const packageScripts = packageJson && typeof packageJson === 'object' ? packageJson.scripts : undefined;

  assert(packageScripts && typeof packageScripts === 'object', 'Expected package.json scripts object.');

  const nodeScriptCommands = extractCommands(readmeText, 'node scripts/');
  assert(nodeScriptCommands.length > 0, 'Expected README node scripts/* command examples.');

  for (const command of nodeScriptCommands) {
    const scriptPath = command.split(/\s+/)[1];
    assert(scriptPath, `Unable to parse script path from command: ${command}`);
    await ensurePathExists(path.join(repoRoot, scriptPath));
  }

  const smokeRunnerExamples = extractCommands(readmeText, 'pnpm smoke:run ');
  assert(smokeRunnerExamples.length > 0, 'Expected README smoke:run command examples.');

  for (const command of smokeRunnerExamples) {
    const [, , mode, scenario] = command.split(/\s+/);
    assert(mode && scenario, `Unable to parse smoke:run mode/scenario from command: ${command}`);
    const scenarioScript = path.join(repoRoot, 'scripts', `smoke-${mode}-${scenario}.mjs`);
    await ensurePathExists(scenarioScript);
  }

  const packageBackedReadmeCommands = [
    'pnpm smoke:runtime',
    'pnpm smoke:playbook',
    'pnpm test:startup-deterministic',
    'pnpm test:startup-roundtrip',
  ];

  for (const command of packageBackedReadmeCommands) {
    if (!readmeText.includes(command)) {
      continue;
    }
    const scriptName = command.replace(/^pnpm\s+/, '');
    assert(
      Object.prototype.hasOwnProperty.call(packageScripts, scriptName),
      `README references missing package script: ${scriptName}`,
    );
    const scriptValue = packageScripts[scriptName];
    assert(typeof scriptValue === 'string', `Package script ${scriptName} must be a string.`);

    const referencedScripts = Array.from(scriptValue.matchAll(/scripts\/[^\s"'`]+\.mjs/g)).map(
      (match) => match[0],
    );
    assert(
      referencedScripts.length > 0,
      `Package script ${scriptName} does not reference any scripts/*.mjs entrypoint.`,
    );

    for (const referencedScript of referencedScripts) {
      await ensurePathExists(path.join(repoRoot, referencedScript));
    }
  }

  console.log('README script reference deterministic verification passed.');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`README script reference deterministic verification failed: ${message}`);
  process.exitCode = 1;
});
