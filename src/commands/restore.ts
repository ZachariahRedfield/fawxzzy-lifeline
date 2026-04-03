import {
  isProcessAlive,
  startDetachedCommand,
} from "../core/process-manager.js";
import { readState, upsertAppState } from "../core/state-store.js";
import { prepareRuntimeApp } from "./up.js";

export async function runRestoreCommand(): Promise<number> {
  const state = await readState();
  const apps = Object.values(state.apps);
  if (apps.length === 0) {
    console.log("No managed apps found in .lifeline/state.json.");
    return 0;
  }

  let restored = 0;
  let failures = 0;
  for (const app of apps) {
    if (!app.restorable) {
      const reason = "app is marked restorable=false.";
      console.log(`Skipping ${app.name}: ${reason}`);
      continue;
    }

    if (await isProcessAlive(app.supervisorPid)) {
      console.log(
        `Skipping ${app.name}: supervisor already running (pid ${app.supervisorPid}).`,
      );
      continue;
    }

    if (app.lastKnownStatus !== "running" && app.lastKnownStatus !== "unhealthy") {
      console.log(
        `Skipping ${app.name}: last known status is ${app.lastKnownStatus}; not restorable as running.`,
      );
      continue;
    }

    try {
      await prepareRuntimeApp(app.manifestPath, app.playbookPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await upsertAppState({
        ...app,
        childPid: undefined,
        wrapperPid: undefined,
        listenerPid: undefined,
        portOwnerPid: undefined,
        blockedReason: undefined,
        lastKnownStatus: "stopped",
        crashLoopDetected: false,
      });
      console.error(`Failed to restore ${app.name}: ${message}`);
      failures += 1;
      continue;
    }

    const cliPath = process.argv[1] ?? "dist/cli.js";
    const startedAt = new Date().toISOString();
    const supervisorPid = await startDetachedCommand({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} supervise ${JSON.stringify(app.name)}`,
      cwd: process.cwd(),
      env: process.env,
      label: `${app.name} supervisor`,
    });

    await upsertAppState({
      ...app,
      supervisorPid,
      childPid: undefined,
      wrapperPid: undefined,
      listenerPid: undefined,
      portOwnerPid: undefined,
      blockedReason: undefined,
      startedAt,
      lastKnownStatus: "stopped",
      crashLoopDetected: false,
      lastExitCode: undefined,
      lastExitAt: undefined,
    });

    console.log(`Restored ${app.name} with supervisor pid ${supervisorPid}.`);
    restored += 1;
  }

  if (restored === 0) {
    console.log("No restorable apps required restart.");
  }

  return failures > 0 ? 1 : 0;
}
