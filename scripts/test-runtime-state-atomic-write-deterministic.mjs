import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-runtime-state-atomic-"));
const originalCwd = process.cwd();

try {
  process.chdir(tempRoot);

  const stateStoreModule = await import(new URL("../dist/core/state-store.js", import.meta.url));
  const { getStatePath, readState, upsertAppState } = stateStoreModule;

  const appName = "atomic-runtime-state-check";
  const writeCount = 200;

  for (let index = 0; index < writeCount; index += 1) {
    await upsertAppState({
      name: appName,
      manifestPath: `/manifests/${appName}.mjs`,
      playbookPath: undefined,
      workingDirectory: "/tmp",
      supervisorPid: 4200 + index,
      childPid: undefined,
      wrapperPid: undefined,
      listenerPid: undefined,
      portOwnerPid: undefined,
      port: 9000,
      healthcheckPath: "/healthz",
      logPath: `/logs/${appName}.log`,
      startedAt: new Date(0).toISOString(),
      lastKnownStatus: index % 2 === 0 ? "running" : "unhealthy",
      restartPolicy: "on-failure",
      restartCount: index,
      lastExitCode: index,
      lastExitAt: undefined,
      restorable: true,
      crashLoopDetected: false,
      blockedReason: undefined,
    });
  }

  const statePath = await getStatePath();
  const rawState = await readFile(statePath, "utf8");

  if (!rawState.endsWith("\n")) {
    throw new Error("Expected runtime state file to preserve trailing newline formatting.");
  }

  let parsedState;
  try {
    parsedState = JSON.parse(rawState);
  } catch (error) {
    throw new Error(`Expected valid JSON in final runtime state file. Error: ${String(error)}`);
  }

  const finalAppState = parsedState?.apps?.[appName];
  if (!finalAppState) {
    throw new Error(`Expected app ${appName} to be present in persisted runtime state.`);
  }

  if (finalAppState.restartCount !== writeCount - 1) {
    throw new Error(
      `Expected restartCount ${writeCount - 1}, received ${String(finalAppState.restartCount)}.`,
    );
  }

  if (finalAppState.supervisorPid !== 4200 + (writeCount - 1)) {
    throw new Error(
      `Expected supervisorPid ${4200 + (writeCount - 1)}, received ${String(finalAppState.supervisorPid)}.`,
    );
  }

  const loadedState = await readState();
  if (loadedState.apps[appName]?.restartCount !== writeCount - 1) {
    throw new Error("Expected readState() to return final persisted runtime state values.");
  }

  console.log("Runtime state atomic write deterministic verification passed.");
} finally {
  process.chdir(originalCwd);
}
