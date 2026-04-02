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
const relaunchAppName = `runtime-smoke-restore-mixed-relaunch-${uniqueSuffix}`;
const runningAppName = `runtime-smoke-restore-mixed-running-${uniqueSuffix}`;
const relaunchPort = 7600 + Math.floor(Math.random() * 400);
const runningPort = 8200 + Math.floor(Math.random() * 400);

let relaunchManifestPath = "fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml";
let runningManifestPath = "fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml";
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

async function readRuntimeState(appName) {
  const raw = await readFile(statePath, "utf8").catch(() => "");
  if (!raw) {
    return undefined;
  }

  const parsed = JSON.parse(raw);
  return parsed?.apps?.[appName];
}

async function waitForRuntime(appName, predicate, label) {
  for (let i = 0; i < 60; i += 1) {
    const state = await readRuntimeState(appName);
    if (state && predicate(state)) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const latestStatus = await run(["status", appName], { allowFailure: true });
  throw new Error(
    `Timed out waiting for ${label} (${appName}).\nstatus:\n${latestStatus.stdout}\n${latestStatus.stderr}`,
  );
}

async function waitForRunning(appName) {
  return waitForRuntime(
    appName,
    (state) =>
      state.lastKnownStatus === "running" &&
      isPidAlive(state.supervisorPid) &&
      isPidAlive(state.childPid),
    "running state with live managed supervisor and child",
  );
}

async function waitForPortRelease(port) {
  for (let i = 0; i < 40; i += 1) {
    if (await canBindPort(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Expected managed port ${port} to be free`);
}

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-restore-mixed-smoke-"));

  const relaunchFixtureDir = path.join(tempRootDir, "runtime-smoke-app-relaunch");
  await cp("fixtures/runtime-smoke-app", relaunchFixtureDir, { recursive: true });

  const relaunchEnvPath = path.join(relaunchFixtureDir, ".env.runtime");
  const relaunchEnvRaw = await readFile(relaunchEnvPath, "utf8");
  await writeFile(
    relaunchEnvPath,
    relaunchEnvRaw.replace(/^PORT=.*$/m, `PORT=${relaunchPort}`),
    "utf8",
  );

  const relaunchTempManifestPath = path.join(relaunchFixtureDir, "runtime-smoke-app.lifeline.yml");
  const relaunchManifestRaw = await readFile(relaunchTempManifestPath, "utf8");
  const manifestForRelaunch = relaunchManifestRaw
    .replace(/^name: .*$/m, `name: ${relaunchAppName}`)
    .replace(/^port: .*$/m, `port: ${relaunchPort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never")
    .replace(/^  restorable: .*$/m, "  restorable: true");
  await writeFile(relaunchTempManifestPath, manifestForRelaunch, "utf8");
  relaunchManifestPath = relaunchTempManifestPath;

  const runningFixtureDir = path.join(tempRootDir, "runtime-smoke-app-running");
  await cp("fixtures/runtime-smoke-app", runningFixtureDir, { recursive: true });

  const runningEnvPath = path.join(runningFixtureDir, ".env.runtime");
  const runningEnvRaw = await readFile(runningEnvPath, "utf8");
  await writeFile(runningEnvPath, runningEnvRaw.replace(/^PORT=.*$/m, `PORT=${runningPort}`), "utf8");

  const runningTempManifestPath = path.join(runningFixtureDir, "runtime-smoke-app.lifeline.yml");
  const runningManifestRaw = await readFile(runningTempManifestPath, "utf8");
  const manifestForRunning = runningManifestRaw
    .replace(/^name: .*$/m, `name: ${runningAppName}`)
    .replace(/^port: .*$/m, `port: ${runningPort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never")
    .replace(/^  restorable: .*$/m, "  restorable: true");
  await writeFile(runningTempManifestPath, manifestForRunning, "utf8");
  runningManifestPath = runningTempManifestPath;
}

async function cleanup() {
  await run(["down", relaunchAppName], { allowFailure: true });
  await run(["down", runningAppName], { allowFailure: true });
}

try {
  await prepareFixtureConfig();
  await cleanup();

  await run(["up", relaunchManifestPath]);
  await run(["up", runningManifestPath]);

  const relaunchStartedState = await waitForRunning(relaunchAppName);
  const runningStartedState = await waitForRunning(runningAppName);

  if (relaunchStartedState.lastKnownStatus !== "running" || !relaunchStartedState.restorable) {
    throw new Error(
      `Expected relaunch app to have persisted running+restorable state before runtime loss, found ${JSON.stringify(relaunchStartedState)}`,
    );
  }

  if (runningStartedState.lastKnownStatus !== "running" || !runningStartedState.restorable) {
    throw new Error(
      `Expected running app to have persisted running+restorable state before restore, found ${JSON.stringify(runningStartedState)}`,
    );
  }

  process.kill(relaunchStartedState.supervisorPid, "SIGKILL");
  await waitForPidExit(relaunchStartedState.supervisorPid);
  process.kill(relaunchStartedState.childPid, "SIGKILL");
  await waitForPidExit(relaunchStartedState.childPid);
  await waitForPortRelease(relaunchPort);

  const relaunchBeforeRestore = await readRuntimeState(relaunchAppName);
  if (!relaunchBeforeRestore) {
    throw new Error("Expected relaunch app to keep persisted state before restore");
  }

  if (relaunchBeforeRestore.lastKnownStatus !== "running" || !relaunchBeforeRestore.restorable) {
    throw new Error(
      `Expected stale running+restorable state for relaunch app before restore, found ${JSON.stringify(relaunchBeforeRestore)}`,
    );
  }

  const runningBeforeRestore = await readRuntimeState(runningAppName);
  if (!runningBeforeRestore) {
    throw new Error("Expected running app to keep persisted state before restore");
  }

  if (runningBeforeRestore.lastKnownStatus !== "running") {
    throw new Error(
      `Expected running app persisted status to remain running before restore, found ${runningBeforeRestore.lastKnownStatus}`,
    );
  }

  if (!isPidAlive(runningBeforeRestore.supervisorPid) || !isPidAlive(runningBeforeRestore.childPid)) {
    throw new Error(
      `Expected running app supervisor/child pids to be alive before restore, state=${JSON.stringify(runningBeforeRestore)}`,
    );
  }

  const restoreResult = await run(["restore"], { allowFailure: true });
  if (restoreResult.code !== 0) {
    throw new Error(
      `Expected restore command to succeed for mixed batch.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (!restoreResult.stdout.includes(`Restored ${relaunchAppName} with supervisor pid`)) {
    throw new Error(
      `Expected restore output to confirm relaunch app restart.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (
    !restoreResult.stdout.includes(
      `Skipping ${runningAppName}: supervisor already running (pid ${runningBeforeRestore.supervisorPid}).`,
    )
  ) {
    throw new Error(
      `Expected restore output to explicitly skip running app in mixed batch.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (restoreResult.stdout.includes("No managed apps found in .lifeline/state.json.")) {
    throw new Error(
      `Expected restore not to report missing runtime history in mixed batch.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (restoreResult.stdout.includes(`No runtime state found for ${relaunchAppName}`)) {
    throw new Error(
      `Expected relaunch app not to hit no-history confusion in mixed restore.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (restoreResult.stdout.includes(`No runtime state found for ${runningAppName}`)) {
    throw new Error(
      `Expected running app not to hit no-history confusion in mixed restore.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  const relaunchAfterRestore = await waitForRunning(relaunchAppName);
  if (relaunchAfterRestore.supervisorPid === relaunchStartedState.supervisorPid) {
    throw new Error(
      `Expected restore to launch a new relaunch-app supervisor pid, still ${relaunchAfterRestore.supervisorPid}`,
    );
  }

  if (relaunchAfterRestore.childPid === relaunchStartedState.childPid) {
    throw new Error(
      `Expected restore to launch a new relaunch-app child pid, still ${relaunchAfterRestore.childPid}`,
    );
  }

  const runningAfterRestore = await waitForRunning(runningAppName);
  if (runningAfterRestore.supervisorPid !== runningStartedState.supervisorPid) {
    throw new Error(
      `Expected running app supervisor pid to remain unchanged on restore skip, before=${runningStartedState.supervisorPid} after=${runningAfterRestore.supervisorPid}`,
    );
  }

  if (runningAfterRestore.childPid !== runningStartedState.childPid) {
    throw new Error(
      `Expected running app child pid to remain unchanged on restore skip, before=${runningStartedState.childPid} after=${runningAfterRestore.childPid}`,
    );
  }

  const runningStatusAfterRestore = await run(["status", runningAppName], { allowFailure: true });
  if (runningStatusAfterRestore.code !== 0) {
    throw new Error(
      `Expected running app to remain healthy after restore skip.\nstdout:\n${runningStatusAfterRestore.stdout}\nstderr:\n${runningStatusAfterRestore.stderr}`,
    );
  }

  if (!runningStatusAfterRestore.stdout.includes(`App ${runningAppName} is running.`)) {
    throw new Error(
      `Expected running app status to remain running after restore.\nstdout:\n${runningStatusAfterRestore.stdout}\nstderr:\n${runningStatusAfterRestore.stderr}`,
    );
  }

  if (!runningStatusAfterRestore.stdout.includes(`- supervisor: alive (pid ${runningAfterRestore.supervisorPid})`)) {
    throw new Error(
      `Expected running app supervisor pid ${runningAfterRestore.supervisorPid} to remain active after restore skip.\nstdout:\n${runningStatusAfterRestore.stdout}\nstderr:\n${runningStatusAfterRestore.stderr}`,
    );
  }

  if (!runningStatusAfterRestore.stdout.includes(`- child: alive (pid ${runningAfterRestore.childPid})`)) {
    throw new Error(
      `Expected running app child pid ${runningAfterRestore.childPid} to remain active after restore skip.\nstdout:\n${runningStatusAfterRestore.stdout}\nstderr:\n${runningStatusAfterRestore.stderr}`,
    );
  }

  if (!runningStatusAfterRestore.stdout.includes("- health: ok")) {
    throw new Error(
      `Expected running app health output after mixed restore.\nstdout:\n${runningStatusAfterRestore.stdout}\nstderr:\n${runningStatusAfterRestore.stderr}`,
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
