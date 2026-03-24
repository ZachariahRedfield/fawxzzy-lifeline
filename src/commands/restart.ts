import { getAppState } from "../core/state-store.js";
import { runDownCommand } from "./down.js";
import { runUpCommand } from "./up.js";

export async function runRestartCommand(
  appName: string,
  playbookPath?: string,
): Promise<number> {
  const state = await getAppState(appName);
  if (!state) {
    console.error(`No runtime state found for app ${appName}.`);
    return 1;
  }

  const downCode = await runDownCommand(appName);
  if (downCode !== 0) {
    return downCode;
  }

  return runUpCommand(state.manifestPath, playbookPath ?? state.playbookPath);
}
