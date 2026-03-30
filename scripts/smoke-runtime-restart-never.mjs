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
const statePath = ".lifeline/state.json";

const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const appName = `runtime-smoke-never-${uniqueSuffix}`;
const runtimePort = 5500 + Math.floor(Math.random() * 1500);

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

    req.on("error", (error) => {
      if (pathname === "/crash") {
        resolve(0);
        return;
      }

      reject(error);
    });

    req.end();
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
    (state) => state.lastKnownStatus === "running" && isPidAlive(state.childPid),
    "running state with live managed child",
  );
}

async function assertStoppedWithReleasedPort(contextLabel) {
  const status = await run(["status", appName], { allowFailure: true });
  if (!status.stdout.includes(`App ${appName} is stopped.`)) {
    throw new Error(
      `Expected stopped status ${contextLabel}, got:\n${status.stdout}\n${status.stderr}`,
    );
  }

  if (!status.stdout.includes("- portOwner: none")) {
    throw new Error(
      `Expected managed port owner to be released ${contextLabel}, got:\n${status.stdout}\n${status.stderr}`,
    );
  }

  const portReleased = await canBindPort(runtimePort);
  if (!portReleased) {
    throw new Error(`Expected port ${runtimePort} to be released ${contextLabel}`);
  }
}

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-never-smoke-"));
  const tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");

  await cp("fixtures/runtime-smoke-app", tempFixtureDir, { recursive: true });

  const envPath = path.join(tempFixtureDir, ".env.runtime");
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(envPath, envRaw.replace(/^PORT=.*$/m, `PORT=${runtimePort}`), "utf8");

  const tempManifestPath = path.join(tempFixtureDir, "runtime-smoke-app.lifeline.yml");
  const manifestRaw = await readFile(tempManifestPath, "utf8");

  const manifestWithPort = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never");

  await writeFile(tempManifestPath, manifestWithPort, "utf8");
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

  await request("/crash");

  await waitForRuntime(
    (state) => state.lastKnownStatus !== "running" && !isPidAlive(state.childPid),
    "stopped state after crash without replacement child",
  );

  await new Promise((resolve) => setTimeout(resolve, 2500));

  const postCrashState = await readRuntimeState();
  if (!postCrashState) {
    throw new Error("Expected persisted runtime state for app after crash");
  }

  if (postCrashState.childPid && isPidAlive(postCrashState.childPid)) {
    throw new Error(
      `Expected no running child pid after crash, found live pid ${postCrashState.childPid}`,
    );
  }

  if (
    postCrashState.childPid &&
    startedState.childPid &&
    postCrashState.childPid !== startedState.childPid
  ) {
    throw new Error(
      `Expected no replacement child pid after crash, got ${postCrashState.childPid} (initial ${startedState.childPid})`,
    );
  }

  if (postCrashState.lastKnownStatus === "running") {
    throw new Error(
      `Expected persisted status to reflect not running after crash, got ${postCrashState.lastKnownStatus}`,
    );
  }

  await assertStoppedWithReleasedPort("after crash with restartPolicy never");

  const persistedStoppedStateBeforeRestore = await readRuntimeState();
  if (!persistedStoppedStateBeforeRestore) {
    throw new Error("Expected persisted runtime state to exist before restore");
  }

  await run(["restore"]);

  await new Promise((resolve) => setTimeout(resolve, 1500));

  const postRestoreState = await readRuntimeState();
  if (!postRestoreState) {
    throw new Error("Expected persisted runtime state for app after restore");
  }

  if (postRestoreState.lastKnownStatus === "running") {
    throw new Error(
      `Expected restore to keep app stopped, got ${postRestoreState.lastKnownStatus}`,
    );
  }

  if (postRestoreState.childPid && isPidAlive(postRestoreState.childPid)) {
    throw new Error(
      `Expected restore not to resurrect app, found live pid ${postRestoreState.childPid}`,
    );
  }

  await assertStoppedWithReleasedPort("after restore of a crash-stopped restartPolicy never app");
} catch (error) {
  await cleanup();
  throw error;
} finally {
  await cleanup();
  if (tempRootDir) {
    await rm(tempRootDir, { recursive: true, force: true });
  }
}
