import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import typescript from "typescript";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

  const destinationPath = path.join(
    tempRoot,
    "core",
    relativePath.replace(/\.ts$/, ".js"),
  );
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, transpiled.outputText, "utf8");
}

async function loadResolverFromSource() {
  const transpileRoot = await mkdtemp(
    path.join(os.tmpdir(), "lifeline-resolve-workdir-transpile-"),
  );

  try {
    await Promise.all([
      transpileCoreModule(transpileRoot, "errors.ts"),
      transpileCoreModule(transpileRoot, "resolve-working-directory.ts"),
    ]);

    const moduleUrl = pathToFileURL(
      path.join(transpileRoot, "core", "resolve-working-directory.js"),
    ).href;
    const module = await import(moduleUrl);

    return {
      resolveWorkingDirectory: module.resolveWorkingDirectory,
      transpileRoot,
    };
  } catch (error) {
    await rm(transpileRoot, { recursive: true, force: true });
    throw error;
  }
}

function makeManifest(overrides = {}) {
  return {
    name: "deterministic-app",
    deploy: {
      strategy: "rebuild",
      workingDirectory: "./app",
    },
    ...overrides,
  };
}

async function expectValidationFailure(action, expectedMessageParts) {
  try {
    await action();
    throw new Error("Expected ValidationError, but operation succeeded.");
  } catch (error) {
    assert.equal(error?.name, "ValidationError");
    for (const part of expectedMessageParts) {
      assert.match(
        error.message,
        part,
        `ValidationError message did not include expected family: ${String(part)}`,
      );
    }
  }
}

const { resolveWorkingDirectory, transpileRoot } = await loadResolverFromSource();
const tempRoot = await mkdtemp(
  path.join(os.tmpdir(), "lifeline-resolve-working-directory-"),
);
const originalCwd = process.cwd();

try {
  const manifestDir = path.join(tempRoot, "workspace", "manifests");
  const resolvedTargetDir = path.join(manifestDir, "app");
  await mkdir(resolvedTargetDir, { recursive: true });

  const manifestPath = path.join(manifestDir, "app.manifest.yml");

  const unrelatedCwd = path.join(tempRoot, "unrelated-cwd");
  await mkdir(unrelatedCwd, { recursive: true });
  process.chdir(unrelatedCwd);

  const relativeResolved = await resolveWorkingDirectory(
    manifestPath,
    makeManifest({ deploy: { strategy: "rebuild", workingDirectory: "./app" } }),
  );
  assert.equal(
    relativeResolved,
    resolvedTargetDir,
    "Expected relative working directory resolution to be anchored to manifest directory.",
  );
  assert.notEqual(
    relativeResolved,
    path.join(unrelatedCwd, "app"),
    "Expected resolution to ignore caller cwd and use manifest directory.",
  );

  const absoluteResolved = await resolveWorkingDirectory(
    manifestPath,
    makeManifest({
      deploy: { strategy: "rebuild", workingDirectory: resolvedTargetDir },
    }),
  );
  assert.equal(
    absoluteResolved,
    resolvedTargetDir,
    "Expected existing target directory to resolve to exact absolute path.",
  );

  await expectValidationFailure(
    async () =>
      resolveWorkingDirectory(
        manifestPath,
        makeManifest({ deploy: { strategy: "rebuild" } }),
      ),
    [
      /missing deploy\.workingDirectory/i,
      /required for runtime commands/i,
      new RegExp(escapeRegExp(manifestPath)),
    ],
  );

  const missingDirPath = path.join(manifestDir, "missing-dir");
  await expectValidationFailure(
    async () =>
      resolveWorkingDirectory(
        manifestPath,
        makeManifest({
          deploy: { strategy: "rebuild", workingDirectory: "./missing-dir" },
        }),
      ),
    [
      /Working directory for app deterministic-app does not exist:/,
      new RegExp(escapeRegExp(missingDirPath)),
      new RegExp(`\\(from ${escapeRegExp(manifestPath)}\\)\\.`),
    ],
  );

  console.log("resolveWorkingDirectory deterministic verification passed.");
} finally {
  process.chdir(originalCwd);
  await rm(tempRoot, { recursive: true, force: true });
  await rm(transpileRoot, { recursive: true, force: true });
}
