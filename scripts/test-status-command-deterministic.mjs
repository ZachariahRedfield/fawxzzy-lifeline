import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertIncludesLine(output, line, message) {
  const lines = output.trimEnd().split("\n");
  assert(lines.includes(line), `${message}; expected line ${JSON.stringify(line)}, got ${JSON.stringify(lines)}`);
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

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to acquire ephemeral port."));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });

    server.on("error", reject);
  });
}

function createState(appName, { port, supervisorPid, childPid, listenerPid, lastKnownStatus, blockedReason }) {
  return {
    apps: {
      [appName]: {
        name: appName,
        manifestPath: "/tmp/deterministic-manifest.lifeline.yml",
        workingDirectory: "/tmp",
        supervisorPid,
        childPid,
        wrapperPid: undefined,
        listenerPid,
        portOwnerPid: undefined,
        port,
        healthcheckPath: "/healthz",
        logPath: `/tmp/${appName}.log`,
        startedAt: new Date(0).toISOString(),
        lastKnownStatus,
        restartPolicy: "on-failure",
        restartCount: 0,
        lastExitCode: undefined,
        lastExitAt: undefined,
        restorable: true,
        crashLoopDetected: false,
        blockedReason,
      },
    },
  };
}

async function writeState(tempRoot, state) {
  const lifelineDir = path.join(tempRoot, ".lifeline");
  const statePath = path.join(lifelineDir, "state.json");
  await mkdir(lifelineDir, { recursive: true });
  let nextState = state;

  try {
    const currentRaw = await readFile(statePath, "utf8");
    const currentState = JSON.parse(currentRaw);
    nextState = {
      ...currentState,
      ...state,
      apps: {
        ...(currentState.apps ?? {}),
        ...(state.apps ?? {}),
      },
    };
  } catch {
    nextState = state;
  }

  await writeFile(statePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
}

function startHealthServer(port, { healthStatus = 200 } = {}) {
  const script = `
    const http = require("node:http");
    const server = http.createServer((req, res) => {
      if (req.url === "/healthz") {
        res.writeHead(${healthStatus}, {"content-type": "text/plain"});
        res.end(${healthStatus} === 200 ? "ok" : "unhealthy");
        return;
      }

      res.writeHead(404, {"content-type": "text/plain"});
      res.end("not found");
    });

    server.listen(${port}, "127.0.0.1", () => {
      process.stdout.write("ready\\n");
    });

    process.on("SIGTERM", () => {
      server.close(() => process.exit(0));
    });
  `;

  const child = spawn("node", ["-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  return new Promise((resolve, reject) => {
    let settled = false;

    const onData = (chunk) => {
      if (String(chunk).includes("ready") && !settled) {
        settled = true;
        child.stdout.off("data", onData);
        resolve(child);
      }
    };

    child.stdout.on("data", onData);
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Health server exited before ready (code ${code}).`));
      }
    });
  });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }, 1000);
  });
}

function makeDeadPidCandidate(...candidates) {
  let pid = Math.max(...candidates) + 100000;
  if (pid <= 0) {
    pid = 999999;
  }

  return pid;
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-status-command-"));

let runningServer;
let blockedServer;
let conflictedServer;

try {
  const noHistoryApp = "status-no-history-deterministic";
  const noHistory = await runCli(["status", noHistoryApp], { cwd: tempRoot, allowFailure: true });
  assert(noHistory.code === 1, `no-history: expected exit 1, got ${noHistory.code}`);
  assert(
    noHistory.stderr.trim() === `No runtime state found for app ${noHistoryApp}.`,
    `no-history: expected exact missing-state message, got ${JSON.stringify(noHistory.stderr)}`,
  );
  assert(noHistory.stdout.trim() === "", `no-history: expected empty stdout, got ${JSON.stringify(noHistory.stdout)}`);

  const stoppedApp = "status-stopped-deterministic";
  const stoppedPort = await getFreePort();
  await writeState(
    tempRoot,
    createState(stoppedApp, {
      port: stoppedPort,
      supervisorPid: makeDeadPidCandidate(process.pid),
      childPid: undefined,
      listenerPid: undefined,
      lastKnownStatus: "running",
      blockedReason: undefined,
    }),
  );

  const stoppedResult = await runCli(["status", stoppedApp], { cwd: tempRoot, allowFailure: true });
  assert(stoppedResult.code === 1, `stopped: expected non-zero exit, got ${stoppedResult.code}`);
  assert(stoppedResult.stderr.trim() === "", `stopped: expected empty stderr, got ${JSON.stringify(stoppedResult.stderr)}`);
  assertIncludesLine(stoppedResult.stdout, `App ${stoppedApp} is stopped.`, "stopped: missing status summary line");
  assertIncludesLine(
    stoppedResult.stdout,
    `- supervisor: stopped (pid ${makeDeadPidCandidate(process.pid)})`,
    "stopped: missing supervisor line",
  );
  assertIncludesLine(stoppedResult.stdout, "- child: stopped", "stopped: missing child line");
  assertIncludesLine(stoppedResult.stdout, "- wrapper: stopped", "stopped: missing wrapper line");
  assertIncludesLine(stoppedResult.stdout, "- listener: unknown/stopped", "stopped: missing listener line");
  assertIncludesLine(stoppedResult.stdout, "- portOwner: none", "stopped: missing portOwner none line");
  assertIncludesLine(
    stoppedResult.stdout,
    `- healthcheck: http://127.0.0.1:${stoppedPort}/healthz`,
    "stopped: missing healthcheck summary line",
  );
  assertIncludesLine(
    stoppedResult.stdout,
    "- health: managed app process not running",
    "stopped: missing health line",
  );

  const runningApp = "status-running-deterministic";
  const runningPort = await getFreePort();
  runningServer = await startHealthServer(runningPort);

  await writeState(
    tempRoot,
    createState(runningApp, {
      port: runningPort,
      supervisorPid: process.pid,
      childPid: runningServer.pid,
      listenerPid: runningServer.pid,
      lastKnownStatus: "stopped",
      blockedReason: undefined,
    }),
  );

  const runningResult = await runCli(["status", runningApp], { cwd: tempRoot, allowFailure: true });
  assert(runningResult.code === 0, `running: expected exit 0, got ${runningResult.code}`);
  assert(runningResult.stderr.trim() === "", `running: expected empty stderr, got ${JSON.stringify(runningResult.stderr)}`);
  assertIncludesLine(runningResult.stdout, `App ${runningApp} is running.`, "running: missing status line");
  assertIncludesLine(
    runningResult.stdout,
    `- supervisor: alive (pid ${process.pid})`,
    "running: missing supervisor-alive summary",
  );
  assertIncludesLine(runningResult.stdout, `- port: ${runningPort}`, "running: missing port line");
  assertIncludesLine(runningResult.stdout, "- health: ok (200)", "running: missing health line");
  assertIncludesLine(runningResult.stdout, `- portOwner: pid ${runningServer.pid}`, "running: missing portOwner line");

  const blockedApp = "status-blocked-deterministic";
  const blockedPort = await getFreePort();
  blockedServer = await startHealthServer(blockedPort);
  const deadSupervisorPid = makeDeadPidCandidate(process.pid, runningServer.pid, blockedServer.pid);

  await writeState(
    tempRoot,
    createState(blockedApp, {
      port: blockedPort,
      supervisorPid: deadSupervisorPid,
      childPid: undefined,
      listenerPid: undefined,
      lastKnownStatus: "stopped",
      blockedReason: undefined,
    }),
  );

  const blockedResult = await runCli(["status", blockedApp], { cwd: tempRoot, allowFailure: true });
  assert(blockedResult.code === 1, `blocked: expected non-zero exit, got ${blockedResult.code}`);
  assert(blockedResult.stderr.trim() === "", `blocked: expected empty stderr, got ${JSON.stringify(blockedResult.stderr)}`);
  assertIncludesLine(blockedResult.stdout, `App ${blockedApp} is blocked.`, "blocked: missing status line");
  assertIncludesLine(
    blockedResult.stdout,
    `- supervisor: stopped (pid ${deadSupervisorPid})`,
    "blocked: missing supervisor stopped summary",
  );
  assertIncludesLine(
    blockedResult.stdout,
    `- blockedReason: port ${blockedPort} occupied by pid ${blockedServer.pid}`,
    "blocked: missing blockedReason summary",
  );
  assertIncludesLine(
    blockedResult.stdout,
    `- portOwner: pid ${blockedServer.pid}`,
    "blocked: missing portOwner summary",
  );


  const proofJsonResult = await runCli(["status", blockedApp, "--proof"], { cwd: tempRoot, allowFailure: true });
  assert(proofJsonResult.code === 0, `proof-json: expected exit 0, got ${proofJsonResult.code}`);
  assert(proofJsonResult.stderr.trim() === "", `proof-json: expected empty stderr, got ${JSON.stringify(proofJsonResult.stderr)}`);
  const proofJsonPayload = JSON.parse(proofJsonResult.stdout);
  assert(proofJsonPayload.mode === "proof", `proof-json: expected mode=proof, got ${proofJsonPayload.mode}`);
  assert(proofJsonPayload.proof?.ok === false, `proof-json: expected proof.ok=false, got ${proofJsonPayload.proof?.ok}`);
  assert(proofJsonPayload.proof?.state === "blocked", `proof-json: expected blocked state, got ${proofJsonPayload.proof?.state}`);
  assert(Array.isArray(proofJsonPayload.parallel_work), "proof-json: expected additive-safe parallel_work array");

  const proofJsonGateResult = await runCli(["status", blockedApp, "--proof", "--proof-gate"], {
    cwd: tempRoot,
    allowFailure: true,
  });
  assert(proofJsonGateResult.code === 1, `proof-gate: expected exit 1, got ${proofJsonGateResult.code}`);
  assert(proofJsonGateResult.stderr.trim() === "", `proof-gate: expected empty stderr, got ${JSON.stringify(proofJsonGateResult.stderr)}`);
  const proofJsonGatePayload = JSON.parse(proofJsonGateResult.stdout);
  assert(proofJsonGatePayload.mode === "proof", `proof-gate: expected mode=proof, got ${proofJsonGatePayload.mode}`);
  assert(proofJsonGatePayload.proof?.ok === false, `proof-gate: expected proof.ok=false, got ${proofJsonGatePayload.proof?.ok}`);

  const proofTextResult = await runCli(["status", blockedApp, "--proof-text"], { cwd: tempRoot, allowFailure: true });
  assert(proofTextResult.code === 0, `proof-text: expected exit 0, got ${proofTextResult.code}`);
  assert(proofTextResult.stderr.trim() === "", `proof-text: expected empty stderr, got ${JSON.stringify(proofTextResult.stderr)}`);
  assertIncludesLine(
    proofTextResult.stdout,
    `Proof status for ${blockedApp}: blocked`,
    "proof-text: missing operator brief status line",
  );

  const conflictedApp = "status-conflicted-deterministic";
  const conflictedPort = await getFreePort();
  conflictedServer = await startHealthServer(conflictedPort, { healthStatus: 500 });

  await writeState(
    tempRoot,
    createState(conflictedApp, {
      port: conflictedPort,
      supervisorPid: process.pid,
      childPid: conflictedServer.pid,
      listenerPid: conflictedServer.pid,
      lastKnownStatus: "running",
      blockedReason: undefined,
    }),
  );

  const proofTextGateResult = await runCli(["status", conflictedApp, "--proof-text", "--proof-gate"], {
    cwd: tempRoot,
    allowFailure: true,
  });
  assert(proofTextGateResult.code === 1, `proof-text-gate: expected exit 1, got ${proofTextGateResult.code}`);
  assert(
    proofTextGateResult.stderr.trim() === "",
    `proof-text-gate: expected empty stderr, got ${JSON.stringify(proofTextGateResult.stderr)}`,
  );
  assertIncludesLine(
    proofTextGateResult.stdout,
    "Decision: parallel_guard_conflicted",
    "proof-text-gate: missing decision summary",
  );

  const finalStateRaw = await readFile(path.join(tempRoot, ".lifeline", "state.json"), "utf8");
  const finalState = JSON.parse(finalStateRaw);
  assert(finalState.apps?.[blockedApp]?.lastKnownStatus === "blocked", "blocked: expected persisted status to be blocked");

  console.log("status command deterministic verification passed.");
} finally {
  await stopProcess(runningServer);
  await stopProcess(blockedServer);
  await stopProcess(conflictedServer);
  await rm(tempRoot, { recursive: true, force: true });
}
