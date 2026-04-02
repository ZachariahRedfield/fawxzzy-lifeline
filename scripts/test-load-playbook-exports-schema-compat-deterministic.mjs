import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const {
  CANONICAL_PLAYBOOK_EXPORT_FAMILY,
  LEGACY_PLAYBOOK_EXPORT_FAMILY,
  loadPlaybookExports,
} = await import("../dist/core/load-playbook-exports.js");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function createPlaybookWithSchema(tempRoot, name, schemaJson) {
  const playbookPath = path.join(tempRoot, name);
  const exportPath = path.join(playbookPath, "exports", "lifeline");
  await mkdir(exportPath, { recursive: true });
  await writeFile(
    path.join(exportPath, "schema-version.json"),
    JSON.stringify(schemaJson, null, 2),
    "utf8",
  );
  return playbookPath;
}

async function expectSuccess(name, playbookPath, expectedFamily) {
  const result = await loadPlaybookExports(playbookPath);

  assert(
    result.schemaVersion === 1,
    `${name}: expected schemaVersion 1, received ${result.schemaVersion}`,
  );
  assert(
    result.exportFamily === expectedFamily,
    `${name}: expected exportFamily ${expectedFamily}, received ${result.exportFamily}`,
  );
}

async function expectFailure(name, playbookPath, expectedMessageFragment) {
  try {
    await loadPlaybookExports(playbookPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(
      message.includes(expectedMessageFragment),
      `${name}: expected error message to include "${expectedMessageFragment}", received:\n${message}`,
    );
    return;
  }

  throw new Error(`${name}: expected loadPlaybookExports to fail`);
}

const tempRoot = await mkdtemp(
  path.join(os.tmpdir(), "lifeline-load-playbook-schema-compat-"),
);

try {
  const canonicalPlaybookPath = await createPlaybookWithSchema(
    tempRoot,
    "canonical-family",
    { schemaVersion: 1, exportFamily: CANONICAL_PLAYBOOK_EXPORT_FAMILY },
  );

  await expectSuccess(
    "canonical schema + canonical export family",
    canonicalPlaybookPath,
    CANONICAL_PLAYBOOK_EXPORT_FAMILY,
  );

  const compatibilityPlaybookPath = await createPlaybookWithSchema(
    tempRoot,
    "compatibility-family",
    { schemaVersion: 1, exportFamily: LEGACY_PLAYBOOK_EXPORT_FAMILY },
  );

  await expectSuccess(
    "canonical schema + compatibility export family",
    compatibilityPlaybookPath,
    CANONICAL_PLAYBOOK_EXPORT_FAMILY,
  );

  const legacySchemaPlaybookPath = await createPlaybookWithSchema(
    tempRoot,
    "legacy-version-field",
    { version: 1 },
  );

  await expectSuccess(
    "legacy version field",
    legacySchemaPlaybookPath,
    CANONICAL_PLAYBOOK_EXPORT_FAMILY,
  );

  const invalidShapePlaybookPath = await createPlaybookWithSchema(
    tempRoot,
    "invalid-non-object-shape",
    [1, 2, 3],
  );

  await expectFailure(
    "invalid non-object schema JSON",
    invalidShapePlaybookPath,
    "Expected a JSON object",
  );

  const unsupportedFamilyPlaybookPath = await createPlaybookWithSchema(
    tempRoot,
    "unsupported-export-family",
    { schemaVersion: 1, exportFamily: "not-a-real-family" },
  );

  await expectFailure(
    "unsupported export family",
    unsupportedFamilyPlaybookPath,
    "Unsupported Playbook export family",
  );

  const unsupportedVersionPlaybookPath = await createPlaybookWithSchema(
    tempRoot,
    "unsupported-schema-version",
    { schemaVersion: 2, exportFamily: CANONICAL_PLAYBOOK_EXPORT_FAMILY },
  );

  await expectFailure(
    "unsupported schema version",
    unsupportedVersionPlaybookPath,
    "Unsupported Playbook schema version",
  );

  console.log(
    "loadPlaybookExports schema compatibility deterministic verification passed.",
  );
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
