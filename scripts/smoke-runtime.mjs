import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const cli = ["node", "dist/cli.js"];
const fixtureManifestPath =
  "fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml";
const statePath = ".lifeline/state.json";
const appName = "runtime-smoke-app";

let runtimePort;
let manifestPath = fixtureManifestPath;
let tempFixtureDir;
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

function request(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: runtimePort,
        path: pathname,
        method: "GET",
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
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

function allocateRuntimePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate runtime smoke port")));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
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

async function hardCleanup() {
  if (process.platform === "win32") {
    return;
  }

  await new Promise((resolve) => {
    const child = spawn("pkill", ["-f", "runtime-smoke-app/server.js"], {
      stdio: "ignore",
    });
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
}

async function cleanup() {
  await run(["down", appName], { allowFailure: true });
  await hardCleanup();
}

async function waitForRuntime(predicate, label) {
  for (let i = 0; i < 50; i += 1) {
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
      state.restartCount >= 0 &&
      isPidAlive(state.childPid),
    "running state with live managed child",
  );
}

async function waitForRestartCountAtLeast(target) {
  return waitForRuntime(
    (state) => state.restartCount >= target && isPidAlive(state.childPid),
    `restartCount >= ${target}`,
  );
}

async function prepareFixtureConfig() {
  runtimePort = await allocateRuntimePort();
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-smoke-"));
  tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");

  await cp("fixtures/runtime-smoke-app", tempFixtureDir, { recursive: true });

  const envPath = path.join(tempFixtureDir, ".env.runtime");
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(envPath, envRaw.replace(/^PORT=.*$/m, `PORT=${runtimePort}`), "utf8");

  const tempManifestPath = path.join(
    tempFixtureDir,
    "runtime-smoke-app.lifeline.yml",
  );
  const manifestRaw = await readFile(tempManifestPath, "utf8");
  await writeFile(
    tempManifestPath,
    manifestRaw.replace(/^port: .*$/m, `port: ${runtimePort}`),
    "utf8",
  );

  manifestPath = tempManifestPath;
}

try {
  await prepareFixtureConfig();
  await cleanup();
  await run(["up", manifestPath]);

  const startedState = await waitForRunning();
  const status = await run(["status", appName], { allowFailure: true });
  if (!status.stdout.includes("supervisor: alive") || !status.stdout.includes("- child: alive")) {
    throw new Error(
      `Expected alive supervisor and child in status, got:\n${status.stdout}\n${status.stderr}`,
    );
  }

  const logs = await run(["logs", appName, "40"]);
  if (!logs.stdout.includes(`runtime-smoke-app listening on ${runtimePort}`)) {
    throw new Error(
      `Expected runtime log line, got:\n${logs.stdout}\n${logs.stderr}`,
    );
  }

  await run(["restart", appName]);
  const postRestartState = await waitForRunning();
  if (postRestartState.childPid === startedState.childPid) {
    throw new Error(
      `Expected managed child pid to change after CLI restart, got same pid ${postRestartState.childPid}`,
    );
  }

  const statusAfterRestart = await run(["status", appName], {
    allowFailure: true,
  });
  if (
    !statusAfterRestart.stdout.includes("supervisor: alive") ||
    !statusAfterRestart.stdout.includes("- child: alive") ||
    !statusAfterRestart.stdout.includes("- health: ok")
  ) {
    throw new Error(
      `Expected healthy alive status after CLI restart, got:\n${statusAfterRestart.stdout}\n${statusAfterRestart.stderr}`,
    );
  }

  const logsAfterRestart = await run(["logs", appName, "80"]);
  if (!logsAfterRestart.stdout.includes(`runtime-smoke-app listening on ${runtimePort}`)) {
    throw new Error(
      `Expected runtime log line after CLI restart, got:\n${logsAfterRestart.stdout}\n${logsAfterRestart.stderr}`,
    );
  }

  await request("/crash");
  const postCrashState = await waitForRestartCountAtLeast(1);
  if (postCrashState.childPid === postRestartState.childPid) {
    throw new Error(
      `Expected managed child pid to change after restart, got same pid ${postCrashState.childPid}`,
    );
  }


  const statusAfterCrash = await run(["status", appName], {
    allowFailure: true,
  });
  if (!statusAfterCrash.stdout.includes("- health: ok")) {
    throw new Error(
      `Expected healthy status after crash recovery, got:\n${statusAfterCrash.stdout}\n${statusAfterCrash.stderr}`,
    );
  }

  const restoreWhileRunning = await run(["restore"]);
  if (!restoreWhileRunning.stdout.includes("already running")) {
    throw new Error(
      `Expected idempotent restore output, got:\n${restoreWhileRunning.stdout}\n${restoreWhileRunning.stderr}`,
    );
  }

  await run(["down", appName]);

  const statusAfterDown = await run(["status", appName], { allowFailure: true });
  if (!statusAfterDown.stdout.includes("App runtime-smoke-app is stopped.")) {
    throw new Error(
      `Expected stopped status after down, got:\n${statusAfterDown.stdout}\n${statusAfterDown.stderr}`,
    );
  }
  if (!statusAfterDown.stdout.includes("- portOwner: none")) {
    throw new Error(
      `Expected no port owner after down, got:\n${statusAfterDown.stdout}\n${statusAfterDown.stderr}`,
    );
  }

  const portReleased = await canBindPort(runtimePort);
  if (!portReleased) {
    throw new Error(`Expected port ${runtimePort} to be released after down`);
  }

  const stateAfterDown = await readRuntimeState();
  if (!stateAfterDown || stateAfterDown.lastKnownStatus !== "stopped") {
    throw new Error(
      `Expected persisted runtime state to remain stopped after down, got:\n${JSON.stringify(stateAfterDown, null, 2)}`,
    );
  }
  if (isPidAlive(stateAfterDown.childPid) || isPidAlive(stateAfterDown.supervisorPid)) {
    throw new Error(
      `Expected no live child/supervisor after down, got:\n${JSON.stringify(stateAfterDown, null, 2)}`,
    );
  }

  const secondDown = await run(["down", appName], { allowFailure: true });
  if (secondDown.code !== 0 && !secondDown.stdout.includes("already stopped")) {
    throw new Error(
      `Expected second down to be safe on stopped app, got:\nstdout:\n${secondDown.stdout}\nstderr:\n${secondDown.stderr}`,
    );
  }

  const statusAfterSecondDown = await run(["status", appName], {
    allowFailure: true,
  });
  if (!statusAfterSecondDown.stdout.includes("App runtime-smoke-app is stopped.")) {
    throw new Error(
      `Expected stopped status after second down, got:\n${statusAfterSecondDown.stdout}\n${statusAfterSecondDown.stderr}`,
    );
  }
  if (!statusAfterSecondDown.stdout.includes("- portOwner: none")) {
    throw new Error(
      `Expected no port owner after second down, got:\n${statusAfterSecondDown.stdout}\n${statusAfterSecondDown.stderr}`,
    );
  }
  if (
    statusAfterSecondDown.stdout.includes("supervisor: alive") ||
    statusAfterSecondDown.stdout.includes("- child: alive")
  ) {
    throw new Error(
      `Expected no live supervisor/child metadata after second down, got:\n${statusAfterSecondDown.stdout}\n${statusAfterSecondDown.stderr}`,
    );
  }

  const portStillReleased = await canBindPort(runtimePort);
  if (!portStillReleased) {
    throw new Error(`Expected port ${runtimePort} to remain released after second down`);
  }

  const stateAfterSecondDown = await readRuntimeState();
  if (!stateAfterSecondDown || stateAfterSecondDown.lastKnownStatus !== "stopped") {
    throw new Error(
      `Expected persisted runtime state to remain stopped after second down, got:\n${JSON.stringify(stateAfterSecondDown, null, 2)}`,
    );
  }
  if (
    stateAfterSecondDown.lastKnownStatus === "running" ||
    isPidAlive(stateAfterSecondDown.childPid) ||
    isPidAlive(stateAfterSecondDown.supervisorPid)
  ) {
    throw new Error(
      `Expected no running runtime truth after second down, got:\n${JSON.stringify(stateAfterSecondDown, null, 2)}`,
    );
  }
} catch (error) {
  await cleanup();
  throw error;
} finally {
  if (tempRootDir) {
    await rm(tempRootDir, { recursive: true, force: true });
  }
}
