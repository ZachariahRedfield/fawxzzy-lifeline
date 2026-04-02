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
const stoppedAppName = `runtime-smoke-restore-mixed-stopped-${uniqueSuffix}`;
const relaunchPort = 7600 + Math.floor(Math.random() * 400);
const stoppedPort = 8200 + Math.floor(Math.random() * 400);

let relaunchManifestPath = "fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml";
let stoppedManifestPath = "fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml";
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

async function waitForStoppedWithHistory(appName) {
  for (let i = 0; i < 60; i += 1) {
    const status = await run(["status", appName], { allowFailure: true });
    const state = await readRuntimeState(appName);
    const childStoppedOrDead =
      status.stdout.includes("- child: dead") || status.stdout.includes("- child: stopped");

    if (
      status.code !== 0 &&
      status.stdout.includes(`App ${appName} is stopped.`) &&
      childStoppedOrDead &&
      status.stdout.includes("- portOwner: none") &&
      state?.lastKnownStatus === "stopped"
    ) {
      return { status, state };
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const latestStatus = await run(["status", appName], { allowFailure: true });
  throw new Error(
    `Timed out waiting for stopped status output with persisted history (${appName}).\nstdout:\n${latestStatus.stdout}\nstderr:\n${latestStatus.stderr}`,
  );
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

  const stoppedFixtureDir = path.join(tempRootDir, "runtime-smoke-app-stopped");
  await cp("fixtures/runtime-smoke-app", stoppedFixtureDir, { recursive: true });

  const stoppedEnvPath = path.join(stoppedFixtureDir, ".env.runtime");
  const stoppedEnvRaw = await readFile(stoppedEnvPath, "utf8");
  await writeFile(stoppedEnvPath, stoppedEnvRaw.replace(/^PORT=.*$/m, `PORT=${stoppedPort}`), "utf8");

  const stoppedTempManifestPath = path.join(stoppedFixtureDir, "runtime-smoke-app.lifeline.yml");
  const stoppedManifestRaw = await readFile(stoppedTempManifestPath, "utf8");
  const manifestForStoppedHistory = stoppedManifestRaw
    .replace(/^name: .*$/m, `name: ${stoppedAppName}`)
    .replace(/^port: .*$/m, `port: ${stoppedPort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never")
    .replace(/^  restorable: .*$/m, "  restorable: true");
  await writeFile(stoppedTempManifestPath, manifestForStoppedHistory, "utf8");
  stoppedManifestPath = stoppedTempManifestPath;
}

async function cleanup() {
  await run(["down", relaunchAppName], { allowFailure: true });
  await run(["down", stoppedAppName], { allowFailure: true });
}

try {
  await prepareFixtureConfig();
  await cleanup();

  await run(["up", relaunchManifestPath]);
  await run(["up", stoppedManifestPath]);

  const relaunchStartedState = await waitForRunning(relaunchAppName);
  const stoppedStartedState = await waitForRunning(stoppedAppName);

  if (relaunchStartedState.lastKnownStatus !== "running" || !relaunchStartedState.restorable) {
    throw new Error(
      `Expected relaunch app to have persisted running+restorable state before runtime loss, found ${JSON.stringify(relaunchStartedState)}`,
    );
  }

  process.kill(relaunchStartedState.supervisorPid, "SIGKILL");
  await waitForPidExit(relaunchStartedState.supervisorPid);
  process.kill(relaunchStartedState.childPid, "SIGKILL");
  await waitForPidExit(relaunchStartedState.childPid);
  await waitForPortRelease(relaunchPort);

  process.kill(stoppedStartedState.childPid, "SIGKILL");
  await waitForPidExit(stoppedStartedState.childPid);

  const stoppedSnapshot = await waitForStoppedWithHistory(stoppedAppName);
  const stoppedBeforeRestore = stoppedSnapshot.state;
  if (!stoppedBeforeRestore) {
    throw new Error("Expected stopped app to keep persisted history before restore");
  }

  const relaunchBeforeRestore = await readRuntimeState(relaunchAppName);
  if (!relaunchBeforeRestore) {
    throw new Error("Expected relaunch app to keep persisted state before restore");
  }

  if (relaunchBeforeRestore.lastKnownStatus !== "running" || !relaunchBeforeRestore.restorable) {
    throw new Error(
      `Expected stale running+restorable state for relaunch app before restore, found ${JSON.stringify(relaunchBeforeRestore)}`,
    );
  }

  if (stoppedBeforeRestore.lastKnownStatus !== "stopped") {
    throw new Error(
      `Expected stopped app persisted status to settle to stopped before restore, found ${stoppedBeforeRestore.lastKnownStatus}`,
    );
  }

  const stoppedPortReleasedBeforeRestore = await canBindPort(stoppedPort);
  if (!stoppedPortReleasedBeforeRestore) {
    throw new Error(`Expected stopped app port ${stoppedPort} to be free before restore`);
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
      `Skipping ${stoppedAppName}: last known status is stopped; not restorable as running.`,
    )
  ) {
    throw new Error(
      `Expected restore output to explicitly skip stopped app in mixed batch.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
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

  if (restoreResult.stdout.includes(`No runtime state found for ${stoppedAppName}`)) {
    throw new Error(
      `Expected stopped app not to hit no-history confusion in mixed restore.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
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

  const relaunchStatusAfterRestore = await run(["status", relaunchAppName], {
    allowFailure: true,
  });
  if (relaunchStatusAfterRestore.code !== 0) {
    throw new Error(
      `Expected relaunch app to be healthy after restore.\nstdout:\n${relaunchStatusAfterRestore.stdout}\nstderr:\n${relaunchStatusAfterRestore.stderr}`,
    );
  }

  if (!relaunchStatusAfterRestore.stdout.includes(`App ${relaunchAppName} is running.`)) {
    throw new Error(
      `Expected relaunch app status to be running after restore.\nstdout:\n${relaunchStatusAfterRestore.stdout}\nstderr:\n${relaunchStatusAfterRestore.stderr}`,
    );
  }

  if (
    !relaunchStatusAfterRestore.stdout.includes(`- portOwner: pid ${relaunchAfterRestore.childPid}`)
  ) {
    throw new Error(
      `Expected relaunch managed child pid ${relaunchAfterRestore.childPid} to own runtime port.\nstdout:\n${relaunchStatusAfterRestore.stdout}\nstderr:\n${relaunchStatusAfterRestore.stderr}`,
    );
  }

  if (!relaunchStatusAfterRestore.stdout.includes("- health: ok")) {
    throw new Error(
      `Expected relaunch app health output after mixed restore.\nstdout:\n${relaunchStatusAfterRestore.stdout}\nstderr:\n${relaunchStatusAfterRestore.stderr}`,
    );
  }

  const stoppedAfterRestore = await readRuntimeState(stoppedAppName);
  if (!stoppedAfterRestore) {
    throw new Error("Expected stopped app persisted state to remain after restore skip");
  }

  if (stoppedAfterRestore.lastKnownStatus !== "stopped") {
    throw new Error(
      `Expected stopped app to remain stopped after restore skip, found ${stoppedAfterRestore.lastKnownStatus}`,
    );
  }

  if (stoppedAfterRestore.supervisorPid !== stoppedBeforeRestore.supervisorPid) {
    throw new Error(
      `Expected stopped app supervisor pid to remain unchanged on restore skip, before=${stoppedBeforeRestore.supervisorPid} after=${stoppedAfterRestore.supervisorPid}`,
    );
  }

  if (stoppedAfterRestore.childPid !== stoppedBeforeRestore.childPid) {
    throw new Error(
      `Expected stopped app child pid to remain unchanged on restore skip, before=${stoppedBeforeRestore.childPid} after=${stoppedAfterRestore.childPid}`,
    );
  }

  if (isPidAlive(stoppedAfterRestore.supervisorPid)) {
    throw new Error(
      `Expected stopped app supervisor to remain offline, but pid ${stoppedAfterRestore.supervisorPid} is alive`,
    );
  }

  if (isPidAlive(stoppedAfterRestore.childPid)) {
    throw new Error(
      `Expected stopped app child to remain offline, but pid ${stoppedAfterRestore.childPid} is alive`,
    );
  }

  const stoppedPortReleasedAfterRestore = await canBindPort(stoppedPort);
  if (!stoppedPortReleasedAfterRestore) {
    throw new Error(`Expected stopped app port ${stoppedPort} to remain free after restore skip`);
  }

  const stoppedStatusAfterRestore = await run(["status", stoppedAppName], { allowFailure: true });
  if (
    stoppedStatusAfterRestore.code === 0 ||
    !stoppedStatusAfterRestore.stdout.includes(`App ${stoppedAppName} is stopped.`)
  ) {
    throw new Error(
      `Expected stopped app status to remain stopped after mixed restore.\nstdout:\n${stoppedStatusAfterRestore.stdout}\nstderr:\n${stoppedStatusAfterRestore.stderr}`,
    );
  }

  if (stoppedStatusAfterRestore.stdout.includes("No runtime state found")) {
    throw new Error(
      `Expected stopped app status not to report no-history confusion after mixed restore.\nstdout:\n${stoppedStatusAfterRestore.stdout}\nstderr:\n${stoppedStatusAfterRestore.stderr}`,
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
