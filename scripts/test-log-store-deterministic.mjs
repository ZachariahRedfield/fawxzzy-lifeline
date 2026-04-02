import assert from "node:assert/strict";
import { access, appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import typescript from "typescript";

async function transpileLogStoreModule(transpileRoot) {
  const sourcePath = path.join("src", "core", "log-store.ts");
  const source = await readFile(sourcePath, "utf8");
  const transpiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.ES2022,
      target: typescript.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
  });

  const destinationPath = path.join(transpileRoot, "core", "log-store.js");
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, transpiled.outputText, "utf8");
  return destinationPath;
}

const originalCwd = process.cwd();
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-log-store-"));
const transpileRoot = await mkdtemp(
  path.join(os.tmpdir(), "lifeline-log-store-transpile-"),
);

try {
  const modulePath = await transpileLogStoreModule(transpileRoot);

  process.chdir(tempRoot);
  const { ensureLogDirectory, getLogPath, appendLogHeader, tailLogFile } =
    await import(pathToFileURL(modulePath).href);

  const logsDir = path.join(tempRoot, ".lifeline", "logs");

  await assert.rejects(access(logsDir));

  const ensuredLogsDir = await ensureLogDirectory();
  assert.equal(ensuredLogsDir, logsDir);

  const directoryStats = await stat(ensuredLogsDir);
  assert.equal(directoryStats.isDirectory(), true);

  const appName = "deterministic-log-helper";
  const logPath = await getLogPath(appName);
  assert.equal(logPath, path.join(logsDir, `${appName}.log`));

  await appendLogHeader(logPath, "[alpha] first");
  await appendLogHeader(logPath, "[beta] second");
  await appendFile(logPath, "\n", "utf8");

  const rawLog = await readFile(logPath, "utf8");
  assert.equal(rawLog, "[alpha] first\n[beta] second\n\n");

  const tailOne = await tailLogFile(logPath, 1);
  assert.deepEqual(tailOne, ["[beta] second"]);

  const tailAllNonEmpty = await tailLogFile(logPath, 10);
  assert.deepEqual(tailAllNonEmpty, ["[alpha] first", "[beta] second"]);

  const missing = await tailLogFile(path.join(logsDir, "missing.log"), 5);
  assert.deepEqual(missing, []);

  console.log("log-store deterministic verification passed.");
} finally {
  process.chdir(originalCwd);
  await rm(tempRoot, { recursive: true, force: true });
  await rm(transpileRoot, { recursive: true, force: true });
}
