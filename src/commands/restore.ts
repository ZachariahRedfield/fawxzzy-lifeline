import {
  isProcessAlive,
  startDetachedCommand,
} from "../core/process-manager.js";
import { readState } from "../core/state-store.js";

export async function runRestoreCommand(): Promise<number> {
  const state = await readState();
  const apps = Object.values(state.apps);
  if (apps.length === 0) {
    console.log("No managed apps found in .lifeline/state.json.");
    return 0;
  }

  let restored = 0;
  for (const app of apps) {
    if (!app.restorable) {
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

    const cliPath = process.argv[1] ?? "dist/cli.js";
    const supervisorPid = await startDetachedCommand({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} supervise ${JSON.stringify(app.name)}`,
      cwd: process.cwd(),
      env: process.env,
      label: `${app.name} supervisor`,
    });
    console.log(`Restored ${app.name} with supervisor pid ${supervisorPid}.`);
    restored += 1;
  }

  if (restored === 0) {
    console.log("No restorable apps required restart.");
  }

  return 0;
}
