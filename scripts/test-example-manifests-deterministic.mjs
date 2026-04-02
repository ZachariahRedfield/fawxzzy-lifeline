import { mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const repoRoot = process.cwd();
const cliPath = resolve(repoRoot, "dist/cli.js");
const externalCwd = mkdtempSync(resolve(tmpdir(), "lifeline-example-manifest-deterministic-"));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runValidate(manifestPath, cwd = repoRoot) {
  const result = spawnSync("node", [cliPath, "validate", manifestPath], {
    cwd,
    encoding: "utf8",
  });

  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function assertValidateSuccess(result, label) {
  assert(result.status === 0, `${label} validate failed:\n${result.output}`);
}

function assertAll(output, checks) {
  for (const check of checks) {
    assert(output.includes(check), `Missing expected output marker \"${check}\".\n${output}`);
  }
}

const fitnessRelativePath = "examples/fitness-app.lifeline.yml";
const fitnessAbsolutePath = resolve(repoRoot, fitnessRelativePath);

const fitnessRelative = runValidate(fitnessRelativePath, repoRoot);
const fitnessAbsolute = runValidate(fitnessAbsolutePath, externalCwd);

assertValidateSuccess(fitnessRelative, "fitness relative path");
assertValidateSuccess(fitnessAbsolute, "fitness absolute path");

assertAll(fitnessRelative.output, [
  "Fitness mirror manifest is valid",
  "- boundary: fitness manifest mirror",
]);
assertAll(fitnessAbsolute.output, [
  "Fitness mirror manifest is valid",
  "- boundary: fitness manifest mirror",
]);

const playbookRelativePath = "examples/playbook-ui.lifeline.yml";
const playbookAbsolutePath = resolve(repoRoot, playbookRelativePath);

const playbookRelative = runValidate(playbookRelativePath, repoRoot);
const playbookAbsolute = runValidate(playbookAbsolutePath, externalCwd);

assertValidateSuccess(playbookRelative, "playbook-ui relative path");
assertValidateSuccess(playbookAbsolute, "playbook-ui absolute path");

for (const output of [playbookRelative.output, playbookAbsolute.output]) {
  assertAll(output, [
    "Manifest is valid:",
    "- app: playbook-ui",
    "- archetype: next-web",
    "- port: 3100",
  ]);
}

console.log("Example manifest deterministic verification passed.");
