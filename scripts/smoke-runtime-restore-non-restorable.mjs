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
const appName = `runtime-smoke-restore-non-restorable-${uniqueSuffix}`;
const runtimePort = 9500 + Math.floor(Math.random() * 300);

let manifestPath = "fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml";
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
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-restore-non-restorable-smoke-"));
  const tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");

  await cp("fixtures/runtime-smoke-app", tempFixtureDir, { recursive: true });

  const envPath = path.join(tempFixtureDir, ".env.runtime");
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(envPath, envRaw.replace(/^PORT=.*$/m, `PORT=${runtimePort}`), "utf8");

  const tempManifestPath = path.join(tempFixtureDir, "runtime-smoke-app.lifeline.yml");
  const manifestRaw = await readFile(tempManifestPath, "utf8");

  const manifestForNonRestorable = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never")
    .replace(/^  restorable: .*$/m, "  restorable: false");

  await writeFile(tempManifestPath, manifestForNonRestorable, "utf8");
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

  if (startedState.lastKnownStatus !== "running" || startedState.restorable) {
    throw new Error(`Expected persisted running+non-restorable state before runtime loss, found ${JSON.stringify(startedState)}`);
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

  if (persistedBeforeRestore.lastKnownStatus !== "running" || persistedBeforeRestore.restorable) {
    throw new Error(
      `Expected stale running non-restorable state before restore, found ${JSON.stringify(persistedBeforeRestore)}`,
    );
  }

  const restoreResult = await run(["restore"], { allowFailure: true });
  if (restoreResult.code !== 0) {
    throw new Error(
      `Expected restore command to succeed.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (!restoreResult.stdout.includes("No restorable apps required restart.")) {
    throw new Error(
      `Expected restore output to converge to no restorable apps restart message.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (restoreResult.stdout.includes(`Restored ${appName} with supervisor pid`)) {
    throw new Error(
      `Expected restore to hard-skip non-restorable app relaunch.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (restoreResult.stdout.includes("No managed apps found in .lifeline/state.json.")) {
    throw new Error(
      `Expected restore not to confuse persisted non-restorable history with no-history state.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  const persistedAfterRestore = await readRuntimeState();
  if (!persistedAfterRestore) {
    throw new Error("Expected persisted runtime state to remain after non-restorable restore skip");
  }

  if (persistedAfterRestore.restorable !== false) {
    throw new Error(
      `Expected persisted app to stay non-restorable after restore skip, found restorable=${persistedAfterRestore.restorable}`,
    );
  }

  if (persistedAfterRestore.supervisorPid !== persistedBeforeRestore.supervisorPid) {
    throw new Error(
      `Expected no supervisor relaunch on non-restorable restore, before=${persistedBeforeRestore.supervisorPid} after=${persistedAfterRestore.supervisorPid}`,
    );
  }

  if (persistedAfterRestore.childPid !== persistedBeforeRestore.childPid) {
    throw new Error(
      `Expected no child relaunch on non-restorable restore, before=${persistedBeforeRestore.childPid} after=${persistedAfterRestore.childPid}`,
    );
  }

  if (isPidAlive(persistedAfterRestore.supervisorPid)) {
    throw new Error(
      `Expected non-restorable restore to keep supervisor offline, but pid ${persistedAfterRestore.supervisorPid} is alive`,
    );
  }

  if (isPidAlive(persistedAfterRestore.childPid)) {
    throw new Error(
      `Expected non-restorable restore not to relaunch child, but pid ${persistedAfterRestore.childPid} is alive`,
    );
  }

  const portReleasedAfterRestore = await canBindPort(runtimePort);
  if (!portReleasedAfterRestore) {
    throw new Error(`Expected port ${runtimePort} to remain free after non-restorable restore skip`);
  }

  const statusAfterRestore = await run(["status", appName], { allowFailure: true });
  if (statusAfterRestore.code === 0) {
    throw new Error(
      `Expected non-restorable app to remain stopped after restore skip.\nstdout:\n${statusAfterRestore.stdout}\nstderr:\n${statusAfterRestore.stderr}`,
    );
  }

  if (!statusAfterRestore.stdout.includes(`App ${appName} is stopped.`)) {
    throw new Error(
      `Expected stopped status output to confirm no relaunch after restore skip.\nstdout:\n${statusAfterRestore.stdout}\nstderr:\n${statusAfterRestore.stderr}`,
    );
  }

  if (!statusAfterRestore.stdout.includes("- portOwner: none")) {
    throw new Error(
      `Expected stopped status to report free port ownership after restore skip.\nstdout:\n${statusAfterRestore.stdout}\nstderr:\n${statusAfterRestore.stderr}`,
    );
  }

  if (statusAfterRestore.stdout.includes("No runtime state found")) {
    throw new Error(
      `Expected status not to report no-history confusion after non-restorable restore skip.\nstdout:\n${statusAfterRestore.stdout}\nstderr:\n${statusAfterRestore.stderr}`,
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
