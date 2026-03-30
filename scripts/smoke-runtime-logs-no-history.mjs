import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const cli = ["node", "dist/cli.js"];
const statePath = ".lifeline/state.json";
const logPath = (appName) => path.join(".lifeline", "logs", `${appName}.log`);
const appName = `runtime-smoke-logs-no-history-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

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

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
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

try {
  const appLogPath = logPath(appName);

  const stateSnapshotBefore = await readStateFileSnapshot();
  await assertNoPersistedState(appName, "before logs command");

  if (await fileExists(appLogPath)) {
    throw new Error(`Expected no log file before logs command, found ${appLogPath}`);
  }

  const processesBefore = await listProcessesForApp(appName);
  if (processesBefore.length > 0) {
    throw new Error(
      `Expected no app-related processes before logs command, found:\n${processesBefore.join("\n")}`,
    );
  }

  const logsResult = await run(["logs", appName], { allowFailure: true });
  if (logsResult.code === 0) {
    throw new Error(
      `Expected logs command to fail for never-started app, got success.\nstdout:\n${logsResult.stdout}\nstderr:\n${logsResult.stderr}`,
    );
  }

  if (!logsResult.stderr.includes(`No runtime state found for app ${appName}.`)) {
    throw new Error(
      `Expected explicit no-runtime-state message for ${appName}.\nstdout:\n${logsResult.stdout}\nstderr:\n${logsResult.stderr}`,
    );
  }

  await assertNoPersistedState(appName, "after logs command");

  if (await fileExists(appLogPath)) {
    throw new Error(`Expected logs command not to create ${appLogPath}, but file exists`);
  }

  const processesAfter = await listProcessesForApp(appName);
  if (processesAfter.length > 0) {
    throw new Error(
      `Expected no app-related processes after logs command, found:\n${processesAfter.join("\n")}`,
    );
  }

  const stateSnapshotAfter = await readStateFileSnapshot();
  if (stateSnapshotAfter !== stateSnapshotBefore) {
    throw new Error("Expected logs command to leave .lifeline/state.json unchanged");
  }

  const statusResult = await run(["status", appName], { allowFailure: true });
  if (statusResult.code === 0) {
    throw new Error(
      `Expected status to fail for never-started app after logs command.\nstdout:\n${statusResult.stdout}\nstderr:\n${statusResult.stderr}`,
    );
  }

  if (!statusResult.stderr.includes(`No runtime state found for app ${appName}.`)) {
    throw new Error(
      `Expected status to report no runtime state after logs command.\nstdout:\n${statusResult.stdout}\nstderr:\n${statusResult.stderr}`,
    );
  }
} finally {
  await run(["down", appName], { allowFailure: true });
}
