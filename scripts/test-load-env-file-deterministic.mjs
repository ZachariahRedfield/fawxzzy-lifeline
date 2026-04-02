import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import typescript from "typescript";

async function transpileCoreModule(tempRoot, relativePath) {
  const sourcePath = path.join("src", "core", relativePath);
  const source = await readFile(sourcePath, "utf8");
  const transpiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.ES2022,
      target: typescript.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
  });

  const destinationPath = path.join(tempRoot, "core", relativePath.replace(/\.ts$/, ".js"));
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, transpiled.outputText, "utf8");
}

async function loadParserFromSource() {
  const transpileRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-load-env-transpile-"));
  try {
    await Promise.all([
      transpileCoreModule(transpileRoot, "errors.ts"),
      transpileCoreModule(transpileRoot, "load-env-file.ts"),
    ]);

    const moduleUrl = pathToFileURL(path.join(transpileRoot, "core", "load-env-file.js")).href;
    const module = await import(moduleUrl);
    return { loadEnvFile: module.loadEnvFile, transpileRoot };
  } catch (error) {
    await rm(transpileRoot, { recursive: true, force: true });
    throw error;
  }
}

async function expectLoadEnvFailure(loadEnvFile, envPath, expectedMessage) {
  try {
    await loadEnvFile(envPath);
    throw new Error(`Expected loadEnvFile to fail for ${envPath}.`);
  } catch (error) {
    assert.equal(
      error?.message,
      expectedMessage,
      `Expected deterministic failure message for ${envPath}`,
    );
  }
}

const { loadEnvFile, transpileRoot } = await loadParserFromSource();
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-load-env-file-"));

try {
  const successPath = path.join(tempRoot, "success.env");
  await writeFile(
    successPath,
    [
      "",
      "# full-line comment should be ignored",
      "FOO=bar",
      "COMPLEX=value=with=equals",
      "  SPACED =trim-key-only",
      "",
    ].join("\n"),
    "utf8",
  );

  const parsed = await loadEnvFile(successPath);
  assert.deepEqual(parsed, {
    FOO: "bar",
    COMPLEX: "value=with=equals",
    SPACED: "trim-key-only",
  });

  const invalidLinePath = path.join(tempRoot, "invalid-line.env");
  await writeFile(
    invalidLinePath,
    ["# comment", "MALFORMED_LINE_WITHOUT_EQUALS"].join("\n"),
    "utf8",
  );
  await expectLoadEnvFailure(
    loadEnvFile,
    invalidLinePath,
    `Invalid env line 2 in ${invalidLinePath}: expected KEY=VALUE`,
  );

  const missingKeyPath = path.join(tempRoot, "missing-key.env");
  await writeFile(missingKeyPath, "   =value", "utf8");
  await expectLoadEnvFailure(
    loadEnvFile,
    missingKeyPath,
    `Invalid env line 1 in ${missingKeyPath}: missing key`,
  );

  console.log("loadEnvFile deterministic parsing verification passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
  await rm(transpileRoot, { recursive: true, force: true });
}
