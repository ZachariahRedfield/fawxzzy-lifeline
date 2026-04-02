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
const fixtureEnv = ".env.runtime";
const fixturePlaybookPath = "fixtures/playbook-export";

const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const appAName = `runtime-smoke-restore-mixed-success-${uniqueSuffix}`;
const appBName = `runtime-smoke-restore-mixed-failure-${uniqueSuffix}`;
const appAPort = 9300 + Math.floor(Math.random() * 200);
const appBPort = 9600 + Math.floor(Math.random() * 200);

let tempRootDir;
let appAManifestPath;
let appBManifestPath;

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

async function waitForPortRelease(port) {
  for (let i = 0; i < 40; i += 1) {
    if (await canBindPort(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Expected managed port ${port} to be free after runtime loss`);
}

async function readStateFile() {
  const raw = await readFile(statePath, "utf8").catch(() => "");
  return raw ? JSON.parse(raw) : { apps: {} };
}

async function readRuntimeState(appName) {
  const parsed = await readStateFile();
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

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-restore-mixed-smoke-"));

  const appAFixtureDir = path.join(tempRootDir, "runtime-smoke-app-a");
  const appBFixtureDir = path.join(tempRootDir, "runtime-smoke-app-b");
  await cp(fixtureDir, appAFixtureDir, { recursive: true });
  await cp(fixtureDir, appBFixtureDir, { recursive: true });

  const appAEnvPath = path.join(appAFixtureDir, fixtureEnv);
  const appAEnvRaw = await readFile(appAEnvPath, "utf8");
  await writeFile(appAEnvPath, appAEnvRaw.replace(/^PORT=.*$/m, `PORT=${appAPort}`), "utf8");

  const appBEnvPath = path.join(appBFixtureDir, fixtureEnv);
  const appBEnvRaw = await readFile(appBEnvPath, "utf8");
  await writeFile(appBEnvPath, appBEnvRaw.replace(/^PORT=.*$/m, `PORT=${appBPort}`), "utf8");

  const appATempManifestPath = path.join(appAFixtureDir, "runtime-smoke-app.lifeline.yml");
  const appAManifestRaw = await readFile(appATempManifestPath, "utf8");
  const appAManifestForRestore = appAManifestRaw
    .replace(/^name: .*$/m, `name: ${appAName}`)
    .replace(/^port: .*$/m, `port: ${appAPort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never")
    .replace(/^  restorable: .*$/m, "  restorable: true");
  await writeFile(appATempManifestPath, appAManifestForRestore, "utf8");
  appAManifestPath = appATempManifestPath;

  const appBTempManifestPath = path.join(appBFixtureDir, "runtime-smoke-app.playbook.lifeline.yml");
  const appBManifestRaw = await readFile(appBTempManifestPath, "utf8");
  const appBManifestForRestore = appBManifestRaw
    .replace(/^name: .*$/m, `name: ${appBName}`)
    .replace(/^port: .*$/m, `port: ${appBPort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never")
    .replace(/^  restorable: .*$/m, "  restorable: true");
  await writeFile(appBTempManifestPath, appBManifestForRestore, "utf8");
  appBManifestPath = appBTempManifestPath;
}

async function cleanup() {
  await run(["down", appAName], { allowFailure: true });
  await run(["down", appBName], { allowFailure: true });
}

try {
  await prepareFixtureConfig();
  await cleanup();

  await run(["up", appAManifestPath]);
  await run(["up", appBManifestPath, "--playbook-path", fixturePlaybookPath]);

  const appAStarted = await waitForRunning(appAName);
  const appBStarted = await waitForRunning(appBName);

  process.kill(appAStarted.supervisorPid, "SIGKILL");
  await waitForPidExit(appAStarted.supervisorPid);
  process.kill(appAStarted.childPid, "SIGKILL");
  await waitForPidExit(appAStarted.childPid);

  process.kill(appBStarted.supervisorPid, "SIGKILL");
  await waitForPidExit(appBStarted.supervisorPid);
  process.kill(appBStarted.childPid, "SIGKILL");
  await waitForPidExit(appBStarted.childPid);

  await waitForPortRelease(appAPort);
  await waitForPortRelease(appBPort);

  const persistedBeforeRestore = await readStateFile();
  const appAPersisted = persistedBeforeRestore?.apps?.[appAName];
  const appBPersisted = persistedBeforeRestore?.apps?.[appBName];
  if (!appAPersisted || !appBPersisted) {
    throw new Error("Expected persisted runtime states for both apps before restore");
  }

  if (appAPersisted.lastKnownStatus !== "running" || !appAPersisted.restorable) {
    throw new Error(`Expected app A to be stale running+restorable, found ${JSON.stringify(appAPersisted)}`);
  }

  if (appBPersisted.lastKnownStatus !== "running" || !appBPersisted.restorable) {
    throw new Error(`Expected app B to be stale running+restorable, found ${JSON.stringify(appBPersisted)}`);
  }

  const invalidPersistedPlaybookPath = path.join(tempRootDir, "missing-playbook-export");
  persistedBeforeRestore.apps[appBName].playbookPath = invalidPersistedPlaybookPath;
  await writeFile(statePath, JSON.stringify(persistedBeforeRestore, null, 2));

  const restoreResult = await run(["restore"], { allowFailure: true });
  if (restoreResult.code !== 1) {
    throw new Error(
      `Expected restore to return non-zero (1) for mixed success+failure restore.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (!restoreResult.stdout.includes(`Restored ${appAName} with supervisor pid`)) {
    throw new Error(
      `Expected restore output to confirm app A relaunch.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  const combinedOutput = `${restoreResult.stdout}\n${restoreResult.stderr}`;
  if (!combinedOutput.includes(`Failed to restore ${appBName}:`)) {
    throw new Error(
      `Expected restore output to report app B failure.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  const appARestored = await waitForRunning(appAName);
  if (appARestored.supervisorPid === appAStarted.supervisorPid) {
    throw new Error(`Expected app A to relaunch with a new supervisor pid, still ${appARestored.supervisorPid}`);
  }

  const appAStatus = await run(["status", appAName], { allowFailure: true });
  if (appAStatus.code !== 0 || !appAStatus.stdout.includes(`App ${appAName} is running.`)) {
    throw new Error(
      `Expected app A to be running after restore despite app B failure.\nstdout:\n${appAStatus.stdout}\nstderr:\n${appAStatus.stderr}`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 700));

  const appBAfterRestore = await readRuntimeState(appBName);
  if (!appBAfterRestore) {
    throw new Error("Expected app B persisted state to remain after restore failure");
  }

  if (appBAfterRestore.supervisorPid && isPidAlive(appBAfterRestore.supervisorPid)) {
    throw new Error(
      `Expected app B not to relaunch a supervisor after failed restore, found ${appBAfterRestore.supervisorPid}`,
    );
  }

  if (appBAfterRestore.childPid && isPidAlive(appBAfterRestore.childPid)) {
    throw new Error(`Expected app B not to relaunch a child after failed restore, found ${appBAfterRestore.childPid}`);
  }

  if (!(await canBindPort(appBPort))) {
    throw new Error(`Expected app B managed port ${appBPort} to remain free after failed restore`);
  }

  const appBStatus = await run(["status", appBName], { allowFailure: true });
  if (appBStatus.code === 0 || appBStatus.stdout.includes(`App ${appBName} is running.`)) {
    throw new Error(
      `Expected app B to remain not running after restore failure.\nstdout:\n${appBStatus.stdout}\nstderr:\n${appBStatus.stderr}`,
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
