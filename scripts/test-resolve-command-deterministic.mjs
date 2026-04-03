import { spawn } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const plainManifestPath = fileURLToPath(
  new URL("../fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml", import.meta.url),
);
const playbookManifestPath = fileURLToPath(
  new URL("../fixtures/runtime-smoke-app/runtime-smoke-app.playbook.lifeline.yml", import.meta.url),
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalize(text) {
  return text.replace(/\r\n/g, "\n");
}

function runResolve(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, "resolve", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({
        code: code ?? 1,
        stdout: normalize(stdout),
        stderr: normalize(stderr),
      });
    });
  });
}

function expectJsonOnlySuccess(name, result) {
  assert(
    result.code === 0,
    `${name}: expected exit code 0, received ${result.code}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  assert(
    result.stderr.trim().length === 0,
    `${name}: expected no stderr on success, received:\n${result.stderr}`,
  );

  const trimmed = result.stdout.trim();
  assert(trimmed.length > 0, `${name}: expected JSON stdout, received empty output.`);

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `${name}: expected stdout to be valid JSON only.\nstdout:\n${result.stdout}\nparse error:\n${error}`,
    );
  }

  assert(typeof parsed === "object" && parsed !== null, `${name}: expected parsed JSON object.`);
  return parsed;
}

function expectFailure(name, result, expectedErrorFamily) {
  assert(
    result.code === 1,
    `${name}: expected exit code 1, received ${result.code}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const successJson = result.stdout.trim();
  if (successJson.length > 0) {
    try {
      JSON.parse(successJson);
      throw new Error(
        `${name}: expected failure to avoid success JSON on stdout, but stdout parsed as JSON:\n${result.stdout}`,
      );
    } catch {
      // Non-JSON stdout is still not the expected success surface; continue.
    }
  }

  assert(
    result.stdout.trim().length === 0,
    `${name}: expected no stdout on failure, received:\n${result.stdout}`,
  );

  assert(
    result.stderr.includes(expectedErrorFamily),
    `${name}: expected stderr to include \"${expectedErrorFamily}\".\nstderr:\n${result.stderr}`,
  );
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-resolve-command-deterministic-"));

try {
  const plainResult = await runResolve([plainManifestPath]);
  const plainJson = expectJsonOnlySuccess("plain manifest resolve", plainResult);
  assert(plainJson.name === "runtime-smoke-app", "plain manifest resolve: expected name to round-trip.");
  assert(plainJson.port === 5322, `plain manifest resolve: expected port 5322, received ${plainJson.port}`);
  assert(
    plainJson.installCommand === "node -e \"console.log('install ok')\"",
    `plain manifest resolve: expected installCommand from manifest, received ${plainJson.installCommand}`,
  );

  const playbookPath = "fixtures/playbook-export";
  const playbookResult = await runResolve([
    playbookManifestPath,
    "--playbook-path",
    playbookPath,
  ]);
  const playbookJson = expectJsonOnlySuccess("playbook-backed manifest resolve", playbookResult);

  assert(
    playbookJson.installCommand === "node -e \"console.log('install ok')\"",
    `playbook-backed manifest resolve: expected merged installCommand default, received ${playbookJson.installCommand}`,
  );
  assert(
    playbookJson.buildCommand === "node -e \"console.log('build ok')\"",
    `playbook-backed manifest resolve: expected merged buildCommand default, received ${playbookJson.buildCommand}`,
  );
  assert(
    playbookJson.startCommand === "node server.js",
    `playbook-backed manifest resolve: expected merged startCommand default, received ${playbookJson.startCommand}`,
  );
  assert(
    playbookJson.healthcheckPath === "/healthz",
    `playbook-backed manifest resolve: expected merged healthcheckPath default, received ${playbookJson.healthcheckPath}`,
  );

  const invalidManifestPath = path.join(tempRoot, "invalid-manifest.yml");
  await writeFile(
    invalidManifestPath,
    ["name: invalid-manifest", "archetype: node-web", "branch: main"].join("\n"),
    "utf8",
  );

  const invalidManifestResult = await runResolve([invalidManifestPath]);
  expectFailure(
    "invalid manifest resolve",
    invalidManifestResult,
    "Resolved config is incomplete or invalid",
  );

  const corruptedPlaybookPath = path.join(tempRoot, "playbook-export-corrupted");
  await cp("fixtures/playbook-export", corruptedPlaybookPath, { recursive: true });

  await writeFile(
    path.join(corruptedPlaybookPath, "exports", "lifeline", "archetypes", "node-web.yml"),
    "installCommand: 42\n",
    "utf8",
  );

  const invalidPlaybookResult = await runResolve([
    playbookManifestPath,
    "--playbook-path",
    corruptedPlaybookPath,
  ]);
  expectFailure(
    "invalid playbook export resolve",
    invalidPlaybookResult,
    "Playbook export shape is invalid",
  );

  console.log("Resolve command deterministic verification passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
