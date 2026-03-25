import { isProcessAlive, stopProcess } from "../core/process-manager.js";
import { getAppState, upsertAppState } from "../core/state-store.js";

export async function runDownCommand(appName: string): Promise<number> {
  const state = await getAppState(appName);
  if (!state) {
    console.error(`No runtime state found for app ${appName}.`);
    return 1;
  }

  const pidsToStop = [state.childPid, state.listenerPid, state.wrapperPid]
    .filter((pid): pid is number => Number.isInteger(pid))
    .filter((pid, index, arr) => arr.indexOf(pid) === index);

  for (const pid of pidsToStop) {
    if (await isProcessAlive(pid)) {
      await stopProcess(pid);
    }
  }

  await stopProcess(state.supervisorPid);
  await upsertAppState({
    ...state,
    childPid: undefined,
    wrapperPid: undefined,
    listenerPid: undefined,
    portOwnerPid: undefined,
    blockedReason: undefined,
    lastKnownStatus: "stopped",
    lastExitAt: new Date().toISOString(),
  });
  console.log(`App ${appName} has been stopped.`);
  return 0;
}
