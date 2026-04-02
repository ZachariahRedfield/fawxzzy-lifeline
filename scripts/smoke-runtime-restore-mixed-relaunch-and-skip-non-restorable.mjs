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

async function waitForHealthy(appName) {
  return waitForRuntime(
    appName,
    (state) =>
      state.lastKnownStatus === "running" &&
      isPidAlive(state.supervisorPid) &&
      isPidAlive(state.childPid),
    "healthy running state after restore",
  );
}

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-restore-mixed-non-restorable-smoke-"));

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

  const nonRestorableTempManifestPath = path.join(nonRestorableFixtureDir, "runtime-smoke-app.lifeline.yml");
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
  const nonRestorableBeforeRestore = await readRuntimeState(nonRestorableAppName);

  if (!relaunchBeforeRestore || !nonRestorableBeforeRestore) {
    throw new Error("Expected both apps to retain persisted runtime history before restore");
  }

  const restoreResult = await run(["restore"], { allowFailure: true });
  if (restoreResult.code !== 0) {
    throw new Error(
      `Expected restore command to succeed.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (!restoreResult.stdout.includes(`Restored ${relaunchAppName} with supervisor pid`)) {
    throw new Error(
      `Expected restore output to include relaunch confirmation for restorable app.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  const explicitSkipMessages = [
    `Skipping ${nonRestorableAppName}: restorable: false (explicitly excluded from restore).`,
    `Skipping ${nonRestorableAppName}: app is marked restorable=false.`,
  ];
  if (!explicitSkipMessages.some((message) => restoreResult.stdout.includes(message))) {
    throw new Error(
      `Expected restore output to include explicit non-restorable skip message.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (restoreResult.stdout.includes("No managed apps found in .lifeline/state.json.")) {
    throw new Error(
      `Expected restore not to confuse persisted mixed app history with no-history state.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  const relaunchAfterRestore = await waitForHealthy(relaunchAppName);
  if (
    relaunchAfterRestore.supervisorPid === relaunchBeforeRestore.supervisorPid ||
    relaunchAfterRestore.childPid === relaunchBeforeRestore.childPid
  ) {
    throw new Error(
      `Expected restorable app to relaunch with new runtime pids, before=${JSON.stringify(relaunchBeforeRestore)} after=${JSON.stringify(relaunchAfterRestore)}`,
    );
  }

  const nonRestorableAfterRestore = await readRuntimeState(nonRestorableAppName);
  if (!nonRestorableAfterRestore) {
    throw new Error("Expected non-restorable app history to remain persisted after restore");
  }

  if (nonRestorableAfterRestore.restorable !== false) {
    throw new Error(
      `Expected non-restorable app to remain non-restorable after restore skip, found restorable=${nonRestorableAfterRestore.restorable}`,
    );
  }

  if (
    nonRestorableAfterRestore.supervisorPid !== nonRestorableBeforeRestore.supervisorPid ||
    nonRestorableAfterRestore.childPid !== nonRestorableBeforeRestore.childPid
  ) {
    throw new Error(
      `Expected non-restorable app not to relaunch, before=${JSON.stringify(nonRestorableBeforeRestore)} after=${JSON.stringify(nonRestorableAfterRestore)}`,
    );
  }

  if (isPidAlive(nonRestorableAfterRestore.supervisorPid) || isPidAlive(nonRestorableAfterRestore.childPid)) {
    throw new Error(
      `Expected non-restorable app pids to remain offline after restore skip, supervisorPid=${nonRestorableAfterRestore.supervisorPid} childPid=${nonRestorableAfterRestore.childPid}`,
    );
  }

  await waitForPortRelease(nonRestorablePort);
} finally {
  await cleanup();
  if (tempRootDir) {
    await rm(tempRootDir, { recursive: true, force: true });
  }
}
