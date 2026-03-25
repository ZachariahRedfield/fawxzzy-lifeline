import {
  findListeningPortOwnerPid,
  isProcessAlive,
  stopProcess,
  waitForPortToClear,
} from "../core/process-manager.js";
import { checkHealth } from "../core/healthcheck.js";
import { getAppState, upsertAppState } from "../core/state-store.js";

const PORT_CLEAR_TIMEOUT_MS = 12_000;

export async function runDownCommand(appName: string): Promise<number> {
  const state = await getAppState(appName);
  if (!state) {
    console.error(`No runtime state found for app ${appName}.`);
    return 1;
  }

  const trackedPids = [
    state.supervisorPid,
    state.wrapperPid,
    state.listenerPid,
    state.childPid,
  ].filter((pid): pid is number => Number.isInteger(pid));
  const uniqueTrackedPids = [...new Set(trackedPids)];

  for (const pid of uniqueTrackedPids) {
    if (await isProcessAlive(pid)) {
      await stopProcess(pid);
    }
  }

  const remainingOwnerPid = await findListeningPortOwnerPid(state.port);
  const trackedPidSet = new Set(uniqueTrackedPids);

  if (remainingOwnerPid && (await isProcessAlive(remainingOwnerPid))) {
    const health = await checkHealth(state.port, state.healthcheckPath);
    const clearlyManagedOwner = trackedPidSet.has(remainingOwnerPid) || health.ok;

    if (clearlyManagedOwner) {
      await stopProcess(remainingOwnerPid);
    }
  }

  const portReleased = await waitForPortToClear(state.port, PORT_CLEAR_TIMEOUT_MS);
  if (!portReleased) {
    const blockedOwnerPid = await findListeningPortOwnerPid(state.port);
    const blockedReason = blockedOwnerPid
      ? `down failed: port ${state.port} still occupied by pid ${blockedOwnerPid}`
      : `down failed: port ${state.port} did not clear within ${PORT_CLEAR_TIMEOUT_MS}ms`;

    await upsertAppState({
      ...state,
      childPid: undefined,
      wrapperPid: undefined,
      listenerPid: undefined,
      portOwnerPid: blockedOwnerPid,
      blockedReason,
      lastKnownStatus: "blocked",
      lastExitAt: new Date().toISOString(),
    });

    console.error(`App ${appName} could not be fully stopped: ${blockedReason}.`);
    return 1;
  }

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
