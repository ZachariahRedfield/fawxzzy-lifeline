import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const processManagerModuleUrl = pathToFileURL(
  path.join(repoRoot, "dist", "core", "process-manager.js"),
).href;

const { waitForPortToClear } = await import(processManagerModuleUrl);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitForProcessExit(child, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(child.pid) || child.exitCode !== null) {
      return;
    }
    await delay(50);
  }

  throw new Error(`Timed out waiting for pid ${child.pid} to exit.`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to resolve an ephemeral port.")));
        return;
      }

      const { port } = address;
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        resolve(port);
      });
    });
  });
}

function spawnTcpServer(port) {
  const serverCode = `
    const net = require("node:net");
    const server = net.createServer((socket) => {
      socket.end("ok");
    });

    server.listen(${port}, "127.0.0.1", () => {
      process.stdout.write("LISTENING\\n");
    });

    process.on("SIGTERM", () => {
      server.close(() => process.exit(0));
    });

    process.on("SIGINT", () => {
      server.close(() => process.exit(0));
    });

    process.on("uncaughtException", (error) => {
      process.stderr.write(String(error && error.stack ? error.stack : error));
      process.exit(1);
    });
  `;

  const child = spawn(process.execPath, ["-e", serverCode], {
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

  const waitForListening = async () => {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      if (stdout.includes("LISTENING")) {
        return;
      }
      if (child.exitCode !== null) {
        throw new Error(`Server process exited early with code ${child.exitCode}. stderr:\n${stderr}`);
      }
      await delay(25);
    }

    throw new Error(`Timed out waiting for server pid ${child.pid} to listen on port ${port}. stderr:\n${stderr}`);
  };

  return { child, waitForListening, getStderr: () => stderr };
}

const managedPort = await getFreePort();
const foreignPort = await getFreePort();

let managed;
let foreign;

try {
  managed = spawnTcpServer(managedPort);
  await managed.waitForListening();

  managed.child.kill("SIGTERM");
  await waitForProcessExit(managed.child);

  const released = await waitForPortToClear(managedPort, 4_000);
  if (!released) {
    throw new Error(
      `Expected waitForPortToClear(${managedPort}) to return true after owner exit, got false.`,
    );
  }

  foreign = spawnTcpServer(foreignPort);
  await foreign.waitForListening();

  const stillOwned = await waitForPortToClear(foreignPort, 600);
  if (stillOwned) {
    throw new Error(
      `Expected waitForPortToClear(${foreignPort}, 600) to return false while foreign owner persists, got true.`,
    );
  }

  console.log("waitForPortToClear deterministic verification passed.");
} finally {
  const cleanup = async (entry) => {
    if (!entry?.child?.pid || !isPidAlive(entry.child.pid)) {
      return;
    }

    entry.child.kill("SIGTERM");
    try {
      await waitForProcessExit(entry.child);
    } catch {
      entry.child.kill("SIGKILL");
      await waitForProcessExit(entry.child, 1_000).catch(() => undefined);
    }
  };

  await cleanup(managed);
  await cleanup(foreign);
}
