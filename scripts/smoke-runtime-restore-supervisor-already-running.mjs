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
const appName = `runtime-smoke-restore-supervisor-running-${uniqueSuffix}`;
const runtimePort = 9600 + Math.floor(Math.random() * 300);

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

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(
    path.join(tmpdir(), "lifeline-runtime-restore-supervisor-running-smoke-"),
  );
  const tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");

  await cp("fixtures/runtime-smoke-app", tempFixtureDir, { recursive: true });

  const envPath = path.join(tempFixtureDir, ".env.runtime");
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(envPath, envRaw.replace(/^PORT=.*$/m, `PORT=${runtimePort}`), "utf8");

  const tempManifestPath = path.join(tempFixtureDir, "runtime-smoke-app.lifeline.yml");
  const manifestRaw = await readFile(tempManifestPath, "utf8");

  const manifestNext = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never")
    .replace(/^  restorable: .*$/m, "  restorable: true");

  await writeFile(tempManifestPath, manifestNext, "utf8");
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

  if (startedState.lastKnownStatus !== "running" || !startedState.restorable) {
    throw new Error(
      `Expected persisted running+restorable state before restore, found ${JSON.stringify(startedState)}`,
    );
  }

  const supervisorPidBeforeRestore = startedState.supervisorPid;
  const childPidBeforeRestore = startedState.childPid;

  if (await canBindPort(runtimePort)) {
    throw new Error(`Expected managed runtime port ${runtimePort} to be occupied before restore`);
  }

  const restoreResult = await run(["restore"], { allowFailure: true });
  if (restoreResult.code !== 0) {
    throw new Error(
      `Expected restore command to succeed.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  const expectedSkipMessage = `Skipping ${appName}: supervisor already running (pid ${supervisorPidBeforeRestore}).`;
  if (!restoreResult.stdout.includes(expectedSkipMessage)) {
    throw new Error(
      `Expected restore output to include explicit supervisor-running skip message.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (!restoreResult.stdout.includes("No restorable apps required restart.")) {
    throw new Error(
      `Expected restore output to include deterministic no-restart summary.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (restoreResult.stdout.includes("No managed apps found in .lifeline/state.json.")) {
    throw new Error(
      `Restore reported no-history message despite managed app state existing.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  const runningStateAfterRestore = await waitForRunning();

  if (runningStateAfterRestore.supervisorPid !== supervisorPidBeforeRestore) {
    throw new Error(
      `Expected restore to keep supervisor pid unchanged (${supervisorPidBeforeRestore}), found ${runningStateAfterRestore.supervisorPid}`,
    );
  }

  if (runningStateAfterRestore.childPid !== childPidBeforeRestore) {
    throw new Error(
      `Expected restore to keep child pid unchanged (${childPidBeforeRestore}), found ${runningStateAfterRestore.childPid}`,
    );
  }

  const statusAfterRestore = await run(["status", appName], { allowFailure: true });
  if (statusAfterRestore.code !== 0) {
    throw new Error(
      `Expected healthy running status after restore no-op.\nstdout:\n${statusAfterRestore.stdout}\nstderr:\n${statusAfterRestore.stderr}`,
    );
  }

  if (!statusAfterRestore.stdout.includes(`App ${appName} is running.`)) {
    throw new Error(
      `Expected running status after restore no-op.\nstdout:\n${statusAfterRestore.stdout}\nstderr:\n${statusAfterRestore.stderr}`,
    );
  }

  if (!statusAfterRestore.stdout.includes(`- portOwner: pid ${childPidBeforeRestore}`)) {
    throw new Error(
      `Expected already-running managed child pid ${childPidBeforeRestore} to keep port ownership.\nstdout:\n${statusAfterRestore.stdout}\nstderr:\n${statusAfterRestore.stderr}`,
    );
  }

  if (!statusAfterRestore.stdout.includes("- health: ok")) {
    throw new Error(
      `Expected healthy status output after restore no-op.\nstdout:\n${statusAfterRestore.stdout}\nstderr:\n${statusAfterRestore.stderr}`,
    );
  }

  if (await canBindPort(runtimePort)) {
    throw new Error(
      `Expected runtime port ${runtimePort} to remain occupied by running managed child after restore`,
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
