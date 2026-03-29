import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";

const cli = ["node", "dist/cli.js"];
const statePath = ".lifeline/state.json";
const fixtureDir = "fixtures/runtime-smoke-app";
const missingKey = "LIFELINE_SMOKE_REQUIRED_MISSING_KEY";
const runtimePort = 6500 + Math.floor(Math.random() * 1500);
const appName = `runtime-smoke-missing-env-${process.pid}`;

let tempRootDir;
let manifestPath;

function run(args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli[0], [...cli.slice(1), ...args], {
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

function canBindPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function readRuntimeState(name) {
  const raw = await readFile(statePath, "utf8").catch(() => "");
  if (!raw) {
    return undefined;
  }

  const parsed = JSON.parse(raw);
  return parsed?.apps?.[name];
}

async function prepareFailingManifest() {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-preflight-"));
  const tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");
  await cp(fixtureDir, tempFixtureDir, { recursive: true });

  const sourceManifestPath = path.join(tempFixtureDir, "runtime-smoke-app.lifeline.yml");
  const raw = await readFile(sourceManifestPath, "utf8");
  const updated = raw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(/requiredKeys:\n([\s\S]*?)deploy:/m, (match, requiredKeysBody) => {
      if (requiredKeysBody.includes(`- ${missingKey}`)) {
        return match;
      }
      return `requiredKeys:\n${requiredKeysBody}    - ${missingKey}\ndeploy:`;
    });

  manifestPath = path.join(tempFixtureDir, "runtime-smoke-missing-env.lifeline.yml");
  await writeFile(manifestPath, updated, "utf8");
}

try {
  await prepareFailingManifest();

  const upResult = await run(["up", manifestPath], { allowFailure: true });
  if (upResult.code === 0) {
    throw new Error(`Expected non-zero exit for missing required env key, got 0.\nstdout:\n${upResult.stdout}`);
  }

  const combinedOutput = `${upResult.stdout}\n${upResult.stderr}`;
  if (
    !combinedOutput.includes("missing required environment keys") ||
    !combinedOutput.includes(missingKey)
  ) {
    throw new Error(
      `Expected clear missing env key failure output containing ${missingKey}.\nstdout:\n${upResult.stdout}\nstderr:\n${upResult.stderr}`,
    );
  }

  const state = await readRuntimeState(appName);
  if (state) {
    throw new Error(`Expected no persisted runtime state for ${appName}, found: ${JSON.stringify(state)}`);
  }

  const statusResult = await run(["status", appName], { allowFailure: true });
  if (statusResult.code === 0) {
    throw new Error(`Expected status to fail for missing state, got success.\nstdout:\n${statusResult.stdout}`);
  }
  if (!statusResult.stderr.includes(`No runtime state found for app ${appName}.`)) {
    throw new Error(
      `Expected status to confirm no runtime state for ${appName}.\nstdout:\n${statusResult.stdout}\nstderr:\n${statusResult.stderr}`,
    );
  }

  const portAvailable = await canBindPort(runtimePort);
  if (!portAvailable) {
    throw new Error(`Expected port ${runtimePort} to remain free after preflight failure.`);
  }
} finally {
  await run(["down", appName], { allowFailure: true });
  if (tempRootDir) {
    await rm(tempRootDir, { recursive: true, force: true });
  }
}
