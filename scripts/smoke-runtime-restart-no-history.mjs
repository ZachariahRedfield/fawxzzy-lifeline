import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const cli = ["node", "dist/cli.js"];
const statePath = ".lifeline/state.json";
const logPath = (app) => path.join(".lifeline", "logs", `${app}.log`);
const appName = `runtime-smoke-restart-no-history-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

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

  await assertNoPersistedState(appName, "before restart command");

  if (await fileExists(appLogPath)) {
    throw new Error(`Expected no log file before restart command, found ${appLogPath}`);
  }

  const processesBefore = await listProcessesForApp(appName);
  if (processesBefore.length > 0) {
    throw new Error(
      `Expected no app-related processes before restart command, found:\n${processesBefore.join("\n")}`,
    );
  }

  const restartResult = await run(["restart", appName], { allowFailure: true });
  if (restartResult.code === 0) {
    throw new Error(
      `Expected restart command to fail for never-started app, got success.\nstdout:\n${restartResult.stdout}\nstderr:\n${restartResult.stderr}`,
    );
  }

  if (!restartResult.stderr.includes(`No runtime state found for app ${appName}.`)) {
    throw new Error(
      `Expected explicit no-runtime-state restart message for ${appName}.\nstdout:\n${restartResult.stdout}\nstderr:\n${restartResult.stderr}`,
    );
  }

  await assertNoPersistedState(appName, "after restart command");

  if (await fileExists(appLogPath)) {
    throw new Error(`Expected restart command not to create ${appLogPath}, but file exists`);
  }

  const processesAfter = await listProcessesForApp(appName);
  if (processesAfter.length > 0) {
    throw new Error(
      `Expected no app-related processes after restart command, found:\n${processesAfter.join("\n")}`,
    );
  }

  const statusResult = await run(["status", appName], { allowFailure: true });
  if (statusResult.code === 0) {
    throw new Error(
      `Expected status to fail for never-started app after restart command.\nstdout:\n${statusResult.stdout}\nstderr:\n${statusResult.stderr}`,
    );
  }

  if (!statusResult.stderr.includes(`No runtime state found for app ${appName}.`)) {
    throw new Error(
      `Expected status to report no runtime state after restart command.\nstdout:\n${statusResult.stdout}\nstderr:\n${statusResult.stderr}`,
    );
  }
} finally {
  await run(["down", appName], { allowFailure: true });
}
