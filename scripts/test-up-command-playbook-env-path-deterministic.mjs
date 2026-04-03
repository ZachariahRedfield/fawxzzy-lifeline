import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const fixtureDir = "fixtures/runtime-smoke-app";
const runId = `${Date.now()}-${process.pid}`;
const playbookManifestName = "runtime-smoke-app.playbook.lifeline.yml";
const playbookPath = "fixtures/playbook-export";
const resolvedPlaybookPath = path.resolve(playbookPath);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalize(text) {
  return text.replace(/\r\n/g, "\n");
}

function runCli(args, env = process.env, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["dist/cli.js", ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out running lifeline ${args.join(" ")} after ${timeoutMs}ms.`));
    }, timeoutMs);

    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve({
        code: code ?? 1,
        stdout: normalize(stdout),
        stderr: normalize(stderr),
      });
    });
  });
}

async function pickFreePort() {
  const net = await import("node:net");

  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to resolve dynamic port."));
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
    server.on("error", reject);
  });
}

async function preparePlaybookFixture(tempRoot, appName, port) {
  const fixtureCopy = path.join(tempRoot, appName);
  await cp(fixtureDir, fixtureCopy, { recursive: true });

  const manifestPath = path.join(fixtureCopy, playbookManifestName);
  const manifestRaw = await readFile(manifestPath, "utf8");
  const patchedManifest = manifestRaw
    .replace("name: runtime-smoke-app", `name: ${appName}`)
    .replace(/^port:\s*\d+/m, `port: ${port}`);
  await writeFile(manifestPath, patchedManifest, "utf8");

  const envPath = path.join(fixtureCopy, ".env.runtime");
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(envPath, envRaw.replace(/^PORT=.*/m, `PORT=${port}`), "utf8");

  return manifestPath;
}

function assertSuccessSurface(name, result, appName, port) {
  assert(result.code === 0, `${name}: expected exit code 0, got ${result.code}.\n${result.stderr}`);
  assert(result.stderr.trim().length === 0, `${name}: expected empty stderr, got:\n${result.stderr}`);
  assert(
    result.stdout.includes(`App ${appName} is running.`),
    `${name}: expected running headline, got:\n${result.stdout}`,
  );
  assert(
    result.stdout.includes("- supervisor pid:"),
    `${name}: expected supervisor summary, got:\n${result.stdout}`,
  );
  assert(result.stdout.includes(`- port: ${port}`), `${name}: expected port line, got:\n${result.stdout}`);
  assert(
    result.stdout.includes("- restartPolicy: on-failure"),
    `${name}: expected restart policy summary, got:\n${result.stdout}`,
  );
  assert(
    /- health:\s+(ok|200)/.test(result.stdout),
    `${name}: expected health summary line, got:\n${result.stdout}`,
  );
}

let tempRoot;
const startedApps = new Set();

try {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-up-playbook-env-path-deterministic-"));

  const explicitAppName = `runtime-up-playbook-explicit-deterministic-${runId}`;
  const explicitPort = await pickFreePort();
  const explicitManifest = await preparePlaybookFixture(tempRoot, explicitAppName, explicitPort);

  const explicitResult = await runCli(["up", explicitManifest, "--playbook-path", playbookPath]);
  assertSuccessSurface("explicit --playbook-path", explicitResult, explicitAppName, explicitPort);
  assert(
    explicitResult.stdout.includes(`- playbook: ${resolvedPlaybookPath}`),
    `explicit --playbook-path: expected playbook line to reflect explicit path, got:\n${explicitResult.stdout}`,
  );
  startedApps.add(explicitAppName);

  const envAppName = `runtime-up-playbook-env-var-deterministic-${runId}`;
  const envPort = await pickFreePort();
  const envManifest = await preparePlaybookFixture(tempRoot, envAppName, envPort);

  const envResult = await runCli(["up", envManifest], {
    ...process.env,
    LIFELINE_PLAYBOOK_PATH: playbookPath,
  });
  assertSuccessSurface("env-var LIFELINE_PLAYBOOK_PATH", envResult, envAppName, envPort);
  assert(
    envResult.stdout.includes(`- playbook: ${resolvedPlaybookPath}`),
    `env-var LIFELINE_PLAYBOOK_PATH: expected playbook line to reflect env path, got:\n${envResult.stdout}`,
  );
  startedApps.add(envAppName);

  console.log("Up command playbook env-path deterministic verification passed.");
} finally {
  for (const appName of startedApps) {
    await runCli(["down", appName], process.env, 15000).catch(() => {});
  }

  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
