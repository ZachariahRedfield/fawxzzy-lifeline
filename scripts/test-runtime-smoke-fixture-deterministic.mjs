import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const repoRoot = process.cwd();
const cliPath = resolve(repoRoot, "dist/cli.js");
const fixtureManifestPath = "fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml";
const fixturePlaybookManifestPath = "fixtures/runtime-smoke-app/runtime-smoke-app.playbook.lifeline.yml";
const fixtureDir = resolve(repoRoot, "fixtures/runtime-smoke-app");
const playbookPath = "fixtures/playbook-export";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runCli(args) {
  const result = spawnSync("node", [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function assertSuccess(result, label) {
  assert(result.status === 0, `${label} failed.\n${result.output}`);
}

function assertContainsAll(output, markers) {
  for (const marker of markers) {
    assert(output.includes(marker), `Expected output marker \"${marker}\".\n${output}`);
  }
}

const validateFixtureRelative = runCli(["validate", fixtureManifestPath]);
const validateFixtureAbsolute = runCli(["validate", resolve(repoRoot, fixtureManifestPath)]);
assertSuccess(validateFixtureRelative, "runtime smoke fixture relative validate");
assertSuccess(validateFixtureAbsolute, "runtime smoke fixture absolute validate");
assertContainsAll(validateFixtureRelative.stdout, ["Manifest is valid:", "- app: runtime-smoke-app", "- port: 5322"]);
assertContainsAll(validateFixtureAbsolute.stdout, ["Manifest is valid:", "- app: runtime-smoke-app", "- port: 5322"]);

const resolvedFixtureResult = runCli(["resolve", fixtureManifestPath]);
assertSuccess(resolvedFixtureResult, "runtime smoke fixture resolve");
const resolvedFixture = JSON.parse(resolvedFixtureResult.stdout);

assert(resolvedFixture.name === "runtime-smoke-app", `Unexpected fixture app name: ${resolvedFixture.name}`);
assert(resolvedFixture.archetype === "node-web", `Unexpected fixture archetype: ${resolvedFixture.archetype}`);
assert(resolvedFixture.startCommand === "node server.js", `Unexpected startCommand: ${resolvedFixture.startCommand}`);
assert(resolvedFixture.port === 5322, `Unexpected fixture port: ${resolvedFixture.port}`);
assert(resolvedFixture.healthcheckPath === "/healthz", `Unexpected healthcheckPath: ${resolvedFixture.healthcheckPath}`);
assert(resolvedFixture.env?.mode === "file", `Expected env.mode=file, got ${resolvedFixture.env?.mode}`);
assert(resolvedFixture.env?.file === ".env.runtime", `Expected env.file=.env.runtime, got ${resolvedFixture.env?.file}`);
assert(
  JSON.stringify(resolvedFixture.env?.requiredKeys) === JSON.stringify(["PORT", "SMOKE_TOKEN"]),
  `Expected required env keys PORT/SMOKE_TOKEN, got ${JSON.stringify(resolvedFixture.env?.requiredKeys)}`,
);
assert(
  resolvedFixture.deploy?.workingDirectory === ".",
  `Expected deploy.workingDirectory='.', got ${resolvedFixture.deploy?.workingDirectory}`,
);
assert(
  resolvedFixture.runtime?.restartPolicy === "on-failure",
  `Expected runtime.restartPolicy=on-failure, got ${resolvedFixture.runtime?.restartPolicy}`,
);
assert(
  resolvedFixture.runtime?.restorable === true,
  `Expected runtime.restorable=true, got ${resolvedFixture.runtime?.restorable}`,
);

const envPath = resolve(fixtureDir, resolvedFixture.env.file);
assert(existsSync(envPath), `Expected fixture env file to exist: ${envPath}`);

const resolvedWorkingDir = resolve(fixtureDir, resolvedFixture.deploy.workingDirectory);
assert(existsSync(resolvedWorkingDir), `Expected resolved workingDirectory to exist: ${resolvedWorkingDir}`);
assert(existsSync(resolve(resolvedWorkingDir, "server.js")), "Expected server.js to exist in resolved workingDirectory.");

const validatePlaybookFixtureRelative = runCli([
  "validate",
  fixturePlaybookManifestPath,
  "--playbook-path",
  playbookPath,
]);
const validatePlaybookFixtureAbsolute = runCli([
  "validate",
  resolve(repoRoot, fixturePlaybookManifestPath),
  "--playbook-path",
  resolve(repoRoot, playbookPath),
]);
assertSuccess(validatePlaybookFixtureRelative, "runtime playbook fixture relative validate");
assertSuccess(validatePlaybookFixtureAbsolute, "runtime playbook fixture absolute validate");
assertContainsAll(validatePlaybookFixtureRelative.stdout, ["Resolved manifest is valid:", "- app: runtime-smoke-app", "- port: 4387"]);
assertContainsAll(validatePlaybookFixtureAbsolute.stdout, ["Resolved manifest is valid:", "- app: runtime-smoke-app", "- port: 4387"]);

const resolvedPlaybookFixtureResult = runCli([
  "resolve",
  fixturePlaybookManifestPath,
  "--playbook-path",
  playbookPath,
]);
assertSuccess(resolvedPlaybookFixtureResult, "runtime playbook fixture resolve");

const resolvedPlaybookFixture = JSON.parse(resolvedPlaybookFixtureResult.stdout);
assert(resolvedPlaybookFixture.name === "runtime-smoke-app", `Unexpected playbook app name: ${resolvedPlaybookFixture.name}`);
assert(resolvedPlaybookFixture.archetype === "node-web", `Unexpected playbook archetype: ${resolvedPlaybookFixture.archetype}`);
assert(resolvedPlaybookFixture.startCommand === "node server.js", `Unexpected playbook startCommand: ${resolvedPlaybookFixture.startCommand}`);
assert(resolvedPlaybookFixture.port === 4387, `Unexpected playbook fixture port: ${resolvedPlaybookFixture.port}`);
assert(
  resolvedPlaybookFixture.env?.file === ".env.runtime",
  `Expected playbook env.file=.env.runtime, got ${resolvedPlaybookFixture.env?.file}`,
);
assert(Array.isArray(resolvedPlaybookFixture.env?.requiredKeys), "Expected playbook env.requiredKeys to be present as an array.");
assert(
  resolvedPlaybookFixture.deploy?.workingDirectory === ".",
  `Expected playbook deploy.workingDirectory='.', got ${resolvedPlaybookFixture.deploy?.workingDirectory}`,
);
assert(
  resolvedPlaybookFixture.runtime?.restartPolicy === "on-failure",
  `Expected playbook runtime.restartPolicy=on-failure, got ${resolvedPlaybookFixture.runtime?.restartPolicy}`,
);
assert(
  resolvedPlaybookFixture.runtime?.restorable === true,
  `Expected playbook runtime.restorable=true, got ${resolvedPlaybookFixture.runtime?.restorable}`,
);

const playbookEnvPath = resolve(fixtureDir, resolvedPlaybookFixture.env.file);
assert(existsSync(playbookEnvPath), `Expected playbook fixture env file to exist: ${playbookEnvPath}`);
const playbookWorkingDir = resolve(fixtureDir, resolvedPlaybookFixture.deploy.workingDirectory);
assert(existsSync(playbookWorkingDir), `Expected playbook resolved workingDirectory to exist: ${playbookWorkingDir}`);

console.log("Runtime smoke fixture deterministic verification passed.");
