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
const fixtureManifest = "runtime-smoke-app.playbook.lifeline.yml";
const fixtureEnv = ".env.runtime";
const fixturePlaybookPath = "fixtures/playbook-export";
const expectedPlaybookPath = path.resolve(fixturePlaybookPath);

const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const appName = `runtime-smoke-restore-invalid-playbook-export-${uniqueSuffix}`;
const runtimePort = 9960 + Math.floor(Math.random() * 20);

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
    path.join(tmpdir(), "lifeline-runtime-restore-invalid-playbook-export-smoke-"),
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

  await run(["up", manifestPath, "--playbook-path", fixturePlaybookPath]);
  const startedState = await waitForRunning();

  if (startedState.playbookPath !== expectedPlaybookPath) {
    throw new Error(
      `Expected persisted playbook path ${expectedPlaybookPath} after initial up, found ${startedState.playbookPath}`,
    );
  }

  const startingSupervisorPid = startedState.supervisorPid;
  const startingChildPid = startedState.childPid;

  process.kill(startedState.supervisorPid, "SIGKILL");
  await waitForPidExit(startedState.supervisorPid);

  process.kill(startedState.childPid, "SIGKILL");
  await waitForPidExit(startedState.childPid);

  await waitForPortRelease();

  const persistedBeforeCorruption = await readStateFile();
  const appStateBeforeCorruption = persistedBeforeCorruption?.apps?.[appName];
  if (!appStateBeforeCorruption) {
    throw new Error("Expected persisted runtime state before playbook export corruption");
  }

  if (appStateBeforeCorruption.playbookPath !== expectedPlaybookPath) {
    throw new Error(
      `Expected persisted playbook path ${expectedPlaybookPath} before corruption, found ${appStateBeforeCorruption.playbookPath}`,
    );
  }

  const corruptedPlaybookPath = path.join(tempRootDir, "playbook-export-corrupted");
  await cp(fixturePlaybookPath, corruptedPlaybookPath, { recursive: true });

  const corruptedArchetypePath = path.join(
    corruptedPlaybookPath,
    "exports",
    "lifeline",
    "archetypes",
    "node-web.yml",
  );
  await writeFile(corruptedArchetypePath, "installCommand: 42\n", "utf8");

  persistedBeforeCorruption.apps[appName].playbookPath = corruptedPlaybookPath;
  await writeFile(statePath, JSON.stringify(persistedBeforeCorruption, null, 2));

  const restoreResult = await run(["restore"], { allowFailure: true });
  if (restoreResult.code === 0) {
    throw new Error(
      `Expected restore to fail when persisted Playbook export shape is invalid.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  const combinedOutput = `${restoreResult.stdout}\n${restoreResult.stderr}`;
  if (!combinedOutput.includes("Playbook export shape is invalid")) {
    throw new Error(
      `Expected restore failure to clearly explain Playbook export validation issue.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (
    combinedOutput.includes(`App ${appName} is running.`) ||
    combinedOutput.includes("- health: ok") ||
    combinedOutput.toLowerCase().includes("restored")
  ) {
    throw new Error(
      `Expected restore failure not to report successful running/healthy restore surface.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 700));

  const persistedAfterRestore = await readRuntimeState();
  if (!persistedAfterRestore) {
    throw new Error("Expected persisted runtime state after restore failure");
  }

  if (persistedAfterRestore.playbookPath !== corruptedPlaybookPath) {
    throw new Error(
      `Expected persisted corrupted playbook path to remain ${corruptedPlaybookPath}, found ${persistedAfterRestore.playbookPath}`,
    );
  }

  if (persistedAfterRestore.lastKnownStatus === "running") {
    throw new Error("Expected persisted state not to flip back to running after failed restore");
  }
  if (persistedAfterRestore.lastKnownStatus !== "stopped") {
    throw new Error(
      `Expected failed restore to reconcile persisted status to stopped, found ${persistedAfterRestore.lastKnownStatus}`,
    );
  }
  if (persistedAfterRestore.crashLoopDetected) {
    throw new Error("Expected failed restore to clear crashLoopDetected");
  }
  if (persistedAfterRestore.blockedReason !== undefined) {
    throw new Error(
      `Expected failed restore to clear blockedReason, found ${persistedAfterRestore.blockedReason}`,
    );
  }
  if (persistedAfterRestore.wrapperPid !== undefined) {
    throw new Error(
      `Expected failed restore to clear wrapperPid, found ${persistedAfterRestore.wrapperPid}`,
    );
  }
  if (persistedAfterRestore.listenerPid !== undefined) {
    throw new Error(
      `Expected failed restore to clear listenerPid, found ${persistedAfterRestore.listenerPid}`,
    );
  }
  if (persistedAfterRestore.portOwnerPid !== undefined) {
    throw new Error(
      `Expected failed restore to clear portOwnerPid, found ${persistedAfterRestore.portOwnerPid}`,
    );
  }

  if (
    persistedAfterRestore.supervisorPid &&
    persistedAfterRestore.supervisorPid !== startingSupervisorPid &&
    isPidAlive(persistedAfterRestore.supervisorPid)
  ) {
    throw new Error(
      `Expected no replacement managed supervisor after restore failure, found pid ${persistedAfterRestore.supervisorPid}`,
    );
  }

  if (
    persistedAfterRestore.childPid &&
    persistedAfterRestore.childPid !== startingChildPid &&
    isPidAlive(persistedAfterRestore.childPid)
  ) {
    throw new Error(
      `Expected no replacement managed child after restore failure, found pid ${persistedAfterRestore.childPid}`,
    );
  }
  if (persistedAfterRestore.childPid !== undefined) {
    throw new Error(
      `Expected failed restore to clear childPid, found ${persistedAfterRestore.childPid}`,
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
