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
const appNameRunning = `runtime-smoke-restore-mixed-running-${uniqueSuffix}`;
const appNameStopped = `runtime-smoke-restore-mixed-stopped-${uniqueSuffix}`;
const runtimePortRunning = 8000 + Math.floor(Math.random() * 900);
const runtimePortStopped = runtimePortRunning + 1000;

let manifestPathRunning = "fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml";
let manifestPathStopped = "fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml";
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
    `Timed out waiting for stopped status output with persisted history for ${appName}.\nstdout:\n${latestStatus.stdout}\nstderr:\n${latestStatus.stderr}`,
  );
}

async function createFixtureManifest({ appName, runtimePort, fixtureSubdir }) {
  const tempFixtureDir = path.join(tempRootDir, fixtureSubdir);

  await cp("fixtures/runtime-smoke-app", tempFixtureDir, { recursive: true });

  const envPath = path.join(tempFixtureDir, ".env.runtime");
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(envPath, envRaw.replace(/^PORT=.*$/m, `PORT=${runtimePort}`), "utf8");

  const tempManifestPath = path.join(tempFixtureDir, "runtime-smoke-app.lifeline.yml");
  const manifestRaw = await readFile(tempManifestPath, "utf8");
  const nextManifest = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never")
    .replace(/^  restorable: .*$/m, "  restorable: true");

  await writeFile(tempManifestPath, nextManifest, "utf8");
  return tempManifestPath;
}

async function prepareFixtureConfigs() {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-restore-mixed-smoke-"));
  manifestPathRunning = await createFixtureManifest({
    appName: appNameRunning,
    runtimePort: runtimePortRunning,
    fixtureSubdir: "runtime-smoke-app-running",
  });
  manifestPathStopped = await createFixtureManifest({
    appName: appNameStopped,
    runtimePort: runtimePortStopped,
    fixtureSubdir: "runtime-smoke-app-stopped",
  });
}

async function cleanup() {
  await run(["down", appNameRunning], { allowFailure: true });
  await run(["down", appNameStopped], { allowFailure: true });
}

try {
  await prepareFixtureConfigs();
  await cleanup();

  await run(["up", manifestPathRunning]);
  const runningStartedState = await waitForRunning(appNameRunning);

  process.kill(runningStartedState.supervisorPid, "SIGKILL");
  await waitForPidExit(runningStartedState.supervisorPid);
  process.kill(runningStartedState.childPid, "SIGKILL");
  await waitForPidExit(runningStartedState.childPid);
  await waitForPortRelease(runtimePortRunning);

  const runningPersistedBeforeRestore = await readRuntimeState(appNameRunning);
  if (
    !runningPersistedBeforeRestore ||
    runningPersistedBeforeRestore.lastKnownStatus !== "running" ||
    !runningPersistedBeforeRestore.restorable
  ) {
    throw new Error(
      `Expected stale restorable running state for ${appNameRunning} before restore, found ${JSON.stringify(runningPersistedBeforeRestore)}`,
    );
  }

  await run(["up", manifestPathStopped]);
  const stoppedStartedState = await waitForRunning(appNameStopped);

  process.kill(stoppedStartedState.childPid, "SIGKILL");
  await waitForPidExit(stoppedStartedState.childPid);
  const stoppedSnapshot = await waitForStoppedWithHistory(appNameStopped);
  const stoppedPersistedBeforeRestore = stoppedSnapshot.state;
  if (!stoppedPersistedBeforeRestore || stoppedPersistedBeforeRestore.lastKnownStatus !== "stopped") {
    throw new Error(
      `Expected stopped-with-history state for ${appNameStopped} before restore, found ${JSON.stringify(stoppedPersistedBeforeRestore)}`,
    );
  }

  const restoreResult = await run(["restore"], { allowFailure: true });
  if (restoreResult.code !== 0) {
    throw new Error(
      `Expected mixed restore command to succeed.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (!restoreResult.stdout.includes(`Restored ${appNameRunning} with supervisor pid`)) {
    throw new Error(
      `Expected restore output to relaunch eligible app ${appNameRunning}.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (
    !restoreResult.stdout.includes(
      `Skipping ${appNameStopped}: last known status is stopped; not restorable as running.`,
    )
  ) {
    throw new Error(
      `Expected restore output to skip stopped app ${appNameStopped}.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (restoreResult.stdout.includes("No managed apps found in .lifeline/state.json.")) {
    throw new Error(
      `Expected restore not to misclassify mixed state as no-history.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  const runningRestoredState = await waitForRunning(appNameRunning);
  if (runningRestoredState.supervisorPid === runningStartedState.supervisorPid) {
    throw new Error(`Expected ${appNameRunning} to receive a new supervisor pid after restore`);
  }

  if (runningRestoredState.childPid === runningStartedState.childPid) {
    throw new Error(`Expected ${appNameRunning} to receive a new child pid after restore`);
  }

  const runningStatusAfterRestore = await run(["status", appNameRunning], { allowFailure: true });
  if (runningStatusAfterRestore.code !== 0) {
    throw new Error(
      `Expected running status for restored app ${appNameRunning}.\nstdout:\n${runningStatusAfterRestore.stdout}\nstderr:\n${runningStatusAfterRestore.stderr}`,
    );
  }

  if (!runningStatusAfterRestore.stdout.includes(`App ${appNameRunning} is running.`)) {
    throw new Error(
      `Expected restored app ${appNameRunning} to report running status.\nstdout:\n${runningStatusAfterRestore.stdout}\nstderr:\n${runningStatusAfterRestore.stderr}`,
    );
  }

  if (!runningStatusAfterRestore.stdout.includes(`- portOwner: pid ${runningRestoredState.childPid}`)) {
    throw new Error(
      `Expected restored app ${appNameRunning} child pid ${runningRestoredState.childPid} to own the managed port.\nstdout:\n${runningStatusAfterRestore.stdout}\nstderr:\n${runningStatusAfterRestore.stderr}`,
    );
  }

  if (!runningStatusAfterRestore.stdout.includes("- health: ok")) {
    throw new Error(
      `Expected restored app ${appNameRunning} to be healthy.\nstdout:\n${runningStatusAfterRestore.stdout}\nstderr:\n${runningStatusAfterRestore.stderr}`,
    );
  }

  if (runningStatusAfterRestore.stdout.includes("No runtime state found")) {
    throw new Error(
      `Expected restored app ${appNameRunning} status to avoid no-history confusion.\nstdout:\n${runningStatusAfterRestore.stdout}\nstderr:\n${runningStatusAfterRestore.stderr}`,
    );
  }

  const stoppedPersistedAfterRestore = await readRuntimeState(appNameStopped);
  if (!stoppedPersistedAfterRestore || stoppedPersistedAfterRestore.lastKnownStatus !== "stopped") {
    throw new Error(
      `Expected stopped app ${appNameStopped} to remain stopped in persisted state after restore, found ${JSON.stringify(stoppedPersistedAfterRestore)}`,
    );
  }

  if (stoppedPersistedAfterRestore.supervisorPid !== stoppedPersistedBeforeRestore.supervisorPid) {
    throw new Error(
      `Expected stopped app ${appNameStopped} not to receive a new supervisor pid. before=${stoppedPersistedBeforeRestore.supervisorPid} after=${stoppedPersistedAfterRestore.supervisorPid}`,
    );
  }

  if (stoppedPersistedAfterRestore.childPid !== stoppedPersistedBeforeRestore.childPid) {
    throw new Error(
      `Expected stopped app ${appNameStopped} not to receive a new child pid. before=${stoppedPersistedBeforeRestore.childPid} after=${stoppedPersistedAfterRestore.childPid}`,
    );
  }

  if (isPidAlive(stoppedPersistedAfterRestore.supervisorPid)) {
    throw new Error(
      `Expected stopped app ${appNameStopped} supervisor pid ${stoppedPersistedAfterRestore.supervisorPid} to remain offline`,
    );
  }

  if (isPidAlive(stoppedPersistedAfterRestore.childPid)) {
    throw new Error(
      `Expected stopped app ${appNameStopped} child pid ${stoppedPersistedAfterRestore.childPid} to remain offline`,
    );
  }

  const stoppedPortReleasedAfterRestore = await canBindPort(runtimePortStopped);
  if (!stoppedPortReleasedAfterRestore) {
    throw new Error(`Expected stopped app ${appNameStopped} port ${runtimePortStopped} to remain free`);
  }

  const stoppedStatusAfterRestore = await run(["status", appNameStopped], { allowFailure: true });
  if (
    stoppedStatusAfterRestore.code === 0 ||
    !stoppedStatusAfterRestore.stdout.includes(`App ${appNameStopped} is stopped.`)
  ) {
    throw new Error(
      `Expected stopped app ${appNameStopped} status to remain stopped after restore.\nstdout:\n${stoppedStatusAfterRestore.stdout}\nstderr:\n${stoppedStatusAfterRestore.stderr}`,
    );
  }

  if (stoppedStatusAfterRestore.stdout.includes("No runtime state found")) {
    throw new Error(
      `Expected stopped app ${appNameStopped} status to avoid no-history confusion.\nstdout:\n${stoppedStatusAfterRestore.stdout}\nstderr:\n${stoppedStatusAfterRestore.stderr}`,
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
