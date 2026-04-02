import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import typescript from "typescript";

async function transpileHealthcheckModule(tempRoot) {
  const relativePath = "healthcheck.ts";
  const sourcePath = path.join("src", "core", relativePath);
  const source = await readFile(sourcePath, "utf8");
  const transpiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.ES2022,
      target: typescript.ScriptTarget.ES2022,
    },
    fileName: sourcePath,
  });

  const destinationPath = path.join(tempRoot, "core", "healthcheck.js");
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, transpiled.outputText, "utf8");

  return destinationPath;
}

async function loadHealthcheckHelpersFromSource() {
  const transpileRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-healthcheck-transpile-"));
  try {
    const modulePath = await transpileHealthcheckModule(transpileRoot);
    const moduleUrl = pathToFileURL(modulePath).href;
    const module = await import(moduleUrl);
    return {
      transpileRoot,
      checkHealth: module.checkHealth,
      waitForHealth: module.waitForHealth,
    };
  } catch (error) {
    await rm(transpileRoot, { recursive: true, force: true });
    throw error;
  }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function getPort(server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected server to expose numeric address");
  }
  return address.port;
}

async function closeServer(server) {
  if (!server.listening) {
    return;
  }
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function reservePortThenRelease() {
  const server = http.createServer((_req, res) => {
    res.statusCode = 204;
    res.end();
  });

  await listen(server);
  const port = getPort(server);
  await closeServer(server);
  return port;
}

const { checkHealth, waitForHealth, transpileRoot } = await loadHealthcheckHelpersFromSource();

const alwaysHealthyServer = http.createServer((_req, res) => {
  res.statusCode = 200;
  res.end("ok");
});

const alwaysUnhealthyServer = http.createServer((_req, res) => {
  res.statusCode = 503;
  res.end("unhealthy");
});

const delayedHealthyServer = http.createServer((_req, res) => {
  res.statusCode = 200;
  res.end("ready");
});

try {
  await listen(alwaysHealthyServer);
  const healthyResult = await checkHealth(getPort(alwaysHealthyServer), "/health");
  assert.deepEqual(healthyResult, { ok: true, status: 200 });

  await listen(alwaysUnhealthyServer);
  const unhealthyResult = await checkHealth(getPort(alwaysUnhealthyServer), "/health");
  assert.deepEqual(unhealthyResult, { ok: false, status: 503, error: "HTTP 503" });

  const noServerPort = await reservePortThenRelease();
  const noListenerResult = await checkHealth(noServerPort, "/health");
  assert.equal(noListenerResult.ok, false);
  assert.equal(typeof noListenerResult.error, "string");
  assert.match(noListenerResult.error, /fetch failed|ECONNREFUSED/i);

  const delayedPort = await reservePortThenRelease();
  const delayedStartTimer = setTimeout(() => {
    delayedHealthyServer.listen(delayedPort, "127.0.0.1");
  }, 250);

  const eventualSuccessResult = await waitForHealth(delayedPort, "/health", 3_000);
  clearTimeout(delayedStartTimer);
  assert.deepEqual(eventualSuccessResult, { ok: true, status: 200 });

  const timeoutResult = await waitForHealth(getPort(alwaysUnhealthyServer), "/health", 100);
  assert.deepEqual(timeoutResult, { ok: false, status: 503, error: "HTTP 503" });

  console.log("healthcheck deterministic verification passed.");
} finally {
  await Promise.all([
    closeServer(alwaysHealthyServer),
    closeServer(alwaysUnhealthyServer),
    closeServer(delayedHealthyServer),
    rm(transpileRoot, { recursive: true, force: true }),
  ]);
}
