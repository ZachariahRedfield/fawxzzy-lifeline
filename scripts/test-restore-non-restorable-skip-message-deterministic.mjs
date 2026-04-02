import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-restore-non-restorable-skip-"));
const originalCwd = process.cwd();

const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const appName = `restore-non-restorable-${uniqueSuffix}`;
const runtimePort = 9700 + Math.floor(Math.random() * 200);

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const cli = ["node", path.join(repoRoot, "dist", "cli.js")];

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
    .replace(/^  restartPolicy: .*$/m, "  restartPolicy: never")
    .replace(/^  restorable: .*$/m, "  restorable: false");

  await writeFile(manifestPath, updatedManifest, "utf8");
  return manifestPath;
}

try {
  process.chdir(tempRoot);
  const manifestPath = await prepareFixture();

  await run(["up", manifestPath]);

  const stateRaw = await readFile(".lifeline/state.json", "utf8");
  const appState = JSON.parse(stateRaw)?.apps?.[appName];
  if (!appState || !appState.supervisorPid) {
    throw new Error("Expected persisted app state with supervisor pid after up");
  }

  process.kill(appState.supervisorPid, "SIGKILL");
  await waitForPidExit(appState.supervisorPid);

  if (appState.childPid) {
    process.kill(appState.childPid, "SIGKILL");
    await waitForPidExit(appState.childPid);
  }

  const restoreResult = await run(["restore"], { allowFailure: true });
  if (restoreResult.code !== 0) {
    throw new Error(
      `Expected restore to exit 0 for non-restorable skip.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  const expectedSkipLine = `Skipping ${appName}: app is marked restorable=false.`;
  if (!restoreResult.stdout.includes(expectedSkipLine)) {
    throw new Error(
      `Expected restore output to include explicit non-restorable skip line.\nExpected: ${expectedSkipLine}\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (!restoreResult.stdout.includes("No restorable apps required restart.")) {
    throw new Error(
      `Expected no-restart summary for non-restorable skip batch.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (restoreResult.stdout.includes(`Restored ${appName} with supervisor pid`)) {
    throw new Error(
      `Expected non-restorable app not to be relaunched.
stdout:
${restoreResult.stdout}
stderr:
${restoreResult.stderr}`,
    );
  }

  console.log("Restore non-restorable skip message deterministic verification passed.");
} finally {
  process.chdir(originalCwd);
  await run(["down", appName], { allowFailure: true }).catch(() => undefined);
  await rm(tempRoot, { recursive: true, force: true });
}
