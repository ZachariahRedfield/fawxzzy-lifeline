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
const appName = `runtime-smoke-restore-missing-working-directory-${uniqueSuffix}`;
const runtimePort = 9985 + Math.floor(Math.random() * 20);

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

async function waitForPidExit(pid) {
  for (let i = 0; i < 60; i += 1) {
    if (!isPidAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for pid ${pid} to exit`);
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

async function waitForPortRelease() {
  for (let i = 0; i < 40; i += 1) {
    if (await canBindPort(runtimePort)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Expected managed port ${runtimePort} to be free after runtime loss`);
}

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-restore-missing-working-directory-smoke-"));
  const tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");

  await cp(fixtureDir, tempFixtureDir, { recursive: true });

  const envPath = path.join(tempFixtureDir, fixtureEnv);
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(envPath, envRaw.replace(/^PORT=.*$/m, `PORT=${runtimePort}`), "utf8");

  const runtimeWorkingDirectory = path.join(tempFixtureDir, "runtime-root");
  await mkdir(runtimeWorkingDirectory, { recursive: true });

  const tempManifestPath = path.join(tempFixtureDir, fixtureManifest);
  const manifestRaw = await readFile(tempManifestPath, "utf8");
  const manifestForRestore = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(/^startCommand: .*$/m, "startCommand: node ../server.js")
    .replace(/^  workingDirectory: .*$/m, "  workingDirectory: ./runtime-root")
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never")
    .replace(/^  restorable: .*$/m, "  restorable: true");

  await writeFile(tempManifestPath, manifestForRestore, "utf8");
  manifestPath = tempManifestPath;
  resolvedWorkingDirectory = runtimeWorkingDirectory;
}

async function cleanup() {
  await run(["down", appName], { allowFailure: true });
}

try {
  await prepareFixtureConfig();
  await cleanup();

  await run(["up", manifestPath]);
  const startedState = await waitForRunning();

  if (startedState.workingDirectory !== resolvedWorkingDirectory) {
    throw new Error(
      `Expected persisted working directory ${resolvedWorkingDirectory} after initial up, found ${startedState.workingDirectory}`,
    );
  }

  process.kill(startedState.supervisorPid, "SIGKILL");
  await waitForPidExit(startedState.supervisorPid);

  process.kill(startedState.childPid, "SIGKILL");
  await waitForPidExit(startedState.childPid);

  await waitForPortRelease();

  const persistedBeforeDelete = await readRuntimeState();
  if (!persistedBeforeDelete) {
    throw new Error("Expected persisted runtime state before deleting working directory");
  }

  if (persistedBeforeDelete.lastKnownStatus !== "running") {
    throw new Error(
      `Expected persisted status running before restore failure scenario, found ${persistedBeforeDelete.lastKnownStatus}`,
    );
  }

  await rm(resolvedWorkingDirectory, { recursive: true, force: true });

  const restoreResult = await run(["restore"], { allowFailure: true });
  if (restoreResult.code === 0) {
    throw new Error(
      `Expected restore to fail when resolved working directory is missing.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (!restoreResult.stderr.includes(`Failed to restore ${appName}:`)) {
    throw new Error(
      `Expected restore to report app-scoped restore failure.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (!restoreResult.stderr.includes("Working directory for app")) {
    throw new Error(
      `Expected restore failure to clearly explain missing working directory.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 700));

  const persistedImmediatelyAfterRestore = await readRuntimeState();
  if (!persistedImmediatelyAfterRestore) {
    throw new Error("Expected persisted runtime state after restore failure");
  }

  if (
    persistedImmediatelyAfterRestore.supervisorPid &&
    isPidAlive(persistedImmediatelyAfterRestore.supervisorPid)
  ) {
    throw new Error(
      `Expected no live managed supervisor after restore failure, found pid ${persistedImmediatelyAfterRestore.supervisorPid}`,
    );
  }

  if (persistedImmediatelyAfterRestore.childPid && isPidAlive(persistedImmediatelyAfterRestore.childPid)) {
    throw new Error(
      `Expected no live managed child after restore failure, found pid ${persistedImmediatelyAfterRestore.childPid}`,
    );
  }

  if (!(await canBindPort(runtimePort))) {
    throw new Error(`Expected managed port ${runtimePort} to remain free after failed restore`);
  }

  const statusAfterRestore = await run(["status", appName], { allowFailure: true });
  if (statusAfterRestore.code === 0) {
    throw new Error(
      `Expected non-running status after failed restore.\nstdout:\n${statusAfterRestore.stdout}\nstderr:\n${statusAfterRestore.stderr}`,
    );
  }

  if (statusAfterRestore.stdout.includes(`App ${appName} is running.`)) {
    throw new Error(
      `Expected status not to report running after failed restore.\nstdout:\n${statusAfterRestore.stdout}\nstderr:\n${statusAfterRestore.stderr}`,
    );
  }

  if (!statusAfterRestore.stdout.includes("- portOwner: none")) {
    throw new Error(
      `Expected status to report no port owner after failed restore.\nstdout:\n${statusAfterRestore.stdout}\nstderr:\n${statusAfterRestore.stderr}`,
    );
  }

  if (statusAfterRestore.stdout.includes("- health: ok")) {
    throw new Error(
      `Expected status not to report healthy after failed restore.\nstdout:\n${statusAfterRestore.stdout}\nstderr:\n${statusAfterRestore.stderr}`,
    );
  }

  const persistedAfterStatus = await readRuntimeState();
  if (!persistedAfterStatus) {
    throw new Error("Expected persisted runtime state after failed restore status check");
  }

  if (persistedAfterStatus.lastKnownStatus === "running") {
    throw new Error("Expected persisted state not to flip back to running after failed restore");
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
