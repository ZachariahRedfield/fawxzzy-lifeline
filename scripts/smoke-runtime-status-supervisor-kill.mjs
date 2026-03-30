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
const appName = `runtime-smoke-status-supervisor-kill-${uniqueSuffix}`;
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

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-status-supervisor-kill-smoke-"));
  const tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");

  await cp("fixtures/runtime-smoke-app", tempFixtureDir, { recursive: true });

  const envPath = path.join(tempFixtureDir, ".env.runtime");
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(envPath, envRaw.replace(/^PORT=.*$/m, `PORT=${runtimePort}`), "utf8");

  const tempManifestPath = path.join(tempFixtureDir, "runtime-smoke-app.lifeline.yml");
  const manifestRaw = await readFile(tempManifestPath, "utf8");

  const manifestForSupervisorKill = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never");

  await writeFile(tempManifestPath, manifestForSupervisorKill, "utf8");
  manifestPath = tempManifestPath;
}

async function cleanup() {
  await run(["down", appName], { allowFailure: true });
}

try {
  await prepareFixtureConfig();
  await cleanup();

  await run(["up", manifestPath]);
  await waitForRunning();

  const persistedBeforeKill = await readRuntimeState();
  if (!persistedBeforeKill || !persistedBeforeKill.supervisorPid || !persistedBeforeKill.childPid) {
    throw new Error("Expected persisted running state with supervisorPid and childPid before supervisor kill");
  }

  const startedSupervisorPid = persistedBeforeKill.supervisorPid;
  const startedChildPid = persistedBeforeKill.childPid;
  process.kill(startedSupervisorPid, "SIGKILL");
  await waitForPidExit(startedSupervisorPid);

  await new Promise((resolve) => setTimeout(resolve, 1000));

  const statusAfterSupervisorKill = await run(["status", appName], { allowFailure: true });
  if (statusAfterSupervisorKill.code === 0) {
    throw new Error(
      `Expected non-zero status after externally killing supervisor, got success.\n${statusAfterSupervisorKill.stdout}\n${statusAfterSupervisorKill.stderr}`,
    );
  }

  if (!statusAfterSupervisorKill.stdout.includes(`- supervisor: stopped (pid ${startedSupervisorPid})`)) {
    throw new Error(
      `Expected status to report supervisor stopped after kill, got:\n${statusAfterSupervisorKill.stdout}\n${statusAfterSupervisorKill.stderr}`,
    );
  }

  if (statusAfterSupervisorKill.stdout.includes(`App ${appName} is running.`)) {
    throw new Error(
      `Expected status not to report running after supervisor kill, got:\n${statusAfterSupervisorKill.stdout}\n${statusAfterSupervisorKill.stderr}`,
    );
  }

  const childAlive = isPidAlive(startedChildPid);
  const portReleased = await canBindPort(runtimePort);
  const listenerAlive = persistedBeforeKill.listenerPid
    ? isPidAlive(persistedBeforeKill.listenerPid)
    : false;

  if (childAlive) {
    if (!statusAfterSupervisorKill.stdout.includes(`- child: alive (pid ${startedChildPid})`)) {
      throw new Error(
        `Expected status to report live child when child is still alive after supervisor kill, got:\n${statusAfterSupervisorKill.stdout}\n${statusAfterSupervisorKill.stderr}`,
      );
    }

    if (!statusAfterSupervisorKill.stdout.includes(`- portOwner: pid ${startedChildPid}`)) {
      throw new Error(
        `Expected status to report child as port owner when child is alive, got:\n${statusAfterSupervisorKill.stdout}\n${statusAfterSupervisorKill.stderr}`,
      );
    }

    if (portReleased) {
      throw new Error(`Expected port ${runtimePort} to remain occupied while orphaned child is alive`);
    }
  } else {
    if (!statusAfterSupervisorKill.stdout.includes("- child: stopped")) {
      throw new Error(
        `Expected status to report child stopped when child exited, got:\n${statusAfterSupervisorKill.stdout}\n${statusAfterSupervisorKill.stderr}`,
      );
    }

    if (!statusAfterSupervisorKill.stdout.includes("- portOwner: none")) {
      throw new Error(
        `Expected no port owner when child is not alive, got:\n${statusAfterSupervisorKill.stdout}\n${statusAfterSupervisorKill.stderr}`,
      );
    }

    if (!portReleased) {
      throw new Error(`Expected port ${runtimePort} to be released when child is not alive`);
    }
  }

  if (persistedBeforeKill.listenerPid && listenerAlive) {
    if (!statusAfterSupervisorKill.stdout.includes(`- listener: alive (pid ${persistedBeforeKill.listenerPid})`)) {
      throw new Error(
        `Expected status to report live listener when listener is alive, got:\n${statusAfterSupervisorKill.stdout}\n${statusAfterSupervisorKill.stderr}`,
      );
    }
  } else if (!statusAfterSupervisorKill.stdout.includes("- listener: unknown/stopped")) {
    throw new Error(
      `Expected status to report listener unknown/stopped when listener is not alive, got:\n${statusAfterSupervisorKill.stdout}\n${statusAfterSupervisorKill.stderr}`,
    );
  }

  const persistedAfterStatus = await readRuntimeState();
  if (!persistedAfterStatus) {
    throw new Error("Expected persisted state after status refresh");
  }

  if (persistedAfterStatus.lastKnownStatus === "running") {
    throw new Error(
      `Expected refreshed persisted state to be non-running after supervisor kill, got ${persistedAfterStatus.lastKnownStatus}`,
    );
  }

  if (persistedAfterStatus.supervisorPid !== startedSupervisorPid) {
    throw new Error(
      `Expected refreshed persisted state to keep supervisorPid for dead supervisor. expected=${startedSupervisorPid} actual=${persistedAfterStatus.supervisorPid}`,
    );
  }

  if (isPidAlive(persistedAfterStatus.supervisorPid)) {
    throw new Error(
      `Expected refreshed persisted state not to point at a live supervisor pid, found ${persistedAfterStatus.supervisorPid}`,
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
