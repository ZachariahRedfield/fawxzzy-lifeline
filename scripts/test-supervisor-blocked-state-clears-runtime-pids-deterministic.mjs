import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-blocked-runtime-pids-"));
const originalCwd = process.cwd();

const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const appName = `blocked-runtime-pids-${uniqueSuffix}`;
const runtimePort = 9600 + Math.floor(Math.random() * 200);

const statePath = ".lifeline/state.json";
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cli = ["node", path.join(repoRoot, "dist", "cli.js")];

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
  for (let i = 0; i < 60; i += 1) {
    if (!isPidAlive(pid)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for pid ${pid} to exit`);
}

async function readStateFile() {
  const raw = await readFile(statePath, "utf8").catch(() => "");
  if (!raw) {
    return undefined;
  }

  return JSON.parse(raw);
}

async function readAppState() {
  const parsed = await readStateFile();
  return parsed?.apps?.[appName];
}

async function writeAppState(mutator) {
  const parsed = await readStateFile();
  if (!parsed?.apps?.[appName]) {
    throw new Error(`Missing app state for ${appName}`);
  }

  parsed.apps[appName] = mutator(parsed.apps[appName]);
  await writeFile(statePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

async function waitForState(predicate, label) {
  for (let i = 0; i < 100; i += 1) {
    const appState = await readAppState();
    if (appState && (await predicate(appState))) {
      return appState;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const status = await run(["status", appName], { allowFailure: true });
  throw new Error(
    `Timed out waiting for ${label}.\nstdout:\n${status.stdout}\nstderr:\n${status.stderr}`,
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
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: on-failure");

  await writeFile(manifestPath, updatedManifest, "utf8");
  return manifestPath;
}

async function startForeignServer() {
  foreignServer = spawn(
    process.execPath,
    [
      "-e",
      `const http=require("node:http");http.createServer((_,res)=>{res.writeHead(200);res.end("foreign");}).listen(${runtimePort},"127.0.0.1");setInterval(()=>{},1000);`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const stderrChunks = [];
  foreignServer.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  await new Promise((resolve) => setTimeout(resolve, 300));

  if (!foreignServer.pid || !isPidAlive(foreignServer.pid)) {
    throw new Error(`Failed to start foreign owner server. stderr:\n${stderrChunks.join("")}`);
  }

  return foreignServer.pid;
}

async function stopForeignServer() {
  if (!foreignServer?.pid) {
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

try {
  process.chdir(tempRoot);

  const manifestPath = await prepareFixture();
  await run(["up", manifestPath]);

  const running = await waitForState(
    (state) =>
      state.lastKnownStatus === "running" &&
      isPidAlive(state.supervisorPid) &&
      isPidAlive(state.childPid),
    "running state",
  );

  if (!running.childPid) {
    throw new Error("Expected running childPid before restart simulation.");
  }

  process.kill(running.childPid, "SIGKILL");

  await waitForState(
    (state) => state.restartCount >= 1 && state.lastKnownStatus === "stopped",
    "stopped state after deterministic crash",
  );

  await writeAppState((state) => ({
    ...state,
    childPid: 911111,
    wrapperPid: 922222,
    listenerPid: 933333,
  }));

  const foreignPid = await startForeignServer();

  const blocked = await waitForState(
    (state) =>
      state.lastKnownStatus === "blocked" &&
      typeof state.blockedReason === "string" &&
      state.portOwnerPid === foreignPid,
    "blocked state with foreign owner pid",
  );

  if (blocked.lastKnownStatus !== "blocked") {
    throw new Error(`Expected blocked lastKnownStatus, found ${blocked.lastKnownStatus}`);
  }

  if (blocked.childPid !== undefined || blocked.wrapperPid !== undefined || blocked.listenerPid !== undefined) {
    throw new Error(
      `Expected blocked snapshot to clear stale runtime pids, got childPid=${blocked.childPid}, wrapperPid=${blocked.wrapperPid}, listenerPid=${blocked.listenerPid}`,
    );
  }

  if (blocked.portOwnerPid !== foreignPid) {
    throw new Error(`Expected portOwnerPid ${foreignPid}, found ${blocked.portOwnerPid}`);
  }

  if (!blocked.blockedReason || !blocked.blockedReason.includes(String(runtimePort)) || !blocked.blockedReason.includes(String(foreignPid))) {
    throw new Error(
      `Expected blockedReason to reference runtime port ${runtimePort} and foreign pid ${foreignPid}, found ${blocked.blockedReason}`,
    );
  }

  if (running.supervisorPid && isPidAlive(running.supervisorPid)) {
    await waitForPidExit(running.supervisorPid);
  }

  console.log("Blocked restart snapshot clears stale runtime pid fields deterministic verification passed.");
} finally {
  await stopForeignServer();

  process.chdir(originalCwd);
  await run(["down", appName], { allowFailure: true }).catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true });
}
