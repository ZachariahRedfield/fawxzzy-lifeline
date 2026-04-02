import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-blocked-listener-coherence-"));
const originalCwd = process.cwd();

const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const appName = `blocked-listener-coherence-${uniqueSuffix}`;
const runtimePort = 9800 + Math.floor(Math.random() * 150);

const statePath = ".lifeline/state.json";
const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cli = ["node", path.join(repoRoot, "dist", "cli.js")];

process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
process.on("SIGPIPE", () => {});

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
  for (let i = 0; i < 80; i += 1) {
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

function createForeignServer() {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.end("HTTP/1.1 200 OK\\r\\nContent-Length: 7\\r\\n\\r\\nforeign");
    });

    server.once("error", reject);
    server.listen(runtimePort, "127.0.0.1", () => {
      resolve(server);
    });
  });
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

let foreignServer;

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
    throw new Error("Expected a running child pid before forced restart path.");
  }

  process.kill(running.childPid, "SIGKILL");

  await waitForState(
    (state) => state.restartCount >= 1 && state.lastKnownStatus === "stopped",
    "post-crash stopped state before restart attempt",
  );

  const staleListenerPid = 424242;
  await writeAppState((state) => ({
    ...state,
    listenerPid: staleListenerPid,
  }));

  foreignServer = await createForeignServer();

  const blocked = await waitForState(
    (state) => state.lastKnownStatus === "blocked" && typeof state.blockedReason === "string",
    "blocked state",
  );

  if (blocked.listenerPid !== undefined) {
    throw new Error(
      `Expected blocked restart snapshot to clear stale listenerPid, found ${blocked.listenerPid}`,
    );
  }

  if (blocked.childPid !== undefined || blocked.wrapperPid !== undefined) {
    throw new Error(
      `Expected blocked restart snapshot to clear child/wrapper pids, got childPid=${blocked.childPid} wrapperPid=${blocked.wrapperPid}`,
    );
  }

  if (!blocked.blockedReason.includes(`Port ${runtimePort}`)) {
    throw new Error(`Expected blocked reason to reference port ${runtimePort}, got: ${blocked.blockedReason}`);
  }

  if (running.supervisorPid && isPidAlive(running.supervisorPid)) {
    await waitForPidExit(running.supervisorPid);
  }

  console.log("Blocked restart state clears stale listenerPid deterministic verification passed.");
} finally {
  if (foreignServer) {
    await new Promise((resolve) => foreignServer.close(resolve));
  }

  process.chdir(originalCwd);
  await run(["down", appName], { allowFailure: true }).catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true });
}
