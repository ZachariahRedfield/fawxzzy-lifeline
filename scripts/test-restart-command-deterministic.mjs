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

async function readStateFile(cwd) {
  const statePath = path.join(cwd, ".lifeline", "state.json");
  const raw = await readFile(statePath, "utf8").catch(() => "");
  if (!raw) {
    return { apps: {} };
  }

  return JSON.parse(raw);
}

async function readAppState(cwd, appName) {
  const parsed = await readStateFile(cwd);
  return parsed?.apps?.[appName];
}

async function writeAppStatePatch(cwd, appName, patch) {
  const statePath = path.join(cwd, ".lifeline", "state.json");
  const parsed = await readStateFile(cwd);
  const current = parsed?.apps?.[appName];
  if (!current) {
    throw new Error(`Cannot patch state for ${appName}: missing app state.`);
  }

  parsed.apps[appName] = {
    ...current,
    ...patch,
  };

  await writeFile(statePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

async function waitForRunningState(cwd, appName) {
  for (let attempt = 0; attempt < 140; attempt += 1) {
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

  const playbookManifestPath = path.join(fixtureDir, "runtime-smoke-app.playbook.lifeline.yml");
  const playbookManifestRaw = await readFile(playbookManifestPath, "utf8");
  const updatedPlaybookManifest = playbookManifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never");
  await writeFile(playbookManifestPath, updatedPlaybookManifest, "utf8");

  return {
    fixtureDir,
    manifestPath,
    playbookManifestPath,
    playbookExportPath: path.join(repoRoot, "fixtures", "playbook-export"),
  };
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
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-restart-command-deterministic-"));
  const uniqueSuffix = `${Date.now()}-${process.pid}`;
  const appName = `restart-command-${uniqueSuffix}`;
  const runtimePort = await getAvailablePort();

  let foreignServer;

  try {
    const fixture = await prepareFixture(tempRoot, appName, runtimePort);

    const noHistory = await runCli(tempRoot, ["restart", appName], { allowFailure: true });
    assert(noHistory.code === 1, `no-history: expected exit code 1, got ${noHistory.code}`);
    assert(
      noHistory.stderr.trim() === `No runtime state found for app ${appName}.`,
      `no-history: expected exact missing-state message, got stderr=${JSON.stringify(noHistory.stderr)}`,
    );
    assert(
      noHistory.stdout.trim() === "",
      `no-history: expected empty stdout, got stdout=${JSON.stringify(noHistory.stdout)}`,
    );

    await runCli(tempRoot, ["up", fixture.playbookManifestPath, "--playbook-path", fixture.playbookExportPath]);
    const running = await waitForRunningState(tempRoot, appName);

    process.kill(running.childPid, "SIGKILL");
    await waitForPidExit(running.childPid);

    foreignServer = await startForeignServer(runtimePort);

    await writeAppStatePatch(tempRoot, appName, {
      manifestPath: path.join(tempRoot, "does-not-exist.lifeline.yml"),
    });

    const blockedRestart = await runCli(tempRoot, ["restart", appName], { allowFailure: true });
    assert(
      blockedRestart.code === 1,
      `down-fails path: expected restart exit code 1, got ${blockedRestart.code}`,
    );
    assert(
      blockedRestart.stderr.includes(
        `App ${appName} could not be fully stopped: down failed: port ${runtimePort}`,
      ),
      `down-fails path: expected down failure propagation, got stderr=${JSON.stringify(blockedRestart.stderr)}`,
    );
    assert(
      blockedRestart.stdout.trim() === "",
      `down-fails path: expected no success output from up stage, got stdout=${JSON.stringify(blockedRestart.stdout)}`,
    );
    assert(
      !blockedRestart.stderr.includes("Cannot read manifest") &&
        !blockedRestart.stderr.includes("does-not-exist.lifeline.yml"),
      `down-fails path: expected no up-stage manifest evaluation, got stderr=${JSON.stringify(blockedRestart.stderr)}`,
    );
    const blockedStateAfterRestart = await readAppState(tempRoot, appName);
    assert(
      blockedStateAfterRestart?.manifestPath === path.join(tempRoot, "does-not-exist.lifeline.yml"),
      `down-fails path: expected restart to leave persisted manifestPath untouched, got ${blockedStateAfterRestart?.manifestPath}`,
    );

    await stopProcess(foreignServer);
    foreignServer = undefined;

    await writeAppStatePatch(tempRoot, appName, {
      manifestPath: fixture.playbookManifestPath,
      playbookPath: fixture.playbookExportPath,
    });

    await runCli(tempRoot, ["down", appName], { allowFailure: true });

    const successfulRestart = await runCli(tempRoot, ["restart", appName]);
    assert(successfulRestart.code === 0, `success: expected exit code 0, got ${successfulRestart.code}`);
    assert(
      successfulRestart.stdout.includes(`App ${appName} has been stopped.`),
      `success: expected restart to include down success line, got stdout=${JSON.stringify(successfulRestart.stdout)}`,
    );
    assert(
      successfulRestart.stdout.includes(`App ${appName} is running.`),
      `success: expected restart to relaunch app, got stdout=${JSON.stringify(successfulRestart.stdout)}`,
    );
    assert(
      successfulRestart.stdout.includes(`- playbook: ${fixture.playbookExportPath}`),
      `success: expected restart to use persisted playbook path, got stdout=${JSON.stringify(successfulRestart.stdout)}`,
    );

    const finalState = await waitForRunningState(tempRoot, appName);
    assert(
      finalState.lastKnownStatus === "running",
      `success: expected persisted status=running, got ${finalState.lastKnownStatus}`,
    );
    assert(
      finalState.manifestPath === fixture.playbookManifestPath,
      `success: expected persisted manifestPath=${fixture.playbookManifestPath}, got ${finalState.manifestPath}`,
    );
    assert(
      finalState.playbookPath === fixture.playbookExportPath,
      `success: expected persisted playbookPath=${fixture.playbookExportPath}, got ${finalState.playbookPath}`,
    );

    console.log("Deterministic restart command IO verification passed.");
  } finally {
    await stopProcess(foreignServer);
    await runCli(tempRoot, ["down", appName], { allowFailure: true }).catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Deterministic restart command IO verification failed: ${message}`);
  process.exitCode = 1;
});
