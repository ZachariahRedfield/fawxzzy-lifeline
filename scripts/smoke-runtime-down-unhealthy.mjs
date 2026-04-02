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
const appName = `runtime-smoke-down-unhealthy-${uniqueSuffix}`;
const runtimePort = 7000 + Math.floor(Math.random() * 1000);

let manifestPath = "fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml";
let tempRootDir;
let failFlagPath;

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
      isPidAlive(state.childPid) &&
      Boolean(state.portOwnerPid),
    "running state with live managed runtime",
  );
}

async function waitForUnhealthy() {
  for (let i = 0; i < 60; i += 1) {
    const unhealthyStatus = await run(["status", appName], { allowFailure: true });
    if (
      unhealthyStatus.code !== 0 &&
      unhealthyStatus.stdout.includes(`App ${appName} is unhealthy.`) &&
      unhealthyStatus.stdout.includes("- health: HTTP 503")
    ) {
      return unhealthyStatus;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const latestStatus = await run(["status", appName], { allowFailure: true });
  throw new Error(
    `Timed out waiting for unhealthy status.\nstatus:\n${latestStatus.stdout}\n${latestStatus.stderr}`,
  );
}

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-down-unhealthy-smoke-"));
  const tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");

  await cp("fixtures/runtime-smoke-app", tempFixtureDir, { recursive: true });

  failFlagPath = path.join(tempFixtureDir, ".force-healthcheck-failure");
  const envPath = path.join(tempFixtureDir, ".env.runtime");
  const envRaw = await readFile(envPath, "utf8");
  const envWithOverrides = envRaw
    .replace(/^PORT=.*$/m, `PORT=${runtimePort}`)
    .concat(`\nHEALTH_FAIL_FLAG_FILE=${failFlagPath}\n`);
  await writeFile(envPath, envWithOverrides, "utf8");

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
    throw new Error("Expected running state with live supervisor before forcing unhealthy");
  }

  if (!runningState.childPid || !isPidAlive(runningState.childPid)) {
    throw new Error("Expected running state with live managed child before forcing unhealthy");
  }

  if (await canBindPort(runtimePort)) {
    throw new Error(`Expected port ${runtimePort} to be owned before healthcheck failure`);
  }

  await writeFile(failFlagPath, "fail\n", "utf8");
  const unhealthyStatus = await waitForUnhealthy();

  if (unhealthyStatus.stdout.includes(`App ${appName} is blocked.`)) {
    throw new Error(
      `Expected unhealthy status, not blocked status, before down.\n${unhealthyStatus.stdout}\n${unhealthyStatus.stderr}`,
    );
  }

  const persistedUnhealthy = await readRuntimeState();
  if (!persistedUnhealthy) {
    throw new Error("Expected persisted runtime state while unhealthy before down");
  }

  if (persistedUnhealthy.lastKnownStatus !== "unhealthy") {
    throw new Error(
      `Expected lastKnownStatus=unhealthy before down, found ${persistedUnhealthy.lastKnownStatus}`,
    );
  }

  const downResult = await run(["down", appName], { allowFailure: true });
  if (downResult.code !== 0) {
    throw new Error(
      `Expected down to succeed for unhealthy runtime state.\nstdout:\n${downResult.stdout}\nstderr:\n${downResult.stderr}`,
    );
  }

  if (downResult.stderr.includes(`No runtime state found for app ${appName}.`)) {
    throw new Error(
      `Expected down to use existing unhealthy runtime history.\nstdout:\n${downResult.stdout}\nstderr:\n${downResult.stderr}`,
    );
  }

  if (!(await canBindPort(runtimePort))) {
    throw new Error(`Expected port ${runtimePort} to be free after down on unhealthy runtime`);
  }

  const persistedAfterDown = await readRuntimeState();
  if (persistedAfterDown) {
    throw new Error(
      `Expected down to clean persisted runtime entry for unhealthy app, found ${JSON.stringify(persistedAfterDown)}`,
    );
  }

  const statusAfterDown = await run(["status", appName], { allowFailure: true });
  if (statusAfterDown.code === 0) {
    throw new Error(
      `Expected status to fail after down cleaned runtime state.\nstdout:\n${statusAfterDown.stdout}\nstderr:\n${statusAfterDown.stderr}`,
    );
  }

  if (!statusAfterDown.stderr.includes(`No runtime state found for app ${appName}.`)) {
    throw new Error(
      `Expected status after down to converge to no-history semantics.\nstdout:\n${statusAfterDown.stdout}\nstderr:\n${statusAfterDown.stderr}`,
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
