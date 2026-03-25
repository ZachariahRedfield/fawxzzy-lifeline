import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import process from "node:process";

const cli = ["node", "dist/cli.js"];
const fixtureManifestPath =
  "fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml";
const fixtureEnvPath = "fixtures/runtime-smoke-app/.env.runtime";
const appName = "runtime-smoke-app";

const runtimePort = 4500 + Math.floor(Math.random() * 2000);
const manifestPath = fixtureManifestPath;

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

function request(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: runtimePort,
        path: pathname,
        method: "GET",
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function hardCleanup() {
  if (process.platform === "win32") {
    return;
  }

  await new Promise((resolve) => {
    const child = spawn(
      "pkill",
      ["-f", "fixtures/runtime-smoke-app/server.js"],
      {
        stdio: "ignore",
      },
    );
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
}

async function cleanup() {
  await run(["down", appName], { allowFailure: true });
  await hardCleanup();
}

function parseRestartCount(statusOutput) {
  const match = statusOutput.match(/restartCount:\s*(\d+)/);
  return match ? Number(match[1]) : NaN;
}

function parseChildPid(statusOutput) {
  const match = statusOutput.match(/- child:\s+alive \(pid (\d+)\)/);
  return match ? Number(match[1]) : undefined;
}

async function waitForRunning() {
  for (let i = 0; i < 30; i += 1) {
    const status = await run(["status", appName], { allowFailure: true });
    if (status.stdout.includes("is running") && status.stdout.includes("- child: alive")) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Timed out waiting for running status");
}

async function waitForRestartCountAtLeast(target) {
  for (let i = 0; i < 40; i += 1) {
    const status = await run(["status", appName], { allowFailure: true });
    const count = parseRestartCount(status.stdout);
    if (Number.isInteger(count) && count >= target && status.stdout.includes("- child: alive")) {
      return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for restartCount >= ${target}`);
}

async function prepareFixtureConfig() {
  const envRaw = await readFile(fixtureEnvPath, "utf8");
  await writeFile(
    fixtureEnvPath,
    envRaw.replace(/^PORT=.*$/m, `PORT=${runtimePort}`),
    "utf8",
  );

  const manifestRaw = await readFile(fixtureManifestPath, "utf8");
  await writeFile(
    fixtureManifestPath,
    manifestRaw.replace(/^port: .*$/m, `port: ${runtimePort}`),
    "utf8",
  );
}

try {
  await prepareFixtureConfig();
  await cleanup();
  await run(["up", manifestPath]);

  await waitForRunning();
  const status = await run(["status", appName], { allowFailure: true });
  if (!status.stdout.includes("supervisor: alive")) {
    throw new Error(
      `Expected alive supervisor in status, got:\n${status.stdout}\n${status.stderr}`,
    );
  }

  const logs = await run(["logs", appName, "40"]);
  if (!logs.stdout.includes(`runtime-smoke-app listening on ${runtimePort}`)) {
    throw new Error(
      `Expected runtime log line, got:\n${logs.stdout}\n${logs.stderr}`,
    );
  }

  await request("/crash");
  const statusAfterCrash = await waitForRestartCountAtLeast(1);
  if (!statusAfterCrash.stdout.includes("- health: ok")) {
    throw new Error(
      `Expected healthy status after crash restart, got:\n${statusAfterCrash.stdout}\n${statusAfterCrash.stderr}`,
    );
  }

  const managedChildPid = parseChildPid(statusAfterCrash.stdout);
  if (!managedChildPid) {
    throw new Error(
      `Expected child pid after crash restart, got:
${statusAfterCrash.stdout}
${statusAfterCrash.stderr}`,
    );
  }


  const restoreWhileRunning = await run(["restore"]);
  if (!restoreWhileRunning.stdout.includes("already running")) {
    throw new Error(
      `Expected idempotent restore output, got:\n${restoreWhileRunning.stdout}\n${restoreWhileRunning.stderr}`,
    );
  }

  await run(["down", appName]);
} catch (error) {
  await cleanup();
  throw error;
}
