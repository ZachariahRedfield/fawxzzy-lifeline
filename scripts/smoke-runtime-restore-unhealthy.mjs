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

const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const appName = `runtime-smoke-restore-unhealthy-${uniqueSuffix}`;
const runtimePort = 7600 + Math.floor(Math.random() * 1000);

let manifestPath = "fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml";
let tempRootDir;
let failFlagPath;

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

async function waitForPortRelease() {
  for (let i = 0; i < 40; i += 1) {
    if (await canBindPort(runtimePort)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Expected managed port ${runtimePort} to be free after runtime loss`);
}

async function readRuntimeState() {
  const raw = await readFile(statePath, "utf8").catch(() => "");
  if (!raw) {
    return undefined;
  }

  const parsed = JSON.parse(raw);
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
      isPidAlive(state.childPid) &&
      Boolean(state.portOwnerPid),
    "running state with live managed runtime",
  );
}

async function waitForUnhealthy() {
  for (let i = 0; i < 60; i += 1) {
    const unhealthyStatus = await run(["status", appName], { allowFailure: true });
    if (
      unhealthyStatus.code !== 0 &&
      unhealthyStatus.stdout.includes(`App ${appName} is unhealthy.`) &&
      unhealthyStatus.stdout.includes("- health: HTTP 503")
    ) {
      return unhealthyStatus;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const latestStatus = await run(["status", appName], { allowFailure: true });
  throw new Error(
    `Timed out waiting for unhealthy status.\nstatus:\n${latestStatus.stdout}\n${latestStatus.stderr}`,
  );
}

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-restore-unhealthy-smoke-"));
  const tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");

  await cp("fixtures/runtime-smoke-app", tempFixtureDir, { recursive: true });

  failFlagPath = path.join(tempFixtureDir, ".force-healthcheck-failure");
  const envPath = path.join(tempFixtureDir, ".env.runtime");
  const envRaw = await readFile(envPath, "utf8");
  const envWithOverrides = envRaw
    .replace(/^PORT=.*$/m, `PORT=${runtimePort}`)
    .concat(`\nHEALTH_FAIL_FLAG_FILE=${failFlagPath}\n`);
  await writeFile(envPath, envWithOverrides, "utf8");

  const tempManifestPath = path.join(tempFixtureDir, "runtime-smoke-app.lifeline.yml");
  const manifestRaw = await readFile(tempManifestPath, "utf8");

  const manifestForScenario = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never")
    .replace(/^  restorable: .*$/m, "  restorable: true");

  await writeFile(tempManifestPath, manifestForScenario, "utf8");
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

  await writeFile(failFlagPath, "fail\n", "utf8");
  await waitForUnhealthy();

  const persistedUnhealthy = await readRuntimeState();
  if (!persistedUnhealthy) {
    throw new Error("Expected persisted runtime state while unhealthy before restore relaunch");
  }

  if (persistedUnhealthy.lastKnownStatus !== "unhealthy") {
    throw new Error(
      `Expected persisted unhealthy state before restore relaunch, found ${JSON.stringify(persistedUnhealthy)}`,
    );
  }

  if (!persistedUnhealthy.restorable) {
    throw new Error(
      `Expected unhealthy state to remain restorable before restore relaunch, found ${JSON.stringify(persistedUnhealthy)}`,
    );
  }

  process.kill(startedState.supervisorPid, "SIGKILL");
  await waitForPidExit(startedState.supervisorPid);

  process.kill(startedState.childPid, "SIGKILL");
  await waitForPidExit(startedState.childPid);

  await waitForPortRelease();

  const staleUnhealthyState = await readRuntimeState();
  if (!staleUnhealthyState) {
    throw new Error("Expected persisted stale unhealthy state before restore relaunch");
  }

  if (staleUnhealthyState.lastKnownStatus !== "unhealthy" || !staleUnhealthyState.restorable) {
    throw new Error(
      `Expected stale unhealthy+restorable state before restore relaunch, found ${JSON.stringify(staleUnhealthyState)}`,
    );
  }

  if (isPidAlive(staleUnhealthyState.supervisorPid) || isPidAlive(staleUnhealthyState.childPid)) {
    throw new Error(
      `Expected stale unhealthy state to have no live supervisor/child before restore relaunch, found ${JSON.stringify(staleUnhealthyState)}`,
    );
  }

  await writeFile(failFlagPath, "", "utf8");

  const restoreResult = await run(["restore"], { allowFailure: true });
  if (restoreResult.code !== 0) {
    throw new Error(
      `Expected restore command to succeed from stale unhealthy state.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (!restoreResult.stdout.includes(`Restored ${appName} with supervisor pid`)) {
    throw new Error(
      `Expected restore output to confirm unhealthy restore relaunch.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  const restoredRunningState = await waitForRunning();

  if (restoredRunningState.supervisorPid === startedState.supervisorPid) {
    throw new Error(
      `Expected restore relaunch from unhealthy state to use new supervisor pid, still ${restoredRunningState.supervisorPid}`,
    );
  }

  if (restoredRunningState.childPid === startedState.childPid) {
    throw new Error(
      `Expected restore relaunch from unhealthy state to use new child pid, still ${restoredRunningState.childPid}`,
    );
  }

  if (!restoredRunningState.portOwnerPid || restoredRunningState.portOwnerPid !== restoredRunningState.childPid) {
    throw new Error(
      `Expected restored runtime to own managed port via child pid. childPid=${restoredRunningState.childPid} portOwnerPid=${restoredRunningState.portOwnerPid}`,
    );
  }

  const statusAfterRestore = await run(["status", appName], { allowFailure: true });
  if (statusAfterRestore.code !== 0) {
    throw new Error(
      `Expected healthy running status after restore relaunch from unhealthy state.\nstdout:\n${statusAfterRestore.stdout}\nstderr:\n${statusAfterRestore.stderr}`,
    );
  }

  if (!statusAfterRestore.stdout.includes(`App ${appName} is running.`)) {
    throw new Error(
      `Expected running status after restore relaunch from unhealthy state.\nstdout:\n${statusAfterRestore.stdout}\nstderr:\n${statusAfterRestore.stderr}`,
    );
  }

  if (!statusAfterRestore.stdout.includes("- health: ok")) {
    throw new Error(
      `Expected healthy status output after restore relaunch from unhealthy state.\nstdout:\n${statusAfterRestore.stdout}\nstderr:\n${statusAfterRestore.stderr}`,
    );
  }

  if (!statusAfterRestore.stdout.includes(`- portOwner: pid ${restoredRunningState.childPid}`)) {
    throw new Error(
      `Expected restored managed child pid ${restoredRunningState.childPid} to own runtime port.\nstdout:\n${statusAfterRestore.stdout}\nstderr:\n${statusAfterRestore.stderr}`,
    );
  }

  const persistedAfterRestore = await readRuntimeState();
  if (!persistedAfterRestore) {
    throw new Error("Expected persisted runtime state after unhealthy restore relaunch");
  }

  if (persistedAfterRestore.lastKnownStatus !== "running") {
    throw new Error(
      `Expected persisted status to converge to running after unhealthy restore relaunch, found ${persistedAfterRestore.lastKnownStatus}`,
    );
  }

  if (!persistedAfterRestore.childPid || !isPidAlive(persistedAfterRestore.childPid)) {
    throw new Error(
      `Expected persisted child pid to point at live runtime after unhealthy restore relaunch, found ${persistedAfterRestore.childPid}`,
    );
  }

  if (persistedAfterRestore.portOwnerPid !== persistedAfterRestore.childPid) {
    throw new Error(
      `Expected persisted state coherence after unhealthy restore relaunch. childPid=${persistedAfterRestore.childPid} portOwnerPid=${persistedAfterRestore.portOwnerPid}`,
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
