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
const appName = `runtime-smoke-restart-stopped-supervisor-kill-${uniqueSuffix}`;
const runtimePort = 7000 + Math.floor(Math.random() * 1000);

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
  for (let i = 0; i < 80; i += 1) {
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
    "running state with live supervisor and managed child",
  );
}

async function waitForPidExit(pid) {
  for (let i = 0; i < 50; i += 1) {
    if (!isPidAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for pid ${pid} to exit`);
}

async function waitForStoppedStatus() {
  for (let i = 0; i < 50; i += 1) {
    const status = await run(["status", appName], { allowFailure: true });
    if (status.code !== 0 && status.stdout.includes(`App ${appName} is stopped.`)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const latestStatus = await run(["status", appName], { allowFailure: true });
  throw new Error(
    `Timed out waiting for stopped status after supervisor kill.\nstatus:\n${latestStatus.stdout}\n${latestStatus.stderr}`,
  );
}

async function waitForPortOwnedByRuntime(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await canBindPort(runtimePort))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Expected runtime to own managed port ${runtimePort} after restart`);
}

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-restart-stopped-supervisor-kill-smoke-"));
  const tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");

  await cp("fixtures/runtime-smoke-app", tempFixtureDir, { recursive: true });

  const envPath = path.join(tempFixtureDir, ".env.runtime");
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(envPath, envRaw.replace(/^PORT=.*$/m, `PORT=${runtimePort}`), "utf8");

  const tempManifestPath = path.join(tempFixtureDir, "runtime-smoke-app.lifeline.yml");
  const manifestRaw = await readFile(tempManifestPath, "utf8");

  const manifestForScenario = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never");

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
  const runningState = await waitForRunning();

  if (!runningState.supervisorPid || !isPidAlive(runningState.supervisorPid)) {
    throw new Error("Expected running state with live supervisor before kill");
  }

  process.kill(runningState.supervisorPid, "SIGKILL");
  await waitForPidExit(runningState.supervisorPid);

  if (runningState.childPid && isPidAlive(runningState.childPid)) {
    process.kill(runningState.childPid, "SIGKILL");
    await waitForPidExit(runningState.childPid);
  }

  await waitForStoppedStatus();

  const persistedAfterStop = await readRuntimeState();
  if (!persistedAfterStop) {
    throw new Error("Expected persisted runtime state after stopped status refresh");
  }

  if (persistedAfterStop.lastKnownStatus === "running") {
    throw new Error(
      `Expected persisted runtime state to be non-running after supervisor kill, got ${persistedAfterStop.lastKnownStatus}`,
    );
  }

  const restartResult = await run(["restart", appName], { allowFailure: true });
  if (restartResult.code !== 0) {
    throw new Error(
      `Expected restart to succeed from stopped-with-history settle.\nstdout:\n${restartResult.stdout}\nstderr:\n${restartResult.stderr}`,
    );
  }

  if (restartResult.stderr.includes(`No runtime state found for app ${appName}.`)) {
    throw new Error(
      `Expected restart not to take no-history path after supervisor kill.\nstdout:\n${restartResult.stdout}\nstderr:\n${restartResult.stderr}`,
    );
  }

  const stateAfterRestart = await waitForRunning();
  await waitForPortOwnedByRuntime();

  if (stateAfterRestart.port !== runtimePort) {
    throw new Error(
      `Expected persisted runtime port to remain coherent after restart. expected=${runtimePort}, actual=${stateAfterRestart.port}`,
    );
  }

  if (stateAfterRestart.lastKnownStatus !== "running") {
    throw new Error(
      `Expected persisted runtime state to converge to running after restart, got ${stateAfterRestart.lastKnownStatus}`,
    );
  }

  if (!stateAfterRestart.supervisorPid || !isPidAlive(stateAfterRestart.supervisorPid)) {
    throw new Error("Expected restarted runtime to have a live supervisor pid");
  }

  if (!stateAfterRestart.childPid || !isPidAlive(stateAfterRestart.childPid)) {
    throw new Error("Expected restarted runtime to have a live child pid");
  }

  const statusAfterRestart = await run(["status", appName], { allowFailure: true });
  if (!statusAfterRestart.stdout.includes(`App ${appName} is running`)) {
    throw new Error(
      `Expected status to report running after restart.\nstdout:\n${statusAfterRestart.stdout}\nstderr:\n${statusAfterRestart.stderr}`,
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
