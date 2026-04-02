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
const appName = `runtime-smoke-down-stopped-external-kill-${uniqueSuffix}`;
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
      isPidAlive(state.supervisorPid) &&
      isPidAlive(state.childPid),
    "running state with live managed supervisor and child",
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
  for (let i = 0; i < 40; i += 1) {
    const status = await run(["status", appName], { allowFailure: true });
    if (
      status.code !== 0 &&
      status.stdout.includes(`App ${appName} is stopped.`) &&
      status.stdout.includes("- child: dead")
    ) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const latestStatus = await run(["status", appName], { allowFailure: true });
  throw new Error(
    `Timed out waiting for stopped status output.\nstdout:\n${latestStatus.stdout}\nstderr:\n${latestStatus.stderr}`,
  );
}

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-down-stopped-kill-smoke-"));
  const tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");

  await cp("fixtures/runtime-smoke-app", tempFixtureDir, { recursive: true });

  const envPath = path.join(tempFixtureDir, ".env.runtime");
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(envPath, envRaw.replace(/^PORT=.*$/m, `PORT=${runtimePort}`), "utf8");

  const tempManifestPath = path.join(tempFixtureDir, "runtime-smoke-app.lifeline.yml");
  const manifestRaw = await readFile(tempManifestPath, "utf8");
  const manifestForExternalKillDown = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never");

  await writeFile(tempManifestPath, manifestForExternalKillDown, "utf8");
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

  if (!startedState.childPid || !isPidAlive(startedState.childPid)) {
    throw new Error("Expected running state with live managed child before forcing stopped down state");
  }

  process.kill(startedState.childPid, "SIGKILL");
  await waitForPidExit(startedState.childPid);

  const stoppedStatus = await waitForStoppedStatus();
  if (!stoppedStatus.stdout.includes("- portOwner: none")) {
    throw new Error(
      `Expected no runtime port owner after external kill.\nstdout:\n${stoppedStatus.stdout}\nstderr:\n${stoppedStatus.stderr}`,
    );
  }

  const persistedAfterKill = await readRuntimeState();
  if (!persistedAfterKill) {
    throw new Error("Expected persisted runtime history after external kill");
  }

  if (persistedAfterKill.lastKnownStatus === "running") {
    throw new Error(
      `Expected persisted state to be non-running after external kill, found ${persistedAfterKill.lastKnownStatus}`,
    );
  }

  const downResult = await run(["down", appName], { allowFailure: true });
  if (downResult.code !== 0) {
    throw new Error(
      `Expected down to succeed deterministically for stopped app with history.\nstdout:\n${downResult.stdout}\nstderr:\n${downResult.stderr}`,
    );
  }

  if (downResult.stderr.includes(`No runtime state found for app ${appName}.`)) {
    throw new Error(
      `Expected down not to treat stopped-with-history app as no-history.\nstdout:\n${downResult.stdout}\nstderr:\n${downResult.stderr}`,
    );
  }

  const portReleased = await canBindPort(runtimePort);
  if (!portReleased) {
    throw new Error(`Expected port ${runtimePort} to remain released after down`);
  }

  const persistedAfterDown = await readRuntimeState();
  if (!persistedAfterDown) {
    throw new Error("Expected persisted runtime state after down for stopped app history");
  }

  if (persistedAfterDown.lastKnownStatus !== "stopped") {
    throw new Error(
      `Expected down to converge persisted state to stopped instead of blocked/no-history confusion, found ${persistedAfterDown.lastKnownStatus}`,
    );
  }

  if (persistedAfterDown.lastKnownStatus === "blocked") {
    throw new Error("Expected down not to persist blocked state for externally stopped app history");
  }

  const statusAfterDown = await run(["status", appName], { allowFailure: true });
  if (!statusAfterDown.stdout.includes(`App ${appName} is stopped.`)) {
    throw new Error(
      `Expected status after down to remain stopped with retained history.\nstdout:\n${statusAfterDown.stdout}\nstderr:\n${statusAfterDown.stderr}`,
    );
  }

  if (statusAfterDown.stdout.includes("blocked")) {
    throw new Error(
      `Expected status after down not to report blocked state for external kill cleanup.\nstdout:\n${statusAfterDown.stdout}\nstderr:\n${statusAfterDown.stderr}`,
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
