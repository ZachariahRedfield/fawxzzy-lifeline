import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-restore-state-reset-"));
const originalCwd = process.cwd();

const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const appName = `restore-state-reset-${uniqueSuffix}`;
const runtimePort = 9600 + Math.floor(Math.random() * 200);

const statePath = ".lifeline/state.json";
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cli = ["node", path.join(repoRoot, "dist", "cli.js")];

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

async function waitForPidExit(pid) {
  for (let i = 0; i < 60; i += 1) {
    if (!isPidAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for pid ${pid} to exit`);
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

async function waitForPortRelease(port) {
  for (let i = 0; i < 50; i += 1) {
    if (await canBindPort(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for runtime port ${port} to be released`);
}

async function readAppState() {
  const raw = await readFile(statePath, "utf8").catch(() => "");
  if (!raw) {
    return undefined;
  }

  const parsed = JSON.parse(raw);
  return parsed?.apps?.[appName];
}

async function writeAppState(appState) {
  const raw = await readFile(statePath, "utf8");
  const parsed = JSON.parse(raw);
  parsed.apps[appName] = appState;
  await writeFile(statePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

async function waitForRunningState() {
  for (let i = 0; i < 60; i += 1) {
    const appState = await readAppState();
    if (
      appState &&
      appState.lastKnownStatus === "running" &&
      isPidAlive(appState.supervisorPid) &&
      isPidAlive(appState.childPid)
    ) {
      return appState;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const status = await run(["status", appName], { allowFailure: true });
  throw new Error(
    `Timed out waiting for running state\nstdout:\n${status.stdout}\nstderr:\n${status.stderr}`,
  );
}

async function prepareFixture() {
  const fixtureDir = path.join(tempRoot, "runtime-smoke-app");
  await cp(path.join(repoRoot, "fixtures", "runtime-smoke-app"), fixtureDir, { recursive: true });

  const envPath = path.join(fixtureDir, ".env.runtime");
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(envPath, envRaw.replace(/^PORT=.*$/m, `PORT=${runtimePort}`), "utf8");

  const manifestPath = path.join(fixtureDir, "runtime-smoke-app.lifeline.yml");
  const manifestRaw = await readFile(manifestPath, "utf8");
  const updatedManifest = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never")
    .replace(/^  restorable: .*$/m, "  restorable: true");

  await writeFile(manifestPath, updatedManifest, "utf8");
  return manifestPath;
}

try {
  process.chdir(tempRoot);
  const manifestPath = await prepareFixture();

  await run(["up", manifestPath]);
  const startedState = await waitForRunningState();

  process.kill(startedState.supervisorPid, "SIGKILL");
  await waitForPidExit(startedState.supervisorPid);

  if (startedState.childPid) {
    process.kill(startedState.childPid, "SIGKILL");
    await waitForPidExit(startedState.childPid);
  }

  await waitForPortRelease(runtimePort);

  const staleStartedAt = "2000-01-01T00:00:00.000Z";
  await writeAppState({
    ...startedState,
    childPid: 99991,
    wrapperPid: 99992,
    listenerPid: 99993,
    portOwnerPid: 99994,
    blockedReason: "stale-blocked-reason",
    startedAt: staleStartedAt,
    lastKnownStatus: "running",
  });

  const restoreResult = await run(["restore"], { allowFailure: true });
  if (restoreResult.code !== 0) {
    throw new Error(
      `Expected restore command to succeed.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  const restoreLinePattern = new RegExp(`Restored ${appName} with supervisor pid (\\d+)\\.`);
  const restoreLineMatch = restoreResult.stdout.match(restoreLinePattern);
  if (!restoreLineMatch) {
    throw new Error(
      `Expected restore output to include relaunched supervisor pid.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  const restoredPid = Number.parseInt(restoreLineMatch[1], 10);
  const persistedAfterRestore = await readAppState();
  if (!persistedAfterRestore) {
    throw new Error("Expected app state to exist after restore");
  }

  if (persistedAfterRestore.supervisorPid !== restoredPid) {
    throw new Error(
      `Expected persisted supervisor pid ${persistedAfterRestore.supervisorPid} to match restore output pid ${restoredPid}.`,
    );
  }

  if (persistedAfterRestore.supervisorPid === startedState.supervisorPid) {
    throw new Error(
      `Expected restore to persist a newly launched supervisor pid, still ${persistedAfterRestore.supervisorPid}`,
    );
  }

  if (persistedAfterRestore.childPid !== undefined) {
    throw new Error(`Expected childPid to be cleared, found ${persistedAfterRestore.childPid}`);
  }

  if (persistedAfterRestore.wrapperPid !== undefined) {
    throw new Error(`Expected wrapperPid to be cleared, found ${persistedAfterRestore.wrapperPid}`);
  }

  if (persistedAfterRestore.listenerPid !== undefined) {
    throw new Error(`Expected listenerPid to be cleared, found ${persistedAfterRestore.listenerPid}`);
  }

  if (persistedAfterRestore.portOwnerPid !== undefined) {
    throw new Error(`Expected portOwnerPid to be cleared, found ${persistedAfterRestore.portOwnerPid}`);
  }

  if (persistedAfterRestore.blockedReason !== undefined) {
    throw new Error(
      `Expected blockedReason to be cleared, found ${persistedAfterRestore.blockedReason}`,
    );
  }

  if (persistedAfterRestore.startedAt === staleStartedAt) {
    throw new Error(
      `Expected startedAt to refresh after restore launch, still ${persistedAfterRestore.startedAt}`,
    );
  }

  if (persistedAfterRestore.lastKnownStatus !== "stopped") {
    throw new Error(
      `Expected restore to persist transitional status stopped, found ${persistedAfterRestore.lastKnownStatus}`,
    );
  }

  console.log("Restore runtime state reset deterministic verification passed.");
} finally {
  process.chdir(originalCwd);
  await run(["down", appName], { allowFailure: true }).catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true });
}
