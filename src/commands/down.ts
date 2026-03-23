import { stopProcess } from "../core/process-manager.js";
import { getAppState, removeAppState } from "../core/state-store.js";

export async function runDownCommand(appName: string): Promise<number> {
  const state = await getAppState(appName);
  if (!state) {
    console.error(`No runtime state found for app ${appName}.`);
    return 1;
  }

  await stopProcess(state.pid);
  await removeAppState(appName);
  console.log(`App ${appName} has been stopped.`);
  return 0;
}
