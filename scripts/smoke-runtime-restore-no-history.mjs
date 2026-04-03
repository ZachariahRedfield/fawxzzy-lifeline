import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const cli = ["node", "dist/cli.js"];
const statePath = ".lifeline/state.json";
const lifelineDirPath = ".lifeline";
const logPath = (app) => path.join(lifelineDirPath, "logs", `${app}.log`);
const appName = `runtime-smoke-restore-no-history-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

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

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readRuntimeState(name) {
  const raw = await readFile(statePath, "utf8").catch(() => "");
  if (!raw) {
    return undefined;
  }

  const parsed = JSON.parse(raw);
  return parsed?.apps?.[name];
}

async function readStateFileSnapshot() {
  const raw = await readFile(statePath, "utf8").catch(() => "");
  return raw;
}

async function listProcessesForApp(name) {
  if (process.platform === "win32") {
    return [];
  }

  return new Promise((resolve, reject) => {
    const child = spawn("ps", ["-eo", "pid=,args="], {
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
      if (code !== 0) {
        reject(new Error(`ps failed (code ${code}): ${stderr}`));
        return;
      }

      const lines = stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes(name));
      resolve(lines);
    });
  });
}

async function assertNoPersistedState(name, when) {
  const state = await readRuntimeState(name);
  if (state) {
    throw new Error(
      `Expected no runtime state ${when} for ${name}, found: ${JSON.stringify(state)}`,
    );
  }
}

const appLogPath = logPath(appName);

const lifelineDirExistsBefore = await fileExists(lifelineDirPath);
const stateSnapshotBefore = await readStateFileSnapshot();
await assertNoPersistedState(appName, "before restore command");

if (await fileExists(appLogPath)) {
  throw new Error(`Expected no log file before restore command, found ${appLogPath}`);
}

const processesBefore = await listProcessesForApp(appName);
if (processesBefore.length > 0) {
  throw new Error(
    `Expected no app-related processes before restore command, found:\n${processesBefore.join("\n")}`,
  );
}

const restoreResult = await run(["restore"], { allowFailure: true });
if (restoreResult.code !== 0) {
  throw new Error(
    `Expected restore command to succeed when no persisted runtime state exists.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
  );
}

// Restore can safely no-op in two valid ways:
// 1) no managed apps exist in state
// 2) managed apps exist, but none are restorable as running
const hasNoManagedAppsMessage = restoreResult.stdout.includes(
  "No managed apps found in .lifeline/state.json.",
);
const hasNoRestorableAppsMessage = restoreResult.stdout.includes(
  "No restorable apps required restart.",
);
if (!hasNoManagedAppsMessage && !hasNoRestorableAppsMessage) {
  throw new Error(
    `Expected safe no-op restore messaging.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
  );
}

await assertNoPersistedState(appName, "after restore command");

if (await fileExists(appLogPath)) {
  throw new Error(`Expected restore command not to create ${appLogPath}, but file exists`);
}

const processesAfter = await listProcessesForApp(appName);
if (processesAfter.length > 0) {
  throw new Error(
    `Expected no app-related processes after restore command, found:\n${processesAfter.join("\n")}`,
  );
}

const stateSnapshotAfter = await readStateFileSnapshot();
if (stateSnapshotAfter !== stateSnapshotBefore) {
  throw new Error("Expected restore command to leave .lifeline/state.json unchanged");
}

const lifelineDirExistsAfter = await fileExists(lifelineDirPath);
if (lifelineDirExistsBefore !== lifelineDirExistsAfter) {
  throw new Error(
    "Expected restore command not to change whether .lifeline directory exists",
  );
}
