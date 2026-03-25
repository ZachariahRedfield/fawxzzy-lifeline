import { isProcessAlive, stopProcess } from "../core/process-manager.js";
import { getAppState, upsertAppState } from "../core/state-store.js";

export async function runDownCommand(appName: string): Promise<number> {
  const state = await getAppState(appName);
  if (!state) {
    console.error(`No runtime state found for app ${appName}.`);
    return 1;
  }

  if (state.listenerPid && (await isProcessAlive(state.listenerPid))) {
    await stopProcess(state.listenerPid);
  }

  if (state.childPid && (await isProcessAlive(state.childPid))) {
    await stopProcess(state.childPid);
  }

  await stopProcess(state.supervisorPid);
  await upsertAppState({
    ...state,
    childPid: undefined,
    listenerPid: undefined,
    portOwnerPid: undefined,
    blockedReason: undefined,
    lastKnownStatus: "stopped",
    lastExitAt: new Date().toISOString(),
  });
  console.log(`App ${appName} has been stopped.`);
  return 0;
}
