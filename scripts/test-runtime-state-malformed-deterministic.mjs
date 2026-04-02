import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-malformed-runtime-state-"));
const lifelineDir = path.join(tempRoot, ".lifeline");
await mkdir(lifelineDir, { recursive: true });
await writeFile(path.join(lifelineDir, "state.json"), "{ not-valid-json", "utf8");

const appName = "malformed-runtime-state-check";
const statusResult = await run(["status", appName], { cwd: tempRoot, allowFailure: true });
if (statusResult.code === 0) {
  throw new Error(
    `Expected status to fail without runtime history for ${appName}.\nstdout:\n${statusResult.stdout}\nstderr:\n${statusResult.stderr}`,
  );
}

if (!statusResult.stderr.includes(`No runtime state found for app ${appName}.`)) {
  throw new Error(
    `Expected deterministic missing-state message for malformed runtime state.\nstdout:\n${statusResult.stdout}\nstderr:\n${statusResult.stderr}`,
  );
}

if (/SyntaxError/i.test(statusResult.stderr)) {
  throw new Error(
    `Expected malformed runtime state parsing to be handled without SyntaxError.\nstderr:\n${statusResult.stderr}`,
  );
}

console.log("Malformed runtime state deterministic recovery verification passed.");
