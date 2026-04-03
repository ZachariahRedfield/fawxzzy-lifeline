import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cliPath = path.join(repoRoot, "dist", "cli.js");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate an available test port.")));
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
  });
}

function runCli(cwd, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
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
            `Command failed: lifeline ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }

      resolve({ code: code ?? 1, stdout, stderr });
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!isPidAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for pid ${pid} to exit.`);
}

async function readAppState(cwd, appName) {
  const raw = await readFile(path.join(cwd, ".lifeline", "state.json"), "utf8").catch(() => "");
  if (!raw) {
    return undefined;
  }

  const parsed = JSON.parse(raw);
  return parsed?.apps?.[appName];
}

async function waitForRunningState(cwd, appName) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const state = await readAppState(cwd, appName);
    if (state?.lastKnownStatus === "running" && state.supervisorPid && state.childPid) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for ${appName} to reach running state.`);
}

async function prepareFixture(tempRoot, appName, runtimePort) {
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
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never");

  await writeFile(manifestPath, updatedManifest, "utf8");
  return manifestPath;
}

async function startForeignServer(runtimePort) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const http=require("node:http");http.createServer((_,res)=>res.end("foreign")).listen(${runtimePort},"127.0.0.1");setInterval(()=>{},1000);`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  await new Promise((resolve) => setTimeout(resolve, 400));

  if (!child.pid || !isPidAlive(child.pid)) {
    throw new Error(`Failed to start foreign owner on port ${runtimePort}. stderr:\n${stderr}`);
  }

  return child;
}

async function stopProcess(child) {
  if (!child?.pid || !isPidAlive(child.pid)) {
    return;
  }

  process.kill(child.pid, "SIGTERM");
  await waitForPidExit(child.pid).catch(async () => {
    process.kill(child.pid, "SIGKILL");
    await waitForPidExit(child.pid);
  });
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-down-command-deterministic-"));
  const uniqueSuffix = `${Date.now()}-${process.pid}`;
  const appName = `down-command-${uniqueSuffix}`;
  const runtimePort = await getAvailablePort();

  let foreignServer;

  try {
    const manifestPath = await prepareFixture(tempRoot, appName, runtimePort);

    const noHistory = await runCli(tempRoot, ["down", appName], { allowFailure: true });
    assert(noHistory.code === 1, `no-history: expected exit code 1, got ${noHistory.code}`);
    assert(
      noHistory.stderr.trim() === `No runtime state found for app ${appName}.`,
      `no-history: expected exact missing-state message, got stderr=${JSON.stringify(noHistory.stderr)}`,
    );
    assert(
      noHistory.stdout.trim() === "",
      `no-history: expected empty stdout, got stdout=${JSON.stringify(noHistory.stdout)}`,
    );

    await runCli(tempRoot, ["up", manifestPath]);
    await waitForRunningState(tempRoot, appName);

    const success = await runCli(tempRoot, ["down", appName]);
    assert(success.code === 0, `success: expected exit code 0, got ${success.code}`);
    assert(
      success.stdout.trim() === `App ${appName} has been stopped.`,
      `success: expected exact stop message, got stdout=${JSON.stringify(success.stdout.trim())}`,
    );
    assert(
      success.stderr.trim() === "",
      `success: expected empty stderr, got stderr=${JSON.stringify(success.stderr)}`,
    );

    await runCli(tempRoot, ["up", manifestPath]);
    const runningBeforeBlocked = await waitForRunningState(tempRoot, appName);

    assert(runningBeforeBlocked.childPid, "blocked path: expected running child pid before forced conflict.");
    process.kill(runningBeforeBlocked.childPid, "SIGKILL");
    await waitForPidExit(runningBeforeBlocked.childPid);

    foreignServer = await startForeignServer(runtimePort);

    const blocked = await runCli(tempRoot, ["down", appName], { allowFailure: true });
    assert(blocked.code === 1, `blocked path: expected exit code 1, got ${blocked.code}`);
    assert(
      blocked.stderr.includes(`App ${appName} could not be fully stopped: down failed: port ${runtimePort}`),
      `blocked path: expected blocked-message family, got stderr=${JSON.stringify(blocked.stderr)}`,
    );
    assert(
      blocked.stdout.trim() === "",
      `blocked path: expected empty stdout, got stdout=${JSON.stringify(blocked.stdout)}`,
    );

    const blockedState = await readAppState(tempRoot, appName);
    assert(blockedState, "blocked path: expected persisted state after failed down.");
    assert(
      blockedState.lastKnownStatus === "blocked",
      `blocked path: expected status=blocked, got ${blockedState.lastKnownStatus}`,
    );
    assert(
      Number.isInteger(blockedState.portOwnerPid),
      `blocked path: expected persisted portOwnerPid integer, got ${blockedState.portOwnerPid}`,
    );
    assert(
      typeof blockedState.blockedReason === "string" &&
        blockedState.blockedReason.startsWith(`down failed: port ${runtimePort}`),
      `blocked path: expected persisted blockedReason family, got ${blockedState.blockedReason}`,
    );

    assert(
      foreignServer.pid && isPidAlive(foreignServer.pid),
      "blocked path: expected foreign owner to remain alive.",
    );

    console.log("Deterministic down command IO verification passed.");
  } finally {
    await stopProcess(foreignServer);
    await runCli(tempRoot, ["down", appName], { allowFailure: true }).catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Deterministic down command IO verification failed: ${message}`);
  process.exitCode = 1;
});
