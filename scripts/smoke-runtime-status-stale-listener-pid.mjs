import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const cli = ["node", "dist/cli.js"];
const statePath = ".lifeline/state.json";

const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const appName = `runtime-smoke-status-stale-listener-pid-${uniqueSuffix}`;
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

async function readStateFile() {
  const raw = await readFile(statePath, "utf8").catch(() => "");
  if (!raw) {
    return { apps: {} };
  }
  return JSON.parse(raw);
}

async function readRuntimeState() {
  const parsed = await readStateFile();
  return parsed?.apps?.[appName];
}

async function writeRuntimeMutation(mutate) {
  const parsed = await readStateFile();
  const appState = parsed?.apps?.[appName];
  if (!appState) {
    throw new Error(`No persisted runtime state found for app ${appName}`);
  }

  mutate(appState);
  await writeFile(statePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
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
      isPidAlive(state.childPid) &&
      Boolean(state.listenerPid) &&
      state.portOwnerPid === state.childPid,
    "running state with live managed runtime ownership",
  );
}

function findDeadPid(seed) {
  let candidate = Math.max(1000, seed + 10_000);
  while (isPidAlive(candidate)) {
    candidate += 1;
  }
  return candidate;
}

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-status-stale-listener-smoke-"));
  const tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");

  await cp("fixtures/runtime-smoke-app", tempFixtureDir, { recursive: true });

  const envPath = path.join(tempFixtureDir, ".env.runtime");
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(envPath, envRaw.replace(/^PORT=.*$/m, `PORT=${runtimePort}`), "utf8");

  const tempManifestPath = path.join(tempFixtureDir, "runtime-smoke-app.lifeline.yml");
  const manifestRaw = await readFile(tempManifestPath, "utf8");
  const manifestForRegression = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never");

  await writeFile(tempManifestPath, manifestForRegression, "utf8");
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
    throw new Error("Expected running state with a live managed child pid before metadata corruption");
  }

  const stalePid = findDeadPid(startedState.childPid);
  await writeRuntimeMutation((appState) => {
    appState.listenerPid = stalePid;
    appState.portOwnerPid = stalePid;
  });

  const stalePersistedState = await readRuntimeState();
  if (!stalePersistedState) {
    throw new Error("Expected persisted runtime state after stale metadata mutation");
  }

  if (stalePersistedState.listenerPid !== stalePid || stalePersistedState.portOwnerPid !== stalePid) {
    throw new Error(
      `Expected stale persisted metadata mutation to apply. listenerPid=${stalePersistedState.listenerPid} portOwnerPid=${stalePersistedState.portOwnerPid} stalePid=${stalePid}`,
    );
  }

  const statusAfterRefresh = await run(["status", appName], { allowFailure: true });
  if (statusAfterRefresh.code !== 0) {
    throw new Error(
      `Expected status to reconcile stale metadata and report running from live truth.\n${statusAfterRefresh.stdout}\n${statusAfterRefresh.stderr}`,
    );
  }

  if (!statusAfterRefresh.stdout.includes(`App ${appName} is running.`)) {
    throw new Error(
      `Expected status to report running after stale metadata reconciliation.\n${statusAfterRefresh.stdout}\n${statusAfterRefresh.stderr}`,
    );
  }

  if (!statusAfterRefresh.stdout.includes(`- portOwner: pid ${startedState.childPid}`)) {
    throw new Error(
      `Expected status to report live managed pid as current port owner.\n${statusAfterRefresh.stdout}\n${statusAfterRefresh.stderr}`,
    );
  }

  if (statusAfterRefresh.stdout.includes(`- portOwner: pid ${stalePid}`)) {
    throw new Error(
      `Expected status to avoid stale pid ownership attribution. stalePid=${stalePid}\n${statusAfterRefresh.stdout}\n${statusAfterRefresh.stderr}`,
    );
  }

  const persistedAfterStatus = await readRuntimeState();
  if (!persistedAfterStatus) {
    throw new Error("Expected persisted runtime state after status reconciliation");
  }

  if (persistedAfterStatus.lastKnownStatus !== "running") {
    throw new Error(
      `Expected refreshed persisted state lastKnownStatus=running, found ${persistedAfterStatus.lastKnownStatus}`,
    );
  }

  if (persistedAfterStatus.portOwnerPid !== startedState.childPid) {
    throw new Error(
      `Expected persisted portOwnerPid to be refreshed to live owner pid ${startedState.childPid}, found ${persistedAfterStatus.portOwnerPid}`,
    );
  }

  if (persistedAfterStatus.listenerPid !== startedState.childPid) {
    throw new Error(
      `Expected persisted listenerPid to be refreshed to live owner pid ${startedState.childPid}, found ${persistedAfterStatus.listenerPid}`,
    );
  }

  if (!persistedAfterStatus.childPid || !isPidAlive(persistedAfterStatus.childPid)) {
    throw new Error(
      `Expected persisted state to keep a live managed child pid after reconciliation, found ${persistedAfterStatus.childPid}`,
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
