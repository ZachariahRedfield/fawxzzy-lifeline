import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const cli = ["node", "dist/cli.js"];
const statePath = ".lifeline/state.json";
const fixtureDir = "fixtures/runtime-smoke-app";
const fixtureManifest = "runtime-smoke-app.lifeline.yml";

const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const appName = `runtime-smoke-up-invalid-manifest-shape-${uniqueSuffix}`;
const runtimePort = 9980 + Math.floor(Math.random() * 20);

let manifestPath;
let tempRootDir;

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

function isPidAlive(pid) {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

async function readStateFile() {
  const raw = await readFile(statePath, "utf8").catch(() => "");
  return raw ? JSON.parse(raw) : { apps: {} };
}

async function readRuntimeState() {
  const parsed = await readStateFile();
  return parsed?.apps?.[appName];
}

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(
    path.join(tmpdir(), "lifeline-runtime-up-invalid-manifest-shape-smoke-"),
  );
  const tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");

  await cp(fixtureDir, tempFixtureDir, { recursive: true });

  const tempManifestPath = path.join(tempFixtureDir, fixtureManifest);
  const manifestRaw = await readFile(tempManifestPath, "utf8");
  const invalidManifest = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(
      /^  restartPolicy: .*$/m,
      "  restartPolicy: eventually-consistent-maybe",
    );

  await writeFile(tempManifestPath, invalidManifest, "utf8");
  manifestPath = tempManifestPath;
}

async function cleanup() {
  await run(["down", appName], { allowFailure: true });
}

try {
  await prepareFixtureConfig();
  await cleanup();

  const upResult = await run(["up", manifestPath], { allowFailure: true });
  if (upResult.code === 0) {
    throw new Error(
      `Expected up to fail when manifest contract values are invalid.\nstdout:\n${upResult.stdout}\nstderr:\n${upResult.stderr}`,
    );
  }

  const combinedOutput = `${upResult.stdout}\n${upResult.stderr}`;
  if (
    !combinedOutput.includes("Resolved config is incomplete or invalid") ||
    !combinedOutput.includes("runtime.restartPolicy") ||
    !combinedOutput.includes("must be one of")
  ) {
    throw new Error(
      `Expected up failure to clearly explain semantic manifest validation issue.\nstdout:\n${upResult.stdout}\nstderr:\n${upResult.stderr}`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 700));

  const persistedAfterUp = await readRuntimeState();
  if (persistedAfterUp) {
    if (persistedAfterUp.lastKnownStatus === "running") {
      throw new Error(
        "Expected persisted state not to flip to running after failed up",
      );
    }

    if (
      persistedAfterUp.supervisorPid &&
      isPidAlive(persistedAfterUp.supervisorPid)
    ) {
      throw new Error(
        `Expected no live managed supervisor after failed up, found pid ${persistedAfterUp.supervisorPid}`,
      );
    }

    if (persistedAfterUp.childPid && isPidAlive(persistedAfterUp.childPid)) {
      throw new Error(
        `Expected no live managed child after failed up, found pid ${persistedAfterUp.childPid}`,
      );
    }
  }

  const statusAfterUp = await run(["status", appName], { allowFailure: true });
  if (statusAfterUp.code === 0) {
    throw new Error(
      `Expected non-running status after failed up.\nstdout:\n${statusAfterUp.stdout}\nstderr:\n${statusAfterUp.stderr}`,
    );
  }

  if (
    statusAfterUp.stdout.includes(`App ${appName} is running.`) ||
    statusAfterUp.stdout.includes("- health: ok")
  ) {
    throw new Error(
      `Expected status not to report running or healthy after failed up.\nstdout:\n${statusAfterUp.stdout}\nstderr:\n${statusAfterUp.stderr}`,
    );
  }

  if (!(await canBindPort(runtimePort))) {
    throw new Error(
      `Expected managed port ${runtimePort} to remain free after failed up`,
    );
  }
} catch (error) {
  await cleanup();
  throw error;
} finally {
  await cleanup();
  if (tempRootDir) {
    await rm(tempRootDir, { recursive: true, force: true });
  }
}
