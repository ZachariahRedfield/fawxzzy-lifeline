import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const cli = ["node", "dist/cli.js"];
const statePath = ".lifeline/state.json";

const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const appName = `runtime-smoke-logs-stopped-supervisor-kill-${uniqueSuffix}`;
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
    "running state with live supervisor and managed child",
  );
}

async function waitForPidExit(pid) {
  for (let i = 0; i < 40; i += 1) {
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

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-logs-stopped-supervisor-kill-smoke-"));
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

  const startupLogs = await run(["logs", appName, "120"]);
  if (!startupLogs.stdout.includes(`runtime-smoke-app listening on ${runtimePort}`)) {
    throw new Error(
      `Expected startup logs before supervisor kill transition.\nstdout:\n${startupLogs.stdout}\nstderr:\n${startupLogs.stderr}`,
    );
  }

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

  const logsAfterStop = await run(["logs", appName, "200"], { allowFailure: true });
  if (logsAfterStop.code !== 0) {
    throw new Error(
      `Expected logs command to succeed after stopped-with-history transition.\nstdout:\n${logsAfterStop.stdout}\nstderr:\n${logsAfterStop.stderr}`,
    );
  }

  if (logsAfterStop.stderr.includes(`No runtime state found for app ${appName}.`)) {
    throw new Error(
      `Expected logs to remain available after supervisor kill and stopped settle.\nstdout:\n${logsAfterStop.stdout}\nstderr:\n${logsAfterStop.stderr}`,
    );
  }

  if (!logsAfterStop.stdout.includes(`runtime-smoke-app listening on ${runtimePort}`)) {
    throw new Error(
      `Expected logs after stop to include startup lifecycle output.\nstdout:\n${logsAfterStop.stdout}\nstderr:\n${logsAfterStop.stderr}`,
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
