import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const manifestPath = fileURLToPath(
  new URL("../fixtures/runtime-smoke-app/runtime-smoke-app.playbook.lifeline.yml", import.meta.url),
);
const playbookPath = "fixtures/playbook-export";
const expectedResolvedPlaybookPath = path.resolve(playbookPath).replace(/\\/g, "/");

function runValidate(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, "validate", manifestPath, ...args], {
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
        stdout: stdout.replace(/\r\n/g, "\n"),
        stderr: stderr.replace(/\r\n/g, "\n"),
      });
    });
  });
}

function semanticLines(stdout) {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter(
      (line) =>
        line.startsWith("Resolved manifest is valid:") ||
        line.startsWith("- app:") ||
        line.startsWith("- archetype:") ||
        line.startsWith("- port:") ||
        line.startsWith("- playbook:"),
    );
}

const explicitResult = await runValidate(
  ["--playbook-path", playbookPath],
  process.env,
);

if (explicitResult.code !== 0) {
  throw new Error(
    `Expected explicit --playbook-path validate to succeed, got ${explicitResult.code}.\nstdout:\n${explicitResult.stdout}\nstderr:\n${explicitResult.stderr}`,
  );
}

const envResult = await runValidate([], {
  ...process.env,
  LIFELINE_PLAYBOOK_PATH: playbookPath,
});

if (envResult.code !== 0) {
  throw new Error(
    `Expected env-var validate to succeed, got ${envResult.code}.\nstdout:\n${envResult.stdout}\nstderr:\n${envResult.stderr}`,
  );
}

if (!envResult.stdout.includes("Resolved manifest is valid")) {
  throw new Error(
    `Expected env-var validate output to include success banner.\nstdout:\n${envResult.stdout}\nstderr:\n${envResult.stderr}`,
  );
}

const envPlaybookLine = semanticLines(envResult.stdout).find((line) => line.startsWith("- playbook:"));
if (!envPlaybookLine) {
  throw new Error(
    `Expected env-var validate output to include resolved playbook line.\nstdout:\n${envResult.stdout}\nstderr:\n${envResult.stderr}`,
  );
}

if (!envPlaybookLine.includes(expectedResolvedPlaybookPath)) {
  throw new Error(
    `Expected env-var validate output to include resolved playbook path ${expectedResolvedPlaybookPath}, got: ${envPlaybookLine}`,
  );
}

const explicitSemantic = semanticLines(explicitResult.stdout);
const envSemantic = semanticLines(envResult.stdout);

if (JSON.stringify(explicitSemantic) !== JSON.stringify(envSemantic)) {
  throw new Error(
    [
      "Expected env-var and explicit --playbook-path validate semantics to match.",
      `explicit: ${JSON.stringify(explicitSemantic, null, 2)}`,
      `env-var: ${JSON.stringify(envSemantic, null, 2)}`,
    ].join("\n"),
  );
}

console.log("Validate playbook env-path deterministic verification passed.");
