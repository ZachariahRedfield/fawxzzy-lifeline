import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function run(args, { cwd, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
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
      if (code !== 0 && !allowFailure) {
        reject(
          new Error(
            `Command failed: ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }

      resolve({ code, stdout, stderr });
    });
  });
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-invalid-startup-shape-"));
const lifelineDir = path.join(tempRoot, ".lifeline");
await mkdir(lifelineDir, { recursive: true });

const invalidPersistedStartupState = {
  version: "1",
  scope: "global",
  restoreEntrypoint: 7,
  intent: "eventually-enabled",
  backendStatus: "installed",
  updatedAt: 1234,
};

await writeFile(
  path.join(lifelineDir, "startup.json"),
  `${JSON.stringify(invalidPersistedStartupState, null, 2)}\n`,
  "utf8",
);

const statusResult = await run(["startup", "status"], { cwd: tempRoot });
if (statusResult.code !== 0) {
  throw new Error(
    `Expected startup status to succeed with parsed-but-invalid startup state.\nstdout:\n${statusResult.stdout}\nstderr:\n${statusResult.stderr}`,
  );
}

if (!statusResult.stdout.includes("Startup enabled: no")) {
  throw new Error(
    `Expected invalid startup intent to recover to default disabled semantics.\nstdout:\n${statusResult.stdout}\nstderr:\n${statusResult.stderr}`,
  );
}

if (
  !statusResult.stdout.includes("- scope: machine-local") ||
  !statusResult.stdout.includes("- restore entrypoint: lifeline restore")
) {
  throw new Error(
    `Expected startup status to expose canonical contract fields after invalid-shape recovery.\nstdout:\n${statusResult.stdout}\nstderr:\n${statusResult.stderr}`,
  );
}

if (/TypeError|SyntaxError/i.test(statusResult.stderr)) {
  throw new Error(
    `Expected startup invalid-shape recovery to avoid runtime exceptions.\nstderr:\n${statusResult.stderr}`,
  );
}

await run(["startup", "enable"], { cwd: tempRoot });

const rawRecoveredStartupState = await readFile(path.join(lifelineDir, "startup.json"), "utf8");
const recoveredStartupState = JSON.parse(rawRecoveredStartupState);

if (recoveredStartupState.intent !== "enabled") {
  throw new Error(
    `Expected startup enable to converge persisted state intent to enabled.\nstate:\n${rawRecoveredStartupState}`,
  );
}

if (recoveredStartupState.version !== 1) {
  throw new Error(
    `Expected version canonicalization to 1 after recovery.\nstate:\n${rawRecoveredStartupState}`,
  );
}

if (recoveredStartupState.scope !== "machine-local") {
  throw new Error(
    `Expected scope canonicalization to machine-local after recovery.\nstate:\n${rawRecoveredStartupState}`,
  );
}

if (recoveredStartupState.restoreEntrypoint !== "lifeline restore") {
  throw new Error(
    `Expected restoreEntrypoint canonicalization after recovery.\nstate:\n${rawRecoveredStartupState}`,
  );
}

if (recoveredStartupState.backendStatus !== "not-installed") {
  throw new Error(
    `Expected backendStatus canonicalization after recovery.\nstate:\n${rawRecoveredStartupState}`,
  );
}

if (
  typeof recoveredStartupState.updatedAt !== "string" ||
  Number.isNaN(Date.parse(recoveredStartupState.updatedAt))
) {
  throw new Error(
    `Expected updatedAt to be deterministic valid ISO timestamp after recovery.\nstate:\n${rawRecoveredStartupState}`,
  );
}

console.log("Invalid startup state shape deterministic recovery verification passed.");
