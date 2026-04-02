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
const appName = `runtime-smoke-supervisor-restart-blocked-foreign-owner-${uniqueSuffix}`;
const runtimePort = 9000 + Math.floor(Math.random() * 500);

let manifestPath = "fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml";
let tempRootDir;
let foreignServer;

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
  for (let i = 0; i < 50; i += 1) {
    if (!isPidAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for pid ${pid} to exit`);
}

async function readRuntimeState() {
  const raw = await readFile(statePath, "utf8").catch(() => "");
  if (!raw) {
    return undefined;
  }

  const parsed = JSON.parse(raw);
  return parsed?.apps?.[appName];
}

async function waitForRuntime(predicate, label, attempts = 80, delayMs = 250) {
  for (let i = 0; i < attempts; i += 1) {
    const state = await readRuntimeState();
    if (state && predicate(state)) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
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

async function waitForRestartCount(expectedRestartCount) {
  return waitForRuntime(
    (state) => state.restartCount >= expectedRestartCount,
    `restartCount >= ${expectedRestartCount}`,
    80,
    100,
  );
}

async function waitForBlockedState(expectedForeignPid) {
  return waitForRuntime(
    (state) =>
      state.lastKnownStatus === "blocked" &&
      state.portOwnerPid === expectedForeignPid &&
      typeof state.blockedReason === "string" &&
      state.blockedReason.includes(String(runtimePort)) &&
      state.blockedReason.includes(String(expectedForeignPid)),
    `blocked state with foreign pid ${expectedForeignPid}`,
    120,
    100,
  );
}

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-supervisor-restart-blocked-owner-smoke-"));
  const tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");

  await cp("fixtures/runtime-smoke-app", tempFixtureDir, { recursive: true });

  const envPath = path.join(tempFixtureDir, ".env.runtime");
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(envPath, envRaw.replace(/^PORT=.*$/m, `PORT=${runtimePort}`), "utf8");

  const tempManifestPath = path.join(tempFixtureDir, "runtime-smoke-app.lifeline.yml");
  const manifestRaw = await readFile(tempManifestPath, "utf8");

  const manifestForRestartBlock = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: on-failure");

  await writeFile(tempManifestPath, manifestForRestartBlock, "utf8");
  manifestPath = tempManifestPath;
}

async function triggerDeterministicCrash() {
  const response = await fetch(`http://127.0.0.1:${runtimePort}/crash`);
  const body = await response.text();
  if (response.status !== 500 || body !== "crashing") {
    throw new Error(`Expected deterministic crash endpoint response, got status=${response.status}, body=${body}`);
  }
}

async function startForeignServer() {
  foreignServer = spawn(
    process.execPath,
    [
      "-e",
      `const http=require("node:http");const port=${runtimePort};http.createServer((req,res)=>{if(req.url==="/healthz"){res.writeHead(200);res.end("ok");return;}res.writeHead(200);res.end("foreign");}).listen(port,"127.0.0.1");setInterval(()=>{},1000);`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const stderrChunks = [];
  foreignServer.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  await new Promise((resolve) => setTimeout(resolve, 300));

  if (!foreignServer.pid || !isPidAlive(foreignServer.pid)) {
    throw new Error(`Failed to start foreign port owner. stderr:\n${stderrChunks.join("")}`);
  }

  return foreignServer.pid;
}

async function assertForeignServing() {
  const response = await fetch(`http://127.0.0.1:${runtimePort}/`);
  const body = await response.text();

  if (response.status !== 200 || body !== "foreign") {
    throw new Error(
      `Expected foreign server to remain port owner on ${runtimePort}, got status=${response.status} body=${body}`,
    );
  }
}

async function stopForeignServer() {
  if (!foreignServer || !foreignServer.pid) {
    return;
  }

  if (isPidAlive(foreignServer.pid)) {
    process.kill(foreignServer.pid, "SIGTERM");
    await waitForPidExit(foreignServer.pid).catch(async () => {
      process.kill(foreignServer.pid, "SIGKILL");
      await waitForPidExit(foreignServer.pid);
    });
  }

  foreignServer = undefined;
}

async function cleanup() {
  await stopForeignServer();
  await run(["down", appName], { allowFailure: true });
}

try {
  await prepareFixtureConfig();
  await cleanup();

  await run(["up", manifestPath]);
  const runningState = await waitForRunning();
  const initialManagedPid = runningState.childPid;

  if (!initialManagedPid || !isPidAlive(initialManagedPid)) {
    throw new Error(`Expected initial managed child pid to be alive, found ${initialManagedPid}`);
  }

  await triggerDeterministicCrash();
  await waitForPidExit(initialManagedPid);

  await waitForRestartCount(1);

  const foreignPid = await startForeignServer();
  const blockedState = await waitForBlockedState(foreignPid);

  if (blockedState.lastKnownStatus !== "blocked") {
    throw new Error(`Expected blocked state after restart collision, found ${blockedState.lastKnownStatus}`);
  }

  if (!blockedState.blockedReason || !blockedState.blockedReason.includes(String(runtimePort)) || !blockedState.blockedReason.includes(String(foreignPid))) {
    throw new Error(
      `Expected blockedReason to reference port ${runtimePort} and foreign pid ${foreignPid}, found ${blockedState.blockedReason}`,
    );
  }

  if (blockedState.childPid || blockedState.wrapperPid || blockedState.listenerPid) {
    throw new Error(
      `Expected no relaunched managed child after blocked restart, found childPid=${blockedState.childPid}, wrapperPid=${blockedState.wrapperPid}, listenerPid=${blockedState.listenerPid}`,
    );
  }

  if (blockedState.portOwnerPid !== foreignPid) {
    throw new Error(`Expected blocked port owner pid ${foreignPid}, found ${blockedState.portOwnerPid}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 1500));
  const settledState = await readRuntimeState();
  if (!settledState) {
    throw new Error("Expected persisted state after settle window");
  }

  if (settledState.restartCount !== blockedState.restartCount) {
    throw new Error(
      `Expected restart loop to stop when blocked by foreign owner, restartCount changed from ${blockedState.restartCount} to ${settledState.restartCount}`,
    );
  }

  const statusResult = await run(["status", appName], { allowFailure: true });
  if (statusResult.code === 0) {
    throw new Error(`Expected blocked status exit code, got 0.\n${statusResult.stdout}\n${statusResult.stderr}`);
  }

  if (!statusResult.stdout.includes(`App ${appName} is blocked.`)) {
    throw new Error(`Expected blocked status output.\n${statusResult.stdout}\n${statusResult.stderr}`);
  }

  if (!statusResult.stdout.includes(`- portOwner: pid ${foreignPid}`)) {
    throw new Error(`Expected status to report foreign pid ${foreignPid} as port owner.\n${statusResult.stdout}`);
  }

  if (!statusResult.stdout.includes(`- child: stopped`)) {
    throw new Error(`Expected status to report managed child stopped after blocked restart.\n${statusResult.stdout}`);
  }

  const logsResult = await run(["logs", appName, "200"], { allowFailure: true });
  if (logsResult.code !== 0) {
    throw new Error(`Expected logs command to succeed for blocked app.\n${logsResult.stdout}\n${logsResult.stderr}`);
  }

  if (!logsResult.stdout.includes("restarting in 1000ms (attempt 1)")) {
    throw new Error(`Expected logs to show restart attempt before block.\n${logsResult.stdout}`);
  }

  if (!logsResult.stdout.includes("restart blocked:")) {
    throw new Error(`Expected logs to include supervisor blocked-restart line.\n${logsResult.stdout}`);
  }

  if (!logsResult.stdout.includes(`Port ${runtimePort} is still occupied by pid ${foreignPid}`)) {
    throw new Error(`Expected blocked-restart log line to include port ${runtimePort} and pid ${foreignPid}.\n${logsResult.stdout}`);
  }

  if (isPidAlive(initialManagedPid)) {
    throw new Error(`Expected initial managed child pid ${initialManagedPid} to remain exited`);
  }

  if (!isPidAlive(foreignPid)) {
    throw new Error(`Expected foreign pid ${foreignPid} to remain alive as port owner`);
  }

  await assertForeignServing();
} catch (error) {
  await cleanup();
  throw error;
} finally {
  await cleanup();
  if (tempRootDir) {
    await rm(tempRootDir, { recursive: true, force: true });
  }
}
