import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const cli = ["node", "dist/cli.js"];
const statePath = ".lifeline/state.json";

const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const appName = `runtime-smoke-supervisor-listener-managed-exit-${uniqueSuffix}`;
const runtimePort = await findOpenPort();

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


function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve ephemeral port")));
        return;
      }

      server.close(() => resolve(address.port));
    });
  });
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

async function readRuntimeState() {
  const raw = await readFile(statePath, "utf8").catch(() => "");
  if (!raw) {
    return undefined;
  }

  const parsed = JSON.parse(raw);
  return parsed?.apps?.[appName];
}

async function waitForRuntime(predicate, label) {
  for (let i = 0; i < 80; i += 1) {
    const state = await readRuntimeState();
    if (state && (await predicate(state))) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const latestStatus = await run(["status", appName], { allowFailure: true });
  throw new Error(
    `Timed out waiting for ${label}.\nstatus:\n${latestStatus.stdout}\n${latestStatus.stderr}`,
  );
}

async function waitForListenerManagedRunning() {
  return waitForRuntime(
    (state) =>
      state.lastKnownStatus === "running" &&
      Boolean(state.wrapperPid) &&
      Boolean(state.listenerPid) &&
      state.childPid === state.listenerPid &&
      state.portOwnerPid === state.listenerPid &&
      !isPidAlive(state.wrapperPid) &&
      isPidAlive(state.listenerPid),
    "running state where wrapper exited but listener remains managed",
  );
}


async function waitForStoppedAfterListenerExit() {
  return waitForRuntime(
    (state) =>
      state.lastKnownStatus === "stopped" &&
      !state.childPid &&
      !state.listenerPid,
    "stopped state after listener-managed exit",
  );
}

async function waitForLogsToContain(pattern, label) {
  for (let i = 0; i < 80; i += 1) {
    const logs = await run(["logs", appName, "300"], { allowFailure: true });
    if (logs.stdout.includes(pattern)) {
      return logs.stdout;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const latestLogs = await run(["logs", appName, "300"], { allowFailure: true });
  throw new Error(`Timed out waiting for logs to include ${label}.\n${latestLogs.stdout}\n${latestLogs.stderr}`);
}

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-supervisor-listener-managed-exit-"));
  const tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");

  await cp("fixtures/runtime-smoke-app", tempFixtureDir, { recursive: true });

  const envPath = path.join(tempFixtureDir, ".env.runtime");
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(envPath, envRaw.replace(/^PORT=.*$/m, `PORT=${runtimePort}`), "utf8");

  const listenerScript = `
import http from "node:http";

const port = Number(process.env.PORT || 0);

const server = http.createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
    return;
  }

  response.writeHead(200, { "content-type": "text/plain" });
  response.end("listener");
});

server.listen(port, "127.0.0.1", () => {
  console.log("listener alive on " + port);
});

function shutdown() {
  server.close();
  process.exit(0);
}

setTimeout(() => {
  shutdown();
}, 1800);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`;

  const wrapperScript = `
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["listener.js"], {
  detached: true,
  stdio: "ignore",
  env: process.env,
});

child.unref();
console.log("wrapper exiting after spawning listener pid " + child.pid);
setTimeout(() => process.exit(0), 300);
`;

  await writeFile(path.join(tempFixtureDir, "listener.js"), listenerScript.trimStart(), "utf8");
  await writeFile(path.join(tempFixtureDir, "wrapper.js"), wrapperScript.trimStart(), "utf8");

  const tempManifestPath = path.join(tempFixtureDir, "runtime-smoke-app.lifeline.yml");
  const manifestRaw = await readFile(tempManifestPath, "utf8");
  const manifestForListenerManagedExit = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^startCommand: .*$/m, "startCommand: node wrapper.js")
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never");

  await writeFile(tempManifestPath, manifestForListenerManagedExit, "utf8");
  manifestPath = tempManifestPath;
}

async function cleanup() {
  await run(["down", appName], { allowFailure: true });
}

try {
  await prepareFixtureConfig();
  await cleanup();

  await run(["up", manifestPath]);

  const listenerManagedState = await waitForListenerManagedRunning();
  if (!listenerManagedState.listenerPid || !isPidAlive(listenerManagedState.listenerPid)) {
    throw new Error("Expected listener-managed running state with a live listener pid");
  }

  await waitForLogsToContain(
    "wrapper pid",
    "wrapper/listener handoff log",
  );

  if (!listenerManagedState.supervisorPid || !isPidAlive(listenerManagedState.supervisorPid)) {
    throw new Error("Expected listener-managed running state with a live supervisor pid");
  }

  process.kill(listenerManagedState.supervisorPid, "SIGTERM");

  await waitForLogsToContain(
    "managed child exited via listener (signal SIGTERM)",
    "listener managed-exit source log",
  );

  if (listenerManagedState.listenerPid && isPidAlive(listenerManagedState.listenerPid)) {
    process.kill(listenerManagedState.listenerPid, "SIGTERM");
  }

  const stoppedState = await waitForStoppedAfterListenerExit();

  if (stoppedState.lastExitCode !== 0) {
    throw new Error(`Expected listener-managed supervisor-stop exit to record lastExitCode=0, found ${stoppedState.lastExitCode}`);
  }

  if (stoppedState.restartCount !== 0) {
    throw new Error(`Expected restartCount to remain 0 under restartPolicy=never, found ${stoppedState.restartCount}`);
  }

  if (stoppedState.lastKnownStatus !== "stopped") {
    throw new Error(`Expected stopped lastKnownStatus after listener exit, found ${stoppedState.lastKnownStatus}`);
  }

  const statusAfterStop = await run(["status", appName], { allowFailure: true });
  if (statusAfterStop.code === 0) {
    throw new Error(
      `Expected non-zero status once listener-managed child exits under restartPolicy=never.\n${statusAfterStop.stdout}\n${statusAfterStop.stderr}`,
    );
  }

  if (!statusAfterStop.stdout.includes(`App ${appName} is stopped.`)) {
    throw new Error(
      `Expected status output to report stopped after listener-managed exit.\n${statusAfterStop.stdout}\n${statusAfterStop.stderr}`,
    );
  }

  if (!statusAfterStop.stdout.includes("- portOwner: none")) {
    throw new Error(
      `Expected status output to report no port owner after listener-managed exit.\n${statusAfterStop.stdout}\n${statusAfterStop.stderr}`,
    );
  }

  const portReleased = await canBindPort(runtimePort);
  if (!portReleased) {
    throw new Error(`Expected port ${runtimePort} to be released after listener exit`);
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
