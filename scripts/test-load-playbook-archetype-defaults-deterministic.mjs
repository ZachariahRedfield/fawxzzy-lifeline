import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const { loadPlaybookArchetypeDefaults } = await import(
  "../dist/core/load-playbook-exports.js"
);
const { ManifestLoadError, ValidationError } = await import("../dist/core/errors.js");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function makePlaybook(tempRoot, name) {
  const playbookPath = path.join(tempRoot, name);
  const exportPath = path.join(playbookPath, "exports", "lifeline");
  await mkdir(path.join(exportPath, "archetypes"), { recursive: true });
  await writeFile(
    path.join(exportPath, "schema-version.json"),
    JSON.stringify({ schemaVersion: 1, exportFamily: "lifeline-archetypes" }, null, 2),
    "utf8",
  );
  return playbookPath;
}

async function expectExpectedError(
  name,
  callback,
  expectedCtor,
  expectedMessageFragment,
  expectedCode,
) {
  try {
    await callback();
  } catch (error) {
    assert(
      error instanceof expectedCtor,
      `${name}: expected ${expectedCtor.name}, received ${error instanceof Error ? error.name : String(error)}`,
    );
    assert(
      error.message.includes(expectedMessageFragment),
      `${name}: expected error message to include "${expectedMessageFragment}", received:\n${error.message}`,
    );
    if (expectedCode) {
      assert(
        error.code === expectedCode,
        `${name}: expected error code ${expectedCode}, received ${error.code}`,
      );
    }
    return;
  }

  throw new Error(`${name}: expected callback to throw ${expectedCtor.name}`);
}

const tempRoot = await mkdtemp(
  path.join(os.tmpdir(), "lifeline-load-playbook-archetype-defaults-"),
);

try {
  const validPlaybook = await makePlaybook(tempRoot, "valid-playbook");
  await writeFile(
    path.join(validPlaybook, "exports", "lifeline", "archetypes", "node-web.yml"),
    [
      "installCommand: pnpm install",
      "buildCommand: pnpm build",
      "startCommand: pnpm start",
      "port: 4020",
      "healthcheckPath: /ready",
      "env:",
      "  mode: inline",
      "  requiredKeys:",
      "    - API_TOKEN",
      "deploy:",
      "  strategy: restart",
      "  workingDirectory: /srv/app",
    ].join("\n"),
    "utf8",
  );

  const validDefaults = await loadPlaybookArchetypeDefaults(validPlaybook, "node-web");

  assert(validDefaults.installCommand === "pnpm install", "valid defaults: installCommand mismatch");
  assert(validDefaults.port === 4020, `valid defaults: expected port 4020, got ${validDefaults.port}`);
  assert(validDefaults.env?.requiredKeys?.[0] === "API_TOKEN", "valid defaults: env.requiredKeys mismatch");
  assert(validDefaults.deploy?.workingDirectory === "/srv/app", "valid defaults: deploy.workingDirectory mismatch");

  const missingArchetypePlaybook = await makePlaybook(tempRoot, "missing-archetype");
  await expectExpectedError(
    "missing archetype export",
    () => loadPlaybookArchetypeDefaults(missingArchetypePlaybook, "node-web"),
    ValidationError,
    "Playbook archetype export is missing for node-web",
    "VALIDATION_ERROR",
  );

  const nonObjectYamlPlaybook = await makePlaybook(tempRoot, "non-object-yaml");
  await writeFile(
    path.join(nonObjectYamlPlaybook, "exports", "lifeline", "archetypes", "node-web.yml"),
    "- not-an-object\n",
    "utf8",
  );

  await expectExpectedError(
    "non-object archetype yaml",
    () => loadPlaybookArchetypeDefaults(nonObjectYamlPlaybook, "node-web"),
    ManifestLoadError,
    "List item without list parent near line 1",
    "MANIFEST_LOAD_ERROR",
  );

  const invalidShapePlaybook = await makePlaybook(tempRoot, "invalid-shape");
  await writeFile(
    path.join(invalidShapePlaybook, "exports", "lifeline", "archetypes", "node-web.yml"),
    ["installCommand: 42", "deploy:", "  strategy: nope"].join("\n"),
    "utf8",
  );

  await expectExpectedError(
    "invalid defaults shape",
    () => loadPlaybookArchetypeDefaults(invalidShapePlaybook, "node-web"),
    ValidationError,
    "Playbook export shape is invalid",
    "VALIDATION_ERROR",
  );

  console.log("loadPlaybookArchetypeDefaults deterministic verification passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
