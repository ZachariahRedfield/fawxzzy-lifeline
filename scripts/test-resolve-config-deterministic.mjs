import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const { resolveManifestConfig } = await import("../dist/core/resolve-config.js");
const { ValidationError } = await import("../dist/core/errors.js");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function writePlaybookArchetype(playbookPath, archetype, yamlContent) {
  const exportPath = path.join(playbookPath, "exports", "lifeline");
  const archetypeDir = path.join(exportPath, "archetypes");
  await mkdir(archetypeDir, { recursive: true });

  await writeFile(
    path.join(exportPath, "schema-version.json"),
    JSON.stringify({ schemaVersion: 1, exportFamily: "lifeline-archetypes" }, null, 2),
    "utf8",
  );
  await writeFile(path.join(archetypeDir, `${archetype}.yml`), yamlContent, "utf8");
}

async function expectValidationError(name, callback, expectedMessageFragment) {
  try {
    await callback();
  } catch (error) {
    assert(
      error instanceof ValidationError,
      `${name}: expected ValidationError, received ${error instanceof Error ? error.name : String(error)}`,
    );

    assert(
      error.code === "VALIDATION_ERROR",
      `${name}: expected VALIDATION_ERROR code, received ${error.code}`,
    );

    if (expectedMessageFragment) {
      assert(
        error.message.includes(expectedMessageFragment),
        `${name}: expected error message to include "${expectedMessageFragment}", received:\n${error.message}`,
      );
    }

    return;
  }

  throw new Error(`${name}: expected callback to throw ValidationError.`);
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-resolve-config-deterministic-"));

try {
  const playbookPath = path.join(tempRoot, "playbook");
  await writePlaybookArchetype(
    playbookPath,
    "node-web",
    [
      "installCommand: pnpm install --frozen-lockfile",
      "buildCommand: pnpm build:defaults",
      "startCommand: node server-default.js",
      "port: 4001",
      "healthcheckPath: /alive",
      "env:",
      "  mode: inline",
      "  requiredKeys:",
      "    - FROM_DEFAULTS",
      "deploy:",
      "  strategy: rebuild",
      "  workingDirectory: /opt/default-workdir",
    ].join("\n"),
  );

  const mergedManifestPath = path.join(tempRoot, "merged-manifest.yml");
  await writeFile(
    mergedManifestPath,
    [
      "name: deterministic-merge-app",
      "archetype: node-web",
      "repo: https://example.com/repo.git",
      "branch: main",
      "buildCommand: pnpm build:manifest",
      "port: 5050",
      "env:",
      "  requiredKeys:",
      "    - FROM_MANIFEST",
      "deploy:",
      "  strategy: restart",
      "runtime:",
      "  restorable: false",
    ].join("\n"),
    "utf8",
  );

  const mergedResult = await resolveManifestConfig({
    manifestPath: mergedManifestPath,
    playbookPath,
  });

  assert(mergedResult.usedPlaybookDefaults, "expected usedPlaybookDefaults=true when playbook path is provided");
  assert(mergedResult.playbookPath === path.resolve(playbookPath), "expected playbookPath to be the absolute resolved path");

  assert(
    mergedResult.resolvedManifest.installCommand === "pnpm install --frozen-lockfile",
    `expected Playbook installCommand default to be used, received ${mergedResult.resolvedManifest.installCommand}`,
  );
  assert(
    mergedResult.resolvedManifest.buildCommand === "pnpm build:manifest",
    `expected manifest buildCommand override to win, received ${mergedResult.resolvedManifest.buildCommand}`,
  );
  assert(
    mergedResult.resolvedManifest.env.requiredKeys.length === 1 &&
      mergedResult.resolvedManifest.env.requiredKeys[0] === "FROM_MANIFEST",
    `expected env.requiredKeys from manifest to override defaults, received ${JSON.stringify(mergedResult.resolvedManifest.env.requiredKeys)}`,
  );
  assert(
    mergedResult.resolvedManifest.deploy.strategy === "restart",
    `expected deploy.strategy from manifest to override defaults, received ${mergedResult.resolvedManifest.deploy.strategy}`,
  );
  assert(
    mergedResult.resolvedManifest.deploy.workingDirectory === "/opt/default-workdir",
    `expected deploy.workingDirectory from defaults to survive nested merge, received ${mergedResult.resolvedManifest.deploy.workingDirectory}`,
  );
  assert(
    mergedResult.resolvedManifest.runtime.restartPolicy === "on-failure" &&
      mergedResult.resolvedManifest.runtime.restorable === false,
    `expected runtime object to remain valid after merge+validation, received ${JSON.stringify(mergedResult.resolvedManifest.runtime)}`,
  );

  const missingArchetypeManifestPath = path.join(tempRoot, "missing-archetype.yml");
  await writeFile(
    missingArchetypeManifestPath,
    [
      "name: no-archetype",
      "repo: https://example.com/repo.git",
      "branch: main",
    ].join("\n"),
    "utf8",
  );

  await expectValidationError(
    "missing archetype before Playbook defaults",
    () =>
      resolveManifestConfig({
        manifestPath: missingArchetypeManifestPath,
        playbookPath,
      }),
    "must include archetype before Playbook defaults can be loaded",
  );

  const invalidResolvedManifestPath = path.join(tempRoot, "invalid-resolved-manifest.yml");
  await writeFile(
    invalidResolvedManifestPath,
    [
      "name: invalid-resolved",
      "archetype: node-web",
      "repo: https://example.com/repo.git",
      "branch: main",
      "env:",
      "  requiredKeys:",
      "    - STILL_INVALID_BECAUSE_MODE_IS_MISSING_IN_MERGED_RESULT",
    ].join("\n"),
    "utf8",
  );

  await expectValidationError(
    "invalid resolved manifest shape",
    () =>
      resolveManifestConfig({
        manifestPath: invalidResolvedManifestPath,
      }),
    "Resolved config is incomplete or invalid",
  );

  const noPlaybookManifestPath = path.join(tempRoot, "no-playbook.yml");
  await writeFile(
    noPlaybookManifestPath,
    [
      "name: no-playbook",
      "archetype: node-web",
      "repo: https://example.com/repo.git",
      "branch: main",
      "installCommand: pnpm install",
      "buildCommand: pnpm build",
      "startCommand: pnpm start",
      "port: 3000",
      "healthcheckPath: /healthz",
      "env:",
      "  mode: inline",
      "  requiredKeys:",
      "    - ONLY_MANIFEST",
      "deploy:",
      "  strategy: restart",
    ].join("\n"),
    "utf8",
  );

  const noPlaybookResult = await resolveManifestConfig({
    manifestPath: noPlaybookManifestPath,
  });
  assert(
    noPlaybookResult.usedPlaybookDefaults === false,
    "expected usedPlaybookDefaults=false when no playbook path is provided",
  );
  assert(
    noPlaybookResult.playbookPath === undefined,
    `expected playbookPath to be undefined without playbook path, received ${noPlaybookResult.playbookPath}`,
  );

  const fixturePlaybookPath = path.join(tempRoot, "fixture-playbook");
  await cp("fixtures/playbook-export", fixturePlaybookPath, { recursive: true });

  const legacyRequiredManifestPath = path.join(tempRoot, "legacy-required.yml");
  await writeFile(
    legacyRequiredManifestPath,
    [
      "name: legacy-required-keys",
      "archetype: node-web",
      "repo: https://example.com/repo.git",
      "branch: main",
      "installCommand: pnpm install",
      "buildCommand: pnpm build",
      "startCommand: pnpm start",
      "port: 3000",
      "healthcheckPath: /healthz",
      "env:",
      "  mode: inline",
      "  required:",
      "    - LEGACY_KEY",
      "deploy:",
      "  strategy: restart",
    ].join("\n"),
    "utf8",
  );

  const legacyRequiredResult = await resolveManifestConfig({
    manifestPath: legacyRequiredManifestPath,
    playbookPath: fixturePlaybookPath,
  });

  assert(
    legacyRequiredResult.resolvedManifest.env.requiredKeys.length === 1 &&
      legacyRequiredResult.resolvedManifest.env.requiredKeys[0] === "LEGACY_KEY",
    `expected env.required to be normalized into env.requiredKeys during merge, received ${JSON.stringify(legacyRequiredResult.resolvedManifest.env.requiredKeys)}`,
  );

  console.log("resolveManifestConfig deterministic merge + error-path verification passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
