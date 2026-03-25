import path from "node:path";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

import { loadEnvFile } from "./load-env-file.js";
import { appendLogHeader } from "./log-store.js";
import { resolveManifestConfig } from "./resolve-config.js";
import { getAppState, upsertAppState } from "./state-store.js";

const RESTART_WINDOW_MS = 60_000;
const RESTART_THRESHOLD = 5;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeBackoffMs(restartCount: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, restartCount - 1));
}

export async function runSupervisor(appName: string): Promise<number> {
  const current = await getAppState(appName);
  if (!current) {
    console.error(`No runtime state found for app ${appName}.`);
    return 1;
  }

  const resolved = await resolveManifestConfig({
    manifestPath: current.manifestPath,
    ...(current.playbookPath ? { playbookPath: current.playbookPath } : {}),
  });

  const fileEnv = resolved.resolvedManifest.env.file
    ? await loadEnvFile(
        path.resolve(
          path.dirname(current.manifestPath),
          resolved.resolvedManifest.env.file,
        ),
      )
    : {};

  const env: NodeJS.ProcessEnv = {
    ...fileEnv,
    ...process.env,
  };

  const recentRestarts: number[] = [];
  let shouldStop = false;

  process.on("SIGTERM", () => {
    shouldStop = true;
  });
  process.on("SIGINT", () => {
    shouldStop = true;
  });

  await upsertAppState({
    ...current,
    supervisorPid: process.pid,
    childPid: undefined,
    startedAt: new Date().toISOString(),
    lastKnownStatus: "stopped",
  });
  await appendLogHeader(
    current.logPath,
    `[supervisor] ${new Date().toISOString()} supervisor started (pid ${process.pid})`,
  );

  while (!shouldStop) {
    const state = await getAppState(appName);
    if (!state) {
      return 0;
    }

    const logStream = createWriteStream(state.logPath, { flags: "a" });
    const child = spawn(resolved.resolvedManifest.startCommand, {
      cwd: state.workingDirectory,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (!child.pid) {
      await appendLogHeader(
        state.logPath,
        `[supervisor] ${new Date().toISOString()} failed to spawn child process`,
      );
      return 1;
    }

    child.stdout.on("data", (chunk) => {
      logStream.write(`[app:stdout] ${String(chunk)}`);
    });
    child.stderr.on("data", (chunk) => {
      logStream.write(`[app:stderr] ${String(chunk)}`);
    });

    await upsertAppState({
      ...state,
      supervisorPid: process.pid,
      childPid: child.pid,
      lastKnownStatus: "running",
      crashLoopDetected: false,
    });
    await appendLogHeader(
      state.logPath,
      `[supervisor] ${new Date().toISOString()} child started (pid ${child.pid})`,
    );

    const exit = await new Promise<{
      code: number | null;
      signal: string | null;
    }>((resolve) => {
      child.on("exit", (code, signal) =>
        resolve({ code, signal: signal ?? null }),
      );
    });

    logStream.end();

    const exitedAt = new Date().toISOString();
    const latest = await getAppState(appName);
    if (!latest) {
      return 0;
    }

    const nextState = {
      ...latest,
      childPid: undefined,
      lastExitCode: exit.code ?? undefined,
      lastExitAt: exitedAt,
      lastKnownStatus: "stopped" as const,
    };

    await appendLogHeader(
      latest.logPath,
      `[supervisor] ${exitedAt} child exited (${exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? "unknown"}`})`,
    );

    if (shouldStop) {
      await upsertAppState(nextState);
      return 0;
    }

    const shouldRestart =
      latest.restartPolicy === "on-failure" &&
      exit.code !== 0 &&
      exit.signal !== "SIGTERM";

    if (!shouldRestart) {
      await upsertAppState(nextState);
      return 0;
    }

    const now = Date.now();
    recentRestarts.push(now);
    while (
      recentRestarts.length > 0 &&
      now - (recentRestarts[0] ?? now) > RESTART_WINDOW_MS
    ) {
      recentRestarts.shift();
    }

    if (recentRestarts.length > RESTART_THRESHOLD) {
      await upsertAppState({
        ...nextState,
        crashLoopDetected: true,
        lastKnownStatus: "crash-loop",
      });
      await appendLogHeader(
        latest.logPath,
        `[supervisor] ${new Date().toISOString()} crash loop detected; stopping restarts`,
      );
      return 1;
    }

    const restartCount = latest.restartCount + 1;
    const backoffMs = computeBackoffMs(restartCount);

    await upsertAppState({
      ...nextState,
      restartCount,
      crashLoopDetected: false,
    });
    await appendLogHeader(
      latest.logPath,
      `[supervisor] ${new Date().toISOString()} restarting in ${backoffMs}ms (attempt ${restartCount})`,
    );
    await delay(backoffMs);
  }

  return 0;
}
