import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const cli = ["node", "dist/cli.js"];
const statePath = ".lifeline/state.json";

const uniqueSuffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
const stoppedAppName = `runtime-smoke-restore-mixed-stopped-${uniqueSuffix}`;
const crashLoopAppName = `runtime-smoke-restore-mixed-crash-loop-${uniqueSuffix}`;
const blockedAppName = `runtime-smoke-restore-mixed-blocked-${uniqueSuffix}`;

const stoppedPort = 7200 + Math.floor(Math.random() * 100);
const crashLoopPort = 7300 + Math.floor(Math.random() * 100);
const blockedPort = 7400 + Math.floor(Math.random() * 100);

let tempRootDir;
let blockedForeignServer;

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
  for (let i = 0; i < 80; i += 1) {
    if (!isPidAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for pid ${pid} to exit`);
}

function canBindPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function readAllRuntimeState() {
  const raw = await readFile(statePath, "utf8").catch(() => "");
  if (!raw) {
    return undefined;
  }

  const parsed = JSON.parse(raw);
  return parsed?.apps;
}

async function readAppState(appName) {
  const apps = await readAllRuntimeState();
  return apps?.[appName];
}

async function waitForRuntime(appName, predicate, label) {
  for (let i = 0; i < 80; i += 1) {
    const state = await readAppState(appName);
    if (state && predicate(state)) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const latestStatus = await run(["status", appName], { allowFailure: true });
  throw new Error(
    `Timed out waiting for ${label} (${appName}).\nstatus:\n${latestStatus.stdout}\n${latestStatus.stderr}`,
  );
}

async function waitForRunning(appName) {
  return waitForRuntime(
    appName,
    (state) =>
      state.lastKnownStatus === "running" &&
      isPidAlive(state.supervisorPid) &&
      isPidAlive(state.childPid),
    "running state with live managed supervisor and child",
  );
}

async function waitForStoppedWithHistory() {
  for (let i = 0; i < 80; i += 1) {
    const status = await run(["status", stoppedAppName], { allowFailure: true });
    const state = await readAppState(stoppedAppName);
    const childStoppedOrDead =
      status.stdout.includes("- child: dead") || status.stdout.includes("- child: stopped");

    if (
      status.code !== 0 &&
      status.stdout.includes(`App ${stoppedAppName} is stopped.`) &&
      childStoppedOrDead &&
      status.stdout.includes("- portOwner: none") &&
      state?.lastKnownStatus === "stopped"
    ) {
      return state;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const latestStatus = await run(["status", stoppedAppName], { allowFailure: true });
  throw new Error(
    `Timed out waiting for stopped status output with persisted history.\nstdout:\n${latestStatus.stdout}\nstderr:\n${latestStatus.stderr}`,
  );
}

async function waitForCrashLoopState() {
  for (let i = 0; i < 700; i += 1) {
    const state = await readAppState(crashLoopAppName);
    if (state?.lastKnownStatus === "crash-loop" && state.crashLoopDetected) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const latestStatus = await run(["status", crashLoopAppName], { allowFailure: true });
  throw new Error(
    `Timed out waiting for crash-loop persisted state (${crashLoopAppName}).\nstatus:\n${latestStatus.stdout}\n${latestStatus.stderr}`,
  );
}

async function waitForBlockedState(expectedForeignPid) {
  for (let i = 0; i < 80; i += 1) {
    const status = await run(["status", blockedAppName], { allowFailure: true });
    const state = await readAppState(blockedAppName);
    if (
      status.stdout.includes(`App ${blockedAppName} is blocked.`) &&
      status.stdout.includes(`- portOwner: pid ${expectedForeignPid}`) &&
      state?.lastKnownStatus === "blocked"
    ) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const latestStatus = await run(["status", blockedAppName], { allowFailure: true });
  throw new Error(
    `Timed out waiting for blocked state with foreign owner.\nstdout:\n${latestStatus.stdout}\nstderr:\n${latestStatus.stderr}`,
  );
}

async function createManifest(appName, port, { restartPolicy = "never", startCommand } = {}) {
  const fixtureDirName = appName;
  const tempFixtureDir = path.join(tempRootDir, fixtureDirName);

  await cp("fixtures/runtime-smoke-app", tempFixtureDir, { recursive: true });

  const envPath = path.join(tempFixtureDir, ".env.runtime");
  const envRaw = await readFile(envPath, "utf8");
  await writeFile(envPath, envRaw.replace(/^PORT=.*$/m, `PORT=${port}`), "utf8");

  const manifestPath = path.join(tempFixtureDir, "runtime-smoke-app.lifeline.yml");
  const manifestRaw = await readFile(manifestPath, "utf8");

  let manifestNext = manifestRaw
    .replace(/^name: .*$/m, `name: ${appName}`)
    .replace(/^port: .*$/m, `port: ${port}`)
    .replace(/^  restartPolicy: .*$/m, `  restartPolicy: ${restartPolicy}`);

  if (startCommand) {
    manifestNext = manifestNext.replace(/^startCommand: .*$/m, `startCommand: ${startCommand}`);
  }

  await writeFile(manifestPath, manifestNext, "utf8");
  return manifestPath;
}

async function startBlockedForeignServer() {
  blockedForeignServer = spawn(
    process.execPath,
    [
      "-e",
      `const http=require("node:http");const port=${blockedPort};http.createServer((req,res)=>{if(req.url==="/health"){res.writeHead(200);res.end("ok");return;}res.writeHead(200);res.end("foreign");}).listen(port,"127.0.0.1");setInterval(()=>{},1000);`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const stderrChunks = [];
  blockedForeignServer.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  await new Promise((resolve) => setTimeout(resolve, 300));

  if (!blockedForeignServer.pid || !isPidAlive(blockedForeignServer.pid)) {
    throw new Error(`Failed to start blocked foreign port owner. stderr:\n${stderrChunks.join("")}`);
  }

  return blockedForeignServer.pid;
}

async function assertBlockedForeignServing() {
  const response = await fetch(`http://127.0.0.1:${blockedPort}/`);
  const body = await response.text();

  if (response.status !== 200 || body !== "foreign") {
    throw new Error(
      `Expected blocked foreign server to continue serving on port ${blockedPort}, got status=${response.status} body=${body}`,
    );
  }
}

async function stopBlockedForeignServer() {
  if (!blockedForeignServer?.pid) {
    return;
  }

  if (isPidAlive(blockedForeignServer.pid)) {
    process.kill(blockedForeignServer.pid, "SIGTERM");
    await waitForPidExit(blockedForeignServer.pid).catch(async () => {
      process.kill(blockedForeignServer.pid, "SIGKILL");
      await waitForPidExit(blockedForeignServer.pid);
    });
  }

  blockedForeignServer = undefined;
}

async function cleanup() {
  await stopBlockedForeignServer();
  await run(["down", stoppedAppName], { allowFailure: true });
  await run(["down", crashLoopAppName], { allowFailure: true });
  await run(["down", blockedAppName], { allowFailure: true });
}

try {
  tempRootDir = await mkdtemp(path.join(tmpdir(), "lifeline-runtime-restore-mixed-skipped-smoke-"));
  await cleanup();

  const stoppedManifestPath = await createManifest(stoppedAppName, stoppedPort, { restartPolicy: "never" });
  const crashLoopManifestPath = await createManifest(crashLoopAppName, crashLoopPort, {
    restartPolicy: "on-failure",
    startCommand:
      'node -e "const s=require(\'node:net\').createServer();s.listen(Number(process.env.PORT||0),\'127.0.0.1\',()=>setTimeout(()=>process.exit(17),100));"',
  });
  const blockedManifestPath = await createManifest(blockedAppName, blockedPort, { restartPolicy: "never" });

  await run(["up", stoppedManifestPath]);
  await run(["up", crashLoopManifestPath], { allowFailure: true });
  await run(["up", blockedManifestPath]);

  const stoppedRunningState = await waitForRunning(stoppedAppName);
  const blockedRunningState = await waitForRunning(blockedAppName);
  const crashLoopState = await waitForCrashLoopState();

  if (!stoppedRunningState.childPid || !isPidAlive(stoppedRunningState.childPid)) {
    throw new Error("Expected stopped candidate app to have live child before forcing persisted stopped state");
  }

  if (!blockedRunningState.childPid || !isPidAlive(blockedRunningState.childPid)) {
    throw new Error("Expected blocked candidate app to have live child before forcing persisted blocked state");
  }

  if (crashLoopState.lastExitCode !== 17) {
    throw new Error(`Expected deterministic crash-loop exit code 17, found ${crashLoopState.lastExitCode}`);
  }

  process.kill(stoppedRunningState.childPid, "SIGKILL");
  await waitForPidExit(stoppedRunningState.childPid);
  const stoppedBeforeRestore = await waitForStoppedWithHistory();

  process.kill(blockedRunningState.childPid, "SIGKILL");
  await waitForPidExit(blockedRunningState.childPid);
  const blockedForeignPid = await startBlockedForeignServer();
  const blockedBeforeRestore = await waitForBlockedState(blockedForeignPid);

  if (stoppedBeforeRestore.lastKnownStatus !== "stopped") {
    throw new Error(`Expected persisted stopped status before restore, found ${stoppedBeforeRestore.lastKnownStatus}`);
  }

  if (blockedBeforeRestore.lastKnownStatus !== "blocked") {
    throw new Error(`Expected persisted blocked status before restore, found ${blockedBeforeRestore.lastKnownStatus}`);
  }

  if (!(await canBindPort(stoppedPort))) {
    throw new Error(`Expected stopped app port ${stoppedPort} to be free before restore`);
  }

  if (!(await canBindPort(crashLoopPort))) {
    throw new Error(`Expected crash-loop app port ${crashLoopPort} to be free before restore`);
  }

  if (await canBindPort(blockedPort)) {
    throw new Error(`Expected blocked app port ${blockedPort} to remain bound by foreign owner before restore`);
  }

  const restoreResult = await run(["restore"], { allowFailure: true });
  if (restoreResult.code !== 0) {
    throw new Error(
      `Expected restore to succeed for all-skipped mixed persisted states.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  const expectedSkipLines = [
    `Skipping ${stoppedAppName}: last known status is stopped; not restorable as running.`,
    `Skipping ${crashLoopAppName}: last known status is crash-loop; not restorable as running.`,
    `Skipping ${blockedAppName}: last known status is blocked; not restorable as running.`,
  ];

  for (const expectedLine of expectedSkipLines) {
    if (!restoreResult.stdout.includes(expectedLine)) {
      throw new Error(
        `Expected restore output to include explicit mixed-batch skip line:\n${expectedLine}\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
      );
    }
  }

  if (!restoreResult.stdout.includes("No restorable apps required restart.")) {
    throw new Error(
      `Expected restore output to summarize mixed all-skipped batch with no restarts required.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (restoreResult.stdout.includes("No managed apps found in .lifeline/state.json.")) {
    throw new Error(
      `Expected restore not to misclassify mixed persisted skipped states as no managed apps.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  if (
    restoreResult.stdout.includes(`Restored ${stoppedAppName} with supervisor pid`) ||
    restoreResult.stdout.includes(`Restored ${crashLoopAppName} with supervisor pid`) ||
    restoreResult.stdout.includes(`Restored ${blockedAppName} with supervisor pid`)
  ) {
    throw new Error(
      `Expected restore not to relaunch any app in all-skipped mixed batch.\nstdout:\n${restoreResult.stdout}\nstderr:\n${restoreResult.stderr}`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 1200));

  const statusStoppedAfterRestore = await run(["status", stoppedAppName], { allowFailure: true });
  const statusCrashLoopAfterRestore = await run(["status", crashLoopAppName], { allowFailure: true });
  const statusBlockedAfterRestore = await run(["status", blockedAppName], { allowFailure: true });

  if (statusStoppedAfterRestore.code === 0 || !statusStoppedAfterRestore.stdout.includes(`App ${stoppedAppName} is stopped.`)) {
    throw new Error(
      `Expected stopped app to remain non-running after restore.\nstdout:\n${statusStoppedAfterRestore.stdout}\nstderr:\n${statusStoppedAfterRestore.stderr}`,
    );
  }

  if (
    statusCrashLoopAfterRestore.code === 0 ||
    !statusCrashLoopAfterRestore.stdout.includes(`App ${crashLoopAppName} is crash-loop.`)
  ) {
    throw new Error(
      `Expected crash-loop app to remain crash-loop after restore.\nstdout:\n${statusCrashLoopAfterRestore.stdout}\nstderr:\n${statusCrashLoopAfterRestore.stderr}`,
    );
  }

  if (statusBlockedAfterRestore.code === 0 || !statusBlockedAfterRestore.stdout.includes(`App ${blockedAppName} is blocked.`)) {
    throw new Error(
      `Expected blocked app to remain blocked after restore.\nstdout:\n${statusBlockedAfterRestore.stdout}\nstderr:\n${statusBlockedAfterRestore.stderr}`,
    );
  }

  if (!(await canBindPort(stoppedPort))) {
    throw new Error(`Expected stopped app port ${stoppedPort} to remain free after restore`);
  }

  if (!(await canBindPort(crashLoopPort))) {
    throw new Error(`Expected crash-loop app port ${crashLoopPort} to remain free after restore`);
  }

  if (await canBindPort(blockedPort)) {
    throw new Error(`Expected blocked app port ${blockedPort} to remain bound by foreign owner after restore`);
  }

  if (!isPidAlive(blockedForeignPid)) {
    throw new Error(`Expected blocked foreign owner pid ${blockedForeignPid} to remain alive after restore`);
  }

  await assertBlockedForeignServing();

  console.log("runtime restore mixed all-skipped smoke passed");
} finally {
  await cleanup().catch(() => {});
  if (tempRootDir) {
    await rm(tempRootDir, { recursive: true, force: true }).catch(() => {});
  }
}
