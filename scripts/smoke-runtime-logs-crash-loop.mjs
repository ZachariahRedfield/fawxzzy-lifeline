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
const appName = `runtime-smoke-logs-crash-loop-${uniqueSuffix}`;
const runtimePort = 9000 + Math.floor(Math.random() * 500);

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

async function readRuntimeState() {
  const raw = await readFile(statePath, "utf8").catch(() => "");
  if (!raw) {
    return undefined;
  }

  const parsed = JSON.parse(raw);
  return parsed?.apps?.[appName];
}

async function waitForCrashLoopState() {
  for (let i = 0; i < 700; i += 1) {
    const state = await readRuntimeState();
    if (state?.lastKnownStatus === "crash-loop" && state.crashLoopDetected) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const latestStatus = await run(["status", appName], { allowFailure: true });
  throw new Error(
    `Timed out waiting for crash-loop state.\nstatus:\n${latestStatus.stdout}\n${latestStatus.stderr}`,
  );
}

async function prepareFixtureConfig() {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-logs-crash-loop-smoke-"));
  const tempFixtureDir = path.join(tempRootDir, "runtime-smoke-app");

  await cp("fixtures/runtime-smoke-app", tempFixtureDir, { recursive: true });

  const envPath = path.join(tempFixtureDir, ".env.runtime");
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(envPath, envRaw.replace(/^PORT=.*$/m, `PORT=${runtimePort}`), "utf8");

  const tempManifestPath = path.join(tempFixtureDir, "runtime-smoke-app.lifeline.yml");
  const manifestRaw = await readFile(tempManifestPath, "utf8");
  const manifestForCrashLoopLogs = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${runtimePort}`)
    .replace(
      /^startCommand: .*$/m,
      "startCommand: node -e \"const net=require('node:net');console.log('crash-loop-smoke: boot');const s=net.createServer();s.listen(Number(process.env.PORT||0),'127.0.0.1',()=>setTimeout(()=>{console.error('crash-loop-smoke: exiting with code 17');process.exit(17);},100));\"",
    )
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: on-failure");

  await writeFile(tempManifestPath, manifestForCrashLoopLogs, "utf8");
  manifestPath = tempManifestPath;
}

async function cleanup() {
  await run(["down", appName], { allowFailure: true });
}

try {
  await prepareFixtureConfig();
  await cleanup();

  await run(["up", manifestPath], { allowFailure: true });

  const crashLoopState = await waitForCrashLoopState();
  if (crashLoopState.lastKnownStatus !== "crash-loop") {
    throw new Error(`Expected crash-loop runtime state before logs assertion, found ${JSON.stringify(crashLoopState)}`);
  }

  const logsResult = await run(["logs", appName, "200"], { allowFailure: true });
  if (logsResult.code !== 0) {
    throw new Error(
      `Expected logs command to succeed for crash-loop app.\nstdout:\n${logsResult.stdout}\nstderr:\n${logsResult.stderr}`,
    );
  }

  if (logsResult.stderr.includes(`No runtime state found for app ${appName}.`)) {
    throw new Error(
      `Expected crash-loop app logs to remain available via runtime history.\nstdout:\n${logsResult.stdout}\nstderr:\n${logsResult.stderr}`,
    );
  }

  if (!logsResult.stdout.includes("crash-loop-smoke: boot")) {
    throw new Error(
      `Expected crash-loop logs to include startup lifecycle output.\nstdout:\n${logsResult.stdout}\nstderr:\n${logsResult.stderr}`,
    );
  }

  if (!logsResult.stdout.includes("crash-loop-smoke: exiting with code 17")) {
    throw new Error(
      `Expected crash-loop logs to include failure lifecycle output.\nstdout:\n${logsResult.stdout}\nstderr:\n${logsResult.stderr}`,
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
