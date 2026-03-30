import {
  findListeningPortOwnerPid,
  isProcessAlive,
} from "../core/process-manager.js";
import { checkHealth } from "../core/healthcheck.js";
import { getAppState, upsertAppState } from "../core/state-store.js";

export async function runStatusCommand(appName: string): Promise<number> {
  const state = await getAppState(appName);
  if (!state) {
    console.error(`No runtime state found for app ${appName}.`);
    return 1;
  }

  const supervisorAlive = await isProcessAlive(state.supervisorPid);
  const wrapperAlive = state.wrapperPid
    ? await isProcessAlive(state.wrapperPid)
    : false;
  const listenerAlive = state.listenerPid
    ? await isProcessAlive(state.listenerPid)
    : false;
  const portOwnerPid = await findListeningPortOwnerPid(state.port);

  const inferredManagedPid = state.childPid ?? state.listenerPid;
  const managedChildAlive = inferredManagedPid ? await isProcessAlive(inferredManagedPid) : false;
  const managedPortOwner =
    Boolean(portOwnerPid) &&
    Boolean(
      (state.childPid && portOwnerPid === state.childPid) ||
        (state.listenerPid && portOwnerPid === state.listenerPid),
    );

  if (!supervisorAlive) {
    if (portOwnerPid) {
      state.lastKnownStatus = "blocked";
      state.blockedReason = `port ${state.port} occupied by pid ${portOwnerPid}`;
    } else {
      state.lastKnownStatus = state.crashLoopDetected ? "crash-loop" : "stopped";
      state.blockedReason = undefined;
    }
  }

  const shouldCheckHealth = Boolean(portOwnerPid || managedChildAlive);
  const health = shouldCheckHealth
    ? await checkHealth(state.port, state.healthcheckPath)
    : { ok: false, error: "managed app process not running", status: undefined };

  if (supervisorAlive && health.ok && managedChildAlive && managedPortOwner) {
    state.lastKnownStatus = "running";
    state.childPid = inferredManagedPid;
    state.blockedReason = undefined;
  } else if (supervisorAlive && managedPortOwner && !health.ok) {
    state.lastKnownStatus = "unhealthy";
    state.blockedReason = undefined;
  } else if (supervisorAlive && !managedChildAlive && portOwnerPid) {
    state.lastKnownStatus = "blocked";
    state.blockedReason = `port ${state.port} occupied by pid ${portOwnerPid}`;
  } else if (supervisorAlive) {
    state.lastKnownStatus = "stopped";
    state.blockedReason = undefined;
  }

  state.portOwnerPid = portOwnerPid;
  await upsertAppState(state);

  console.log(`App ${appName} is ${state.lastKnownStatus}.`);
  console.log(
    `- supervisor: ${supervisorAlive ? `alive (pid ${state.supervisorPid})` : `stopped (pid ${state.supervisorPid})`}`,
  );
  console.log(
    `- child: ${managedChildAlive ? `alive (pid ${inferredManagedPid})` : "stopped"}`,
  );
  console.log(
    `- wrapper: ${wrapperAlive ? `alive (pid ${state.wrapperPid})` : "stopped"}`,
  );
  console.log(
    `- listener: ${listenerAlive ? `alive (pid ${state.listenerPid})` : "unknown/stopped"}`,
  );
  console.log(`- portOwner: ${portOwnerPid ? `pid ${portOwnerPid}` : "none"}`);
  console.log(`- startedAt: ${state.startedAt}`);
  console.log(`- port: ${state.port}`);
  console.log(`- log: ${state.logPath}`);
  console.log(`- manifest: ${state.manifestPath}`);
  if (state.playbookPath) {
    console.log(`- playbook: ${state.playbookPath}`);
  }
  console.log(`- restartPolicy: ${state.restartPolicy}`);
  console.log(`- restartCount: ${state.restartCount}`);
  console.log(`- crashLoopDetected: ${state.crashLoopDetected}`);
  if (state.blockedReason) {
    console.log(`- blockedReason: ${state.blockedReason}`);
  }
  if (state.lastExitCode !== undefined) {
    console.log(`- lastExitCode: ${state.lastExitCode}`);
  }
  if (state.lastExitAt) {
    console.log(`- lastExitAt: ${state.lastExitAt}`);
  }
  console.log(
    `- healthcheck: http://127.0.0.1:${state.port}${state.healthcheckPath}`,
  );
  console.log(
    `- health: ${health.ok ? `ok (${health.status ?? 200})` : (health.error ?? "failed")}`,
  );

  return supervisorAlive && health.ok && managedChildAlive && managedPortOwner ? 0 : 1;
}
