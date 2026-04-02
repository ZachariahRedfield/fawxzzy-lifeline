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
const nonRestorableAppName = `runtime-smoke-restore-mixed-non-restorable-${uniqueSuffix}`;
const relaunchPort = 7600 + Math.floor(Math.random() * 400);
const nonRestorablePort = 8200 + Math.floor(Math.random() * 400);

let relaunchManifestPath = "fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml";
let nonRestorableManifestPath = "fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml";
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

  const nonRestorableFixtureDir = path.join(tempRootDir, "runtime-smoke-app-non-restorable");
  await cp("fixtures/runtime-smoke-app", nonRestorableFixtureDir, { recursive: true });

  const nonRestorableEnvPath = path.join(nonRestorableFixtureDir, ".env.runtime");
  const nonRestorableEnvRaw = await readFile(nonRestorableEnvPath, "utf8");
  await writeFile(
    nonRestorableEnvPath,
    nonRestorableEnvRaw.replace(/^PORT=.*$/m, `PORT=${nonRestorablePort}`),
    "utf8",
  );

  const nonRestorableTempManifestPath = path.join(
    nonRestorableFixtureDir,
    "runtime-smoke-app.lifeline.yml",
  );
  const nonRestorableManifestRaw = await readFile(nonRestorableTempManifestPath, "utf8");
  const manifestForNonRestorable = nonRestorableManifestRaw
    .replace(/^name: .*$/m, `name: ${nonRestorableAppName}`)
    .replace(/^port: .*$/m, `port: ${nonRestorablePort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never")
    .replace(/^  restorable: .*$/m, "  restorable: false");
  await writeFile(nonRestorableTempManifestPath, manifestForNonRestorable, "utf8");
  nonRestorableManifestPath = nonRestorableTempManifestPath;
}

async function cleanup() {
  await run(["down", relaunchAppName], { allowFailure: true });
  await run(["down", nonRestorableAppName], { allowFailure: true });
}

try {
  await prepareFixtureConfig();
  await cleanup();

  await run(["up", relaunchManifestPath]);
  await run(["up", nonRestorableManifestPath]);

  const relaunchStartedState = await waitForRunning(relaunchAppName);
  const nonRestorableStartedState = await waitForRunning(nonRestorableAppName);

  if (relaunchStartedState.lastKnownStatus !== "running" || !relaunchStartedState.restorable) {
    throw new Error(
      `Expected relaunch app to have persisted running+restorable state before runtime loss, found ${JSON.stringify(relaunchStartedState)}`,
    );
  }

  if (nonRestorableStartedState.lastKnownStatus !== "running" || nonRestorableStartedState.restorable) {
    throw new Error(
      `Expected non-restorable app to have persisted running+non-restorable state before runtime loss, found ${JSON.stringify(nonRestorableStartedState)}`,
    );
  }

  process.kill(relaunchStartedState.supervisorPid, "SIGKILL");
  await waitForPidExit(relaunchStartedState.supervisorPid);
  process.kill(relaunchStartedState.childPid, "SIGKILL");
  await waitForPidExit(relaunchStartedState.childPid);
  await waitForPortRelease(relaunchPort);

  process.kill(nonRestorableStartedState.supervisorPid, "SIGKILL");
  await waitForPidExit(nonRestorableStartedState.supervisorPid);
  process.kill(nonRestorableStartedState.childPid, "SIGKILL");
  await waitForPidExit(nonRestorableStartedState.childPid);
  await waitForPortRelease(nonRestorablePort);

  const relaunchBeforeRestore = await readRuntimeState(relaunchAppName);
  if (!relaunchBeforeRestore) {
    throw new Error("Expected relaunch app to keep persisted state before restore");
  }

  if (relaunchBeforeRestore.lastKnownStatus !== "running" || !relaunchBeforeRestore.restorable) {
    throw new Error(
      `Expected stale running+restorable state for relaunch app before restore, found ${JSON.stringify(relaunchBeforeRestore)}`,
    );
  }

  const nonRestorableBeforeRestore = await readRuntimeState(nonRestorableAppName);
  if (!nonRestorableBeforeRestore) {
    throw new Error("Expected non-restorable app to keep persisted state before restore");
  }

  if (
    nonRestorableBeforeRestore.lastKnownStatus !== "running" ||
    nonRestorableBeforeRestore.restorable
  ) {
    throw new Error(
      `Expected stale running+non-restorable state for non-restorable app before restore, found ${JSON.stringify(nonRestorableBeforeRestore)}`,
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
      `Skipping ${nonRestorableAppName}: app is marked restorable: false; skipping restore.`,
    )
  ) {
    throw new Error(
      `Expected restore output to explicitly skip non-restorable app in mixed batch.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
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

  if (restoreResult.stdout.includes(`No runtime state found for ${nonRestorableAppName}`)) {
    throw new Error(
      `Expected non-restorable app not to hit no-history confusion in mixed restore.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
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

  const nonRestorableAfterRestore = await readRuntimeState(nonRestorableAppName);
  if (!nonRestorableAfterRestore) {
    throw new Error("Expected non-restorable app persisted state to remain after restore skip");
  }

  if (nonRestorableAfterRestore.restorable !== false) {
    throw new Error(
      `Expected non-restorable app to stay non-restorable after restore skip, found restorable=${nonRestorableAfterRestore.restorable}`,
    );
  }

  if (nonRestorableAfterRestore.lastKnownStatus !== "running") {
    throw new Error(
      `Expected non-restorable app last-known status to remain stale running after restore skip, found ${nonRestorableAfterRestore.lastKnownStatus}`,
    );
  }

  if (nonRestorableAfterRestore.supervisorPid !== nonRestorableBeforeRestore.supervisorPid) {
    throw new Error(
      `Expected non-restorable app supervisor pid to remain unchanged on restore skip, before=${nonRestorableBeforeRestore.supervisorPid} after=${nonRestorableAfterRestore.supervisorPid}`,
    );
  }

  if (nonRestorableAfterRestore.childPid !== nonRestorableBeforeRestore.childPid) {
    throw new Error(
      `Expected non-restorable app child pid to remain unchanged on restore skip, before=${nonRestorableBeforeRestore.childPid} after=${nonRestorableAfterRestore.childPid}`,
    );
  }

  if (isPidAlive(nonRestorableAfterRestore.supervisorPid)) {
    throw new Error(
      `Expected non-restorable app supervisor to remain offline, but pid ${nonRestorableAfterRestore.supervisorPid} is alive`,
    );
  }

  if (isPidAlive(nonRestorableAfterRestore.childPid)) {
    throw new Error(
      `Expected non-restorable app child to remain offline, but pid ${nonRestorableAfterRestore.childPid} is alive`,
    );
  }

  const nonRestorablePortReleasedAfterRestore = await canBindPort(nonRestorablePort);
  if (!nonRestorablePortReleasedAfterRestore) {
    throw new Error(`Expected non-restorable app port ${nonRestorablePort} to remain free after restore skip`);
  }

  const nonRestorableStatusAfterRestore = await run(["status", nonRestorableAppName], {
    allowFailure: true,
  });
  if (nonRestorableStatusAfterRestore.code === 0) {
    throw new Error(
      `Expected non-restorable app to remain stopped after restore skip.\nstdout:\n${nonRestorableStatusAfterRestore.stdout}\nstderr:\n${nonRestorableStatusAfterRestore.stderr}`,
    );
  }

  if (!nonRestorableStatusAfterRestore.stdout.includes(`App ${nonRestorableAppName} is stopped.`)) {
    throw new Error(
      `Expected non-restorable app status to remain stopped after mixed restore.\nstdout:\n${nonRestorableStatusAfterRestore.stdout}\nstderr:\n${nonRestorableStatusAfterRestore.stderr}`,
    );
  }

  if (nonRestorableStatusAfterRestore.stdout.includes("No runtime state found")) {
    throw new Error(
      `Expected non-restorable app status not to report no-history confusion after mixed restore.\nstdout:\n${nonRestorableStatusAfterRestore.stdout}\nstderr:\n${nonRestorableStatusAfterRestore.stderr}`,
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
