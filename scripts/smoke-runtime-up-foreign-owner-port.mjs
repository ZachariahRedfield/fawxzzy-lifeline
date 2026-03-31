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
const appName = `runtime-smoke-up-foreign-owner-port-${uniqueSuffix}`;
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

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-up-foreign-owner-port-smoke-"));
  const tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");

  await cp("fixtures/runtime-smoke-app", tempFixtureDir, { recursive: true });

  const envPath = path.join(tempFixtureDir, ".env.runtime");
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(envPath, envRaw.replace(/^PORT=.*$/m, `PORT=${runtimePort}`), "utf8");

  const tempManifestPath = path.join(tempFixtureDir, "runtime-smoke-app.lifeline.yml");
  const manifestRaw = await readFile(tempManifestPath, "utf8");

  const manifestForForeignOwnerUp = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never");

  await writeFile(tempManifestPath, manifestForForeignOwnerUp, "utf8");
  manifestPath = tempManifestPath;
}

async function startForeignServer() {
  foreignServer = spawn(
    process.execPath,
    [
      "-e",
      `const http=require("node:http");const port=${runtimePort};http.createServer((req,res)=>{if(req.url==="/health"){res.writeHead(503);res.end("foreign-not-managed");return;}res.writeHead(200);res.end("foreign");}).listen(port,"127.0.0.1");setInterval(()=>{},1000);`,
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
      `Expected foreign server to continue serving on port ${runtimePort}, got status=${response.status} body=${body}`,
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
  await run(["down", appName], { allowFailure: true });
  await stopForeignServer();
}

try {
  await prepareFixtureConfig();
  await cleanup();

  const foreignPid = await startForeignServer();
  const upResult = await run(["up", manifestPath], { allowFailure: true });

  if (upResult.code === 0) {
    throw new Error(
      `Expected up to fail when foreign process already owns managed port, got success.\nstdout:\n${upResult.stdout}\nstderr:\n${upResult.stderr}`,
    );
  }

  if (upResult.stdout.includes(`App ${appName} is running.`)) {
    throw new Error(
      `Expected up failure to avoid reporting running status while foreign process owns the port.\nstdout:\n${upResult.stdout}\nstderr:\n${upResult.stderr}`,
    );
  }

  if (!isPidAlive(foreignPid)) {
    throw new Error(`Expected foreign pid ${foreignPid} to remain alive after up attempt`);
  }

  await assertForeignServing();

  const statusResult = await run(["status", appName], { allowFailure: true });
  if (statusResult.code === 0) {
    throw new Error(
      `Expected status to be non-running after failed up under foreign port ownership.\nstdout:\n${statusResult.stdout}\nstderr:\n${statusResult.stderr}`,
    );
  }

  if (statusResult.stdout.includes(`App ${appName} is running.`)) {
    throw new Error(
      `Expected status output not to claim managed running after failed up with foreign owner.\nstdout:\n${statusResult.stdout}\nstderr:\n${statusResult.stderr}`,
    );
  }

  const persistedAfterUp = await readRuntimeState();
  if (persistedAfterUp) {
    if (persistedAfterUp.lastKnownStatus === "running") {
      throw new Error(
        `Expected persisted runtime state not to claim running after failed up; got ${persistedAfterUp.lastKnownStatus}`,
      );
    }

    if (persistedAfterUp.childPid && isPidAlive(persistedAfterUp.childPid) && persistedAfterUp.childPid !== foreignPid) {
      throw new Error(
        `Expected failed up not to leave a live managed child process, found pid ${persistedAfterUp.childPid}`,
      );
    }

    if (persistedAfterUp.portOwnerPid && persistedAfterUp.portOwnerPid !== foreignPid) {
      throw new Error(
        `Expected persisted portOwnerPid to remain foreign or empty after failed up. expected pid ${foreignPid} or empty, found ${persistedAfterUp.portOwnerPid}`,
      );
    }
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
