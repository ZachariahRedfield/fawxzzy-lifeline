import { checkHealth } from "../core/healthcheck.js";
import { isProcessAlive } from "../core/process-manager.js";
import { getAppState, upsertAppState } from "../core/state-store.js";

export async function runStatusCommand(appName: string): Promise<number> {
  const state = await getAppState(appName);
  if (!state) {
    console.error(`No runtime state found for app ${appName}.`);
    return 1;
  }

  const supervisorAlive = await isProcessAlive(state.supervisorPid);
  const childAlive = state.childPid
    ? await isProcessAlive(state.childPid)
    : false;

  if (!supervisorAlive) {
    state.lastKnownStatus = state.crashLoopDetected ? "crash-loop" : "stopped";
    await upsertAppState(state);
  }

  const health = childAlive
    ? await checkHealth(state.port, state.healthcheckPath)
    : { ok: false, error: "child process not running", status: undefined };

  if (supervisorAlive && childAlive) {
    state.lastKnownStatus = health.ok ? "running" : "unhealthy";
    await upsertAppState(state);
  }

  console.log(`App ${appName} is ${state.lastKnownStatus}.`);
  console.log(
    `- supervisor: ${supervisorAlive ? `alive (pid ${state.supervisorPid})` : `stopped (pid ${state.supervisorPid})`}`,
  );
  console.log(
    `- child: ${childAlive ? `alive (pid ${state.childPid})` : "stopped"}`,
  );
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

  return supervisorAlive && childAlive && health.ok ? 0 : 1;
}
