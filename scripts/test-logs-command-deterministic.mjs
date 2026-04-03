import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function runCli(args, { cwd, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, ...args], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
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
            `Command failed: node ${cliPath} ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }

      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function writeState(tempRoot, state) {
  const lifelineDir = path.join(tempRoot, ".lifeline");
  await mkdir(lifelineDir, { recursive: true });
  await writeFile(path.join(lifelineDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function createState(appName, logPath) {
  return {
    apps: {
      [appName]: {
        name: appName,
        manifestPath: "/tmp/deterministic-manifest.lifeline.yml",
        workingDirectory: "/tmp",
        supervisorPid: process.pid,
        childPid: process.pid,
        wrapperPid: undefined,
        listenerPid: process.pid,
        portOwnerPid: process.pid,
        port: 4040,
        healthcheckPath: "/healthz",
        logPath,
        startedAt: new Date(0).toISOString(),
        lastKnownStatus: "running",
        restartPolicy: "on-failure",
        restartCount: 0,
        lastExitCode: undefined,
        lastExitAt: undefined,
        restorable: true,
        crashLoopDetected: false,
        blockedReason: undefined,
      },
    },
  };
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-logs-command-"));

try {
  const noHistoryApp = "logs-no-history-deterministic";
  const noHistory = await runCli(["logs", noHistoryApp], { cwd: tempRoot, allowFailure: true });
  assert(noHistory.code === 1, `no-history: expected exit 1, got ${noHistory.code}`);
  assert(
    noHistory.stderr.trim() === `No runtime state found for app ${noHistoryApp}.`,
    `no-history: expected exact missing-state message, got ${JSON.stringify(noHistory.stderr)}`,
  );
  assert(noHistory.stdout.trim() === "", `no-history: expected empty stdout, got ${JSON.stringify(noHistory.stdout)}`);

  const missingLogsApp = "logs-missing-file-deterministic";
  const missingLogPath = path.join(tempRoot, ".lifeline", "logs", `${missingLogsApp}.log`);
  await writeState(tempRoot, createState(missingLogsApp, missingLogPath));

  const missingLogs = await runCli(["logs", missingLogsApp], { cwd: tempRoot, allowFailure: true });
  assert(missingLogs.code === 0, `missing-log-file: expected exit 0, got ${missingLogs.code}`);
  assert(missingLogs.stderr.trim() === "", `missing-log-file: expected empty stderr, got ${JSON.stringify(missingLogs.stderr)}`);
  assert(
    missingLogs.stdout.trim() === `No logs found for app ${missingLogsApp} at ${missingLogPath}.`,
    `missing-log-file: expected exact no-logs message, got ${JSON.stringify(missingLogs.stdout)}`,
  );

  const existingLogsApp = "logs-existing-file-deterministic";
  const existingLogPath = path.join(tempRoot, ".lifeline", "logs", `${existingLogsApp}.log`);
  await mkdir(path.dirname(existingLogPath), { recursive: true });

  const logLines = [
    "[line-01] alpha",
    "[line-02] bravo",
    "[line-03] charlie",
    "[line-04] delta",
    "[line-05] echo",
  ];
  await writeFile(existingLogPath, `${logLines.join("\n")}\n`, "utf8");

  await writeState(tempRoot, createState(existingLogsApp, existingLogPath));

  const tailedLogs = await runCli(["logs", existingLogsApp, "2"], { cwd: tempRoot, allowFailure: true });
  assert(tailedLogs.code === 0, `existing-log-file: expected exit 0, got ${tailedLogs.code}`);
  assert(tailedLogs.stderr.trim() === "", `existing-log-file: expected empty stderr, got ${JSON.stringify(tailedLogs.stderr)}`);

  const tailedOutput = tailedLogs.stdout.trim().split("\n");
  assert(
    JSON.stringify(tailedOutput) === JSON.stringify(["[line-04] delta", "[line-05] echo"]),
    `existing-log-file: expected only last two lines, got ${JSON.stringify(tailedOutput)}`,
  );

  console.log("logs command deterministic verification passed.");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
