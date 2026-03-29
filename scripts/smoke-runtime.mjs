import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { tmpdir } from "node:os";

const cli = ["node", "dist/cli.js"];
const fixtureManifestPath =
  "fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml";
const statePath = ".lifeline/state.json";
const appName = "runtime-smoke-app";

const runtimePort = 4500 + Math.floor(Math.random() * 2000);
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

  await request("/crash");
  const postCrashState = await waitForRestartCountAtLeast(1);
  if (postCrashState.childPid === startedState.childPid) {
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
} catch (error) {
  await cleanup();
  throw error;
} finally {
  if (tempRootDir) {
    await rm(tempRootDir, { recursive: true, force: true });
  }
}
