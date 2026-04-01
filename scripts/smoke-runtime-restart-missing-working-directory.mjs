import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const fixtureEnv = ".env.runtime";

const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const appName = `runtime-smoke-restart-missing-working-directory-${uniqueSuffix}`;
const runtimePort = 9940 + Math.floor(Math.random() * 30);

let manifestPath;
let resolvedWorkingDirectory;
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

async function waitForRuntime(predicate, label) {
  for (let i = 0; i < 60; i += 1) {
    const state = await readRuntimeState();
    if (state && predicate(state)) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const latestStatus = await run(["status", appName], { allowFailure: true });
  throw new Error(
    `Timed out waiting for ${label}.\nstatus:\n${latestStatus.stdout}\n${latestStatus.stderr}`,
  );
}

async function waitForRunning() {
  return waitForRuntime(
    (state) =>
      state.lastKnownStatus === "running" &&
      isPidAlive(state.supervisorPid) &&
      isPidAlive(state.childPid),
    "running state with live managed supervisor and child",
  );
}

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-restart-missing-working-directory-smoke-"));
  const tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");

  await cp(fixtureDir, tempFixtureDir, { recursive: true });

  const envPath = path.join(tempFixtureDir, fixtureEnv);
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(envPath, envRaw.replace(/^PORT=.*$/m, `PORT=${runtimePort}`), "utf8");

  resolvedWorkingDirectory = path.join(tempFixtureDir, "runtime-root");
  await mkdir(resolvedWorkingDirectory, { recursive: true });

  const tempManifestPath = path.join(tempFixtureDir, fixtureManifest);
  const manifestRaw = await readFile(tempManifestPath, "utf8");
  const manifestForRestart = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(/^startCommand: .*$/m, "startCommand: node ../server.js")
    .replace(/^  workingDirectory: .*$/m, "  workingDirectory: ./runtime-root")
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never");

  await writeFile(tempManifestPath, manifestForRestart, "utf8");
  manifestPath = tempManifestPath;
}

async function cleanup() {
  await run(["down", appName], { allowFailure: true });
}

try {
  await prepareFixtureConfig();
  await cleanup();

  await run(["up", manifestPath]);
  const startedState = await waitForRunning();

  if (!startedState.manifestPath) {
    throw new Error("Expected persisted runtime state to include manifestPath after initial up");
  }

  if (startedState.workingDirectory !== resolvedWorkingDirectory) {
    throw new Error(
      `Expected persisted working directory ${resolvedWorkingDirectory} after initial up, found ${startedState.workingDirectory}`,
    );
  }

  const startingSupervisorPid = startedState.supervisorPid;
  const startingChildPid = startedState.childPid;

  await rm(resolvedWorkingDirectory, { recursive: true, force: true });

  const restartResult = await run(["restart", appName], { allowFailure: true });
  if (restartResult.code === 0) {
    throw new Error(
      `Expected restart to fail when resolved working directory is missing.\nstdout:\n${restartResult.stdout}\nstderr:\n${restartResult.stderr}`,
    );
  }

  if (
    !restartResult.stderr.includes("Working directory for app") &&
    !restartResult.stderr.includes("working directory")
  ) {
    throw new Error(
      `Expected restart failure to clearly explain missing working directory.\nstdout:\n${restartResult.stdout}\nstderr:\n${restartResult.stderr}`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 700));

  const persistedAfterRestart = await readRuntimeState();
  if (!persistedAfterRestart) {
    throw new Error("Expected persisted runtime state after restart failure");
  }

  if (persistedAfterRestart.lastKnownStatus === "running") {
    throw new Error("Expected persisted state not to flip back to running after failed restart");
  }

  if (
    persistedAfterRestart.supervisorPid &&
    persistedAfterRestart.supervisorPid !== startingSupervisorPid &&
    isPidAlive(persistedAfterRestart.supervisorPid)
  ) {
    throw new Error(
      `Expected no replacement managed supervisor after restart failure, found pid ${persistedAfterRestart.supervisorPid}`,
    );
  }

  if (
    persistedAfterRestart.childPid &&
    persistedAfterRestart.childPid !== startingChildPid &&
    isPidAlive(persistedAfterRestart.childPid)
  ) {
    throw new Error(
      `Expected no replacement managed child after restart failure, found pid ${persistedAfterRestart.childPid}`,
    );
  }

  const statusAfterRestart = await run(["status", appName], { allowFailure: true });
  if (statusAfterRestart.code === 0) {
    throw new Error(
      `Expected non-running status after failed restart.\nstdout:\n${statusAfterRestart.stdout}\nstderr:\n${statusAfterRestart.stderr}`,
    );
  }

  if (statusAfterRestart.stdout.includes(`App ${appName} is running.`)) {
    throw new Error(
      `Expected status not to report running after failed restart.\nstdout:\n${statusAfterRestart.stdout}\nstderr:\n${statusAfterRestart.stderr}`,
    );
  }

  if (statusAfterRestart.stdout.includes("- health: ok")) {
    throw new Error(
      `Expected status not to report healthy after failed restart.\nstdout:\n${statusAfterRestart.stdout}\nstderr:\n${statusAfterRestart.stderr}`,
    );
  }

  if (!(await canBindPort(runtimePort))) {
    throw new Error(`Expected managed port ${runtimePort} to remain free after failed restart`);
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
