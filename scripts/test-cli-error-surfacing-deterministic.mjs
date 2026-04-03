import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runNode(args, { cwd = process.cwd() } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
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
      resolve({ code, stdout, stderr });
    });
  });
}

const typedErrorResult = await runNode([cliPath, "validate", "fixture-manifest.mjs", "--playbook-path"]);
assert(
  typedErrorResult.code === 1,
  `Expected typed LifelineError path to exit 1, received ${typedErrorResult.code}.\nstdout:\n${typedErrorResult.stdout}\nstderr:\n${typedErrorResult.stderr}`,
);
assert(
  typedErrorResult.stderr.trim() === "Missing value for --playbook-path.",
  `Expected typed LifelineError path to surface only message text.\nstdout:\n${typedErrorResult.stdout}\nstderr:\n${typedErrorResult.stderr}`,
);
assert(
  typedErrorResult.stdout.trim() === "",
  `Expected typed LifelineError path to avoid stdout noise.\nstdout:\n${typedErrorResult.stdout}\nstderr:\n${typedErrorResult.stderr}`,
);

const harnessRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-cli-error-surfacing-"));
const harnessPath = path.join(harnessRoot, "unexpected-error-harness.mjs");
const errorsPath = fileURLToPath(new URL("../dist/core/errors.js", import.meta.url));

const harness = `
import { LifelineError } from ${JSON.stringify(errorsPath)};

Promise.reject(new Error("forced unexpected failure"))
  .catch((error) => {
    if (error instanceof LifelineError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(\`Unexpected error: \${message}\`);
    process.exitCode = 1;
  });
`;

await writeFile(harnessPath, harness, "utf8");
const unexpectedResult = await runNode([harnessPath], { cwd: harnessRoot });

assert(
  unexpectedResult.code === 1,
  `Expected unexpected error path to exit 1, received ${unexpectedResult.code}.\nstdout:\n${unexpectedResult.stdout}\nstderr:\n${unexpectedResult.stderr}`,
);
assert(
  unexpectedResult.stderr.trim() === "Unexpected error: forced unexpected failure",
  `Expected unexpected error path to include Unexpected error prefix.\nstdout:\n${unexpectedResult.stdout}\nstderr:\n${unexpectedResult.stderr}`,
);
assert(
  unexpectedResult.stdout.trim() === "",
  `Expected unexpected error path to avoid stdout noise.\nstdout:\n${unexpectedResult.stdout}\nstderr:\n${unexpectedResult.stderr}`,
);

console.log("CLI error surfacing deterministic verification passed.");
