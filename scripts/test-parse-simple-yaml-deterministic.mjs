import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

async function transpileSourceToTemp(tsRelativePath, outRoot) {
  const sourcePath = fileURLToPath(new URL(`../${tsRelativePath}`, import.meta.url));
  const source = await readFile(sourcePath, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
  });

  const outputPath = path.join(
    outRoot,
    tsRelativePath.replace(/^src\//, "").replace(/\.ts$/, ".js"),
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result.outputText, "utf8");

  return outputPath;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertDeepEqual(actual, expected, label) {
  const actualSerialized = JSON.stringify(actual);
  const expectedSerialized = JSON.stringify(expected);
  if (actualSerialized !== expectedSerialized) {
    throw new Error(
      `${label} did not match.\nExpected: ${expectedSerialized}\nActual:   ${actualSerialized}`,
    );
  }
}

function assertThrowsManifestLoadError(parseSimpleYaml, ManifestLoadError, source, messagePrefix) {
  try {
    parseSimpleYaml(source);
  } catch (error) {
    assert(
      error instanceof ManifestLoadError,
      `Expected ManifestLoadError, received ${error instanceof Error ? error.name : typeof error}`,
    );

    assert(
      error.message.startsWith(messagePrefix),
      `Expected ManifestLoadError message prefix \"${messagePrefix}\", received \"${error.message}\"`,
    );

    return;
  }

  throw new Error(`Expected parseSimpleYaml to throw \"${messagePrefix}\".`);
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-parse-simple-yaml-"));

try {
  await transpileSourceToTemp("src/core/errors.ts", tempRoot);
  const loadManifestPath = await transpileSourceToTemp(
    "src/core/load-manifest.ts",
    tempRoot,
  );

  const { parseSimpleYaml } = await import(pathToFileURL(loadManifestPath).href);
  const { ManifestLoadError } = await import(
    pathToFileURL(path.join(path.dirname(loadManifestPath), "errors.js")).href
  );

  const commentAndScalarFixture = [
    "plain: alpha # comment should be stripped",
    'quotedHash: "alpha # should stay" # trailing comment removed',
    "singleQuotedHash: 'beta # should stay' # trailing comment removed",
    "count: 42",
    "emptyList: []",
  ].join("\n");

  const parsedScalars = parseSimpleYaml(commentAndScalarFixture);
  assertDeepEqual(
    parsedScalars,
    {
      plain: "alpha",
      quotedHash: "alpha # should stay",
      singleQuotedHash: "beta # should stay",
      count: 42,
      emptyList: [],
    },
    "Scalar/comment fixture",
  );

  const nestedFixture = [
    "root:",
    "  profile:",
    "    name: lifeline",
    "    ports:",
    "      - 3000",
    "      - 3001",
    "    metadata:",
    "      tags:",
    "        - stable",
    "        - canary",
    "  enabled: 1",
  ].join("\n");

  const parsedNested = parseSimpleYaml(nestedFixture);
  assertDeepEqual(
    parsedNested,
    {
      root: {
        profile: {
          name: "lifeline",
          ports: [3000, 3001],
          metadata: {
            tags: ["stable", "canary"],
          },
        },
        enabled: 1,
      },
    },
    "Nested object/list fixture",
  );

  assertThrowsManifestLoadError(
    parseSimpleYaml,
    ManifestLoadError,
    "- orphan",
    "List item without list parent near line",
  );
  assertThrowsManifestLoadError(
    parseSimpleYaml,
    ManifestLoadError,
    "just-text",
    "Expected key/value pair near line",
  );

  console.log("parseSimpleYaml deterministic verification passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
