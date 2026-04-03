import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const manifestPath = fileURLToPath(
  new URL("../fixtures/runtime-smoke-app/runtime-smoke-app.playbook.lifeline.yml", import.meta.url),
);
const playbookPath = "fixtures/playbook-export";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalize(text) {
  return text.replace(/\r\n/g, "\n");
}

function runResolve(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, "resolve", manifestPath, ...args], {
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

function parseSuccessJson(name, result) {
  assert(
    result.code === 0,
    `${name}: expected exit code 0, received ${result.code}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert(
    result.stderr.trim().length === 0,
    `${name}: expected no stderr on success, received:\n${result.stderr}`,
  );

  const trimmed = result.stdout.trim();
  assert(trimmed.length > 0, `${name}: expected JSON stdout.`);

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${name}: expected JSON stdout only.\nstdout:\n${result.stdout}\nerror:\n${error}`);
  }
}

const explicitResult = await runResolve(["--playbook-path", playbookPath], process.env);
const explicitJson = parseSuccessJson("resolve with explicit --playbook-path", explicitResult);

const envResult = await runResolve([], {
  ...process.env,
  LIFELINE_PLAYBOOK_PATH: playbookPath,
});
const envJson = parseSuccessJson("resolve with env-var playbook path", envResult);

const explicitSemantic = JSON.stringify(explicitJson);
const envSemantic = JSON.stringify(envJson);

if (explicitSemantic !== envSemantic) {
  throw new Error(
    [
      "Expected env-var and explicit --playbook-path resolve semantics to match.",
      `explicit: ${JSON.stringify(explicitJson, null, 2)}`,
      `env-var: ${JSON.stringify(envJson, null, 2)}`,
    ].join("\n"),
  );
}

assert(
  envJson.installCommand === "node -e \"console.log('install ok')\"",
  `Expected playbook defaults to remain merged for env-var path ingress, received installCommand=${envJson.installCommand}`,
);

console.log("Resolve command playbook env-path deterministic verification passed.");
