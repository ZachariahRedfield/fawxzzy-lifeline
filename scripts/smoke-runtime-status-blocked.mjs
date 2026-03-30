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
const appName = `runtime-smoke-status-blocked-${uniqueSuffix}`;
const runtimePort = 7000 + Math.floor(Math.random() * 1000);

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
    "running state with live managed supervisor and child",
  );
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

async function waitForPortOwner(expectedPid) {
  for (let i = 0; i < 50; i += 1) {
    const status = await run(["status", appName], { allowFailure: true });
    if (status.stdout.includes(`- portOwner: pid ${expectedPid}`)) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for port owner pid ${expectedPid}`);
}

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-status-blocked-smoke-"));
  const tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");

  await cp("fixtures/runtime-smoke-app", tempFixtureDir, { recursive: true });

  const envPath = path.join(tempFixtureDir, ".env.runtime");
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(envPath, envRaw.replace(/^PORT=.*$/m, `PORT=${runtimePort}`), "utf8");

  const tempManifestPath = path.join(tempFixtureDir, "runtime-smoke-app.lifeline.yml");
  const manifestRaw = await readFile(tempManifestPath, "utf8");

  const manifestForBlockedStatus = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never");

  await writeFile(tempManifestPath, manifestForBlockedStatus, "utf8");
  manifestPath = tempManifestPath;
}

async function startForeignServer() {
  foreignServer = spawn(
    process.execPath,
    [
      "-e",
      `const http=require(\"node:http\");const port=${runtimePort};http.createServer((req,res)=>{if(req.url===\"/health\"){res.writeHead(200);res.end(\"ok\");return;}res.writeHead(200);res.end(\"foreign\");}).listen(port,\"127.0.0.1\");setInterval(()=>{},1000);`,
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
  const startedState = await waitForRunning();

  if (!startedState.childPid || !isPidAlive(startedState.childPid)) {
    throw new Error("Expected running state with live managed child before forcing blocked status");
  }

  process.kill(startedState.childPid, "SIGKILL");
  await waitForPidExit(startedState.childPid);

  const foreignPid = await startForeignServer();
  await waitForPortOwner(foreignPid);

  const blockedStatus = await run(["status", appName], { allowFailure: true });
  if (blockedStatus.code === 0) {
    throw new Error(
      `Expected non-zero exit code for blocked status.\n${blockedStatus.stdout}\n${blockedStatus.stderr}`,
    );
  }

  if (!blockedStatus.stdout.includes(`App ${appName} is blocked.`)) {
    throw new Error(
      `Expected blocked status output when foreign process owns managed port.\n${blockedStatus.stdout}\n${blockedStatus.stderr}`,
    );
  }

  if (blockedStatus.stdout.includes(`App ${appName} is running.`)) {
    throw new Error(
      `Expected status output to avoid running when foreign process owns managed port.\n${blockedStatus.stdout}\n${blockedStatus.stderr}`,
    );
  }

  if (!blockedStatus.stdout.includes("- child: stopped")) {
    throw new Error(
      `Expected managed child to be reported as stopped after forced kill.\n${blockedStatus.stdout}\n${blockedStatus.stderr}`,
    );
  }

  if (!blockedStatus.stdout.includes(`- portOwner: pid ${foreignPid}`)) {
    throw new Error(
      `Expected status to report foreign pid as port owner.\n${blockedStatus.stdout}\n${blockedStatus.stderr}`,
    );
  }

  if (!blockedStatus.stdout.includes(`- blockedReason: port ${runtimePort} occupied by pid ${foreignPid}`)) {
    throw new Error(
      `Expected blocked reason to reflect foreign port owner.\n${blockedStatus.stdout}\n${blockedStatus.stderr}`,
    );
  }

  const persistedAfterStatus = await readRuntimeState();
  if (!persistedAfterStatus) {
    throw new Error("Expected persisted runtime state after blocked status refresh");
  }

  if (persistedAfterStatus.lastKnownStatus !== "blocked") {
    throw new Error(
      `Expected refreshed persisted state lastKnownStatus=blocked, found ${persistedAfterStatus.lastKnownStatus}`,
    );
  }

  if (persistedAfterStatus.portOwnerPid !== foreignPid) {
    throw new Error(
      `Expected persisted blocked state portOwnerPid=${foreignPid}, found ${persistedAfterStatus.portOwnerPid}`,
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
