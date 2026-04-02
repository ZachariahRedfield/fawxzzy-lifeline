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
const fixtureEnv = ".env.runtime";

const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const appName = `runtime-smoke-restore-invalid-manifest-shape-${uniqueSuffix}`;
const runtimePort = 9400 + Math.floor(Math.random() * 500);

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
  tempRootDir = await mkdtemp(
    path.join(
      tmpdir(),
      "lifeline-runtime-restore-invalid-manifest-shape-smoke-",
    ),
  );
  const tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");

  await cp(fixtureDir, tempFixtureDir, { recursive: true });

  const envPath = path.join(tempFixtureDir, fixtureEnv);
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(envPath, envRaw.replace(/^PORT=.*$/m, `PORT=${runtimePort}`), "utf8");

  const tempManifestPath = path.join(tempFixtureDir, fixtureManifest);
  const manifestRaw = await readFile(tempManifestPath, "utf8");
  const manifestForRestore = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never")
    .replace(/^  restorable: .*$/m, "  restorable: true");

  await writeFile(tempManifestPath, manifestForRestore, "utf8");
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

  if (startedState.lastKnownStatus !== "running" || !startedState.restorable) {
    throw new Error(
      `Expected persisted running+restorable state before runtime loss, found ${JSON.stringify(startedState)}`,
    );
  }

  process.kill(startedState.supervisorPid, "SIGKILL");
  await waitForPidExit(startedState.supervisorPid);

  process.kill(startedState.childPid, "SIGKILL");
  await waitForPidExit(startedState.childPid);

  await waitForPortRelease();

  const persistedBeforeRestore = await readRuntimeState();
  if (!persistedBeforeRestore) {
    throw new Error("Expected persisted runtime state before restore");
  }

  if (persistedBeforeRestore.lastKnownStatus !== "running" || !persistedBeforeRestore.restorable) {
    throw new Error(
      `Expected stale safe restorable state before restore, found ${JSON.stringify(persistedBeforeRestore)}`,
    );
  }

  const invalidManifest = (await readFile(manifestPath, "utf8")).replace(
    /^  restartPolicy: .*$/m,
    "  restartPolicy: eventually-consistent-maybe",
  );
  await writeFile(manifestPath, invalidManifest, "utf8");

  const restoreResult = await run(["restore"], { allowFailure: true });
  if (restoreResult.code === 0) {
    throw new Error(
      `Expected restore to fail when manifest contract values are invalid.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  const combinedOutput = `${restoreResult.stdout}\n${restoreResult.stderr}`;
  if (
    !combinedOutput.includes("Resolved config is incomplete or invalid") ||
    !combinedOutput.includes("runtime.restartPolicy") ||
    !combinedOutput.includes("must be one of")
  ) {
    throw new Error(
      `Expected restore failure to clearly explain semantic manifest validation issue.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 700));

  const persistedAfterRestore = await readRuntimeState();
  if (!persistedAfterRestore) {
    throw new Error("Expected persisted runtime state after restore failure");
  }

  if (
    persistedAfterRestore.lastKnownStatus === "running" &&
    persistedAfterRestore.supervisorPid !== persistedBeforeRestore.supervisorPid
  ) {
    throw new Error(
      `Expected restore failure not to refresh runtime as running with a new supervisor pid, found ${persistedAfterRestore.supervisorPid}`,
    );
  }

  if (persistedAfterRestore.supervisorPid && isPidAlive(persistedAfterRestore.supervisorPid)) {
    throw new Error(
      `Expected no live managed supervisor after restore failure, found pid ${persistedAfterRestore.supervisorPid}`,
    );
  }

  if (persistedAfterRestore.childPid && isPidAlive(persistedAfterRestore.childPid)) {
    throw new Error(
      `Expected no live managed child after restore failure, found pid ${persistedAfterRestore.childPid}`,
    );
  }

  const statusAfterRestore = await run(["status", appName], { allowFailure: true });
  if (statusAfterRestore.code === 0) {
    throw new Error(
      `Expected non-running status after failed restore.\nstdout:\n${statusAfterRestore.stdout}\nstderr:\n${statusAfterRestore.stderr}`,
    );
  }

  if (
    statusAfterRestore.stdout.includes(`App ${appName} is running.`) ||
    statusAfterRestore.stdout.includes("- health: ok")
  ) {
    throw new Error(
      `Expected status not to report running or healthy after failed restore.\nstdout:\n${statusAfterRestore.stdout}\nstderr:\n${statusAfterRestore.stderr}`,
    );
  }

  if (!(await canBindPort(runtimePort))) {
    throw new Error(`Expected managed port ${runtimePort} to remain free after failed restore`);
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
