import { spawn } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fixtureManifestPath = fileURLToPath(
  new URL("../fixtures/runtime-smoke-app/runtime-smoke-app.playbook.lifeline.yml", import.meta.url),
);

function run(args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, ...args], {
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

const tempRoot = await mkdtemp(
  path.join(os.tmpdir(), "lifeline-validate-invalid-playbook-export-"),
);

try {
  const corruptedPlaybookPath = path.join(tempRoot, "playbook-export-corrupted");
  await cp("fixtures/playbook-export", corruptedPlaybookPath, { recursive: true });

  const corruptedArchetypePath = path.join(
    corruptedPlaybookPath,
    "exports",
    "lifeline",
    "archetypes",
    "node-web.yml",
  );

  await writeFile(corruptedArchetypePath, "installCommand: 42\n", "utf8");

  const validateResult = await run(
    ["validate", fixtureManifestPath, "--playbook-path", corruptedPlaybookPath],
    { allowFailure: true },
  );

  if (validateResult.code === 0) {
    throw new Error(
      `Expected validate to fail when Playbook export shape is invalid.\nstdout:\n${validateResult.stdout}\nstderr:\n${validateResult.stderr}`,
    );
  }

  const combinedOutput = `${validateResult.stdout}\n${validateResult.stderr}`;

  if (!combinedOutput.includes("Playbook export shape is invalid")) {
    throw new Error(
      `Expected validate failure to include Playbook export contract message.\nstdout:\n${validateResult.stdout}\nstderr:\n${validateResult.stderr}`,
    );
  }

  if (combinedOutput.includes("Resolved manifest is valid")) {
    throw new Error(
      `Expected validate failure output to avoid success surface.\nstdout:\n${validateResult.stdout}\nstderr:\n${validateResult.stderr}`,
    );
  }

  console.log("Validate invalid Playbook export deterministic verification passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
