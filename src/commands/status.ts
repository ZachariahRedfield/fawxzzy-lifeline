import { checkHealth } from "../core/healthcheck.js";
import { getAppState, upsertAppState } from "../core/state-store.js";
import { isProcessAlive } from "../core/process-manager.js";

export async function runStatusCommand(appName: string): Promise<number> {
  const state = await getAppState(appName);
  if (!state) {
    console.error(`No runtime state found for app ${appName}.`);
    return 1;
  }

  const alive = await isProcessAlive(state.pid);
  if (!alive) {
    state.lastKnownStatus = "stopped";
    await upsertAppState(state);
    console.log(`App ${appName} is stopped.`);
    console.log(`- pid: ${state.pid}`);
    console.log(`- startedAt: ${state.startedAt}`);
    console.log(`- port: ${state.port}`);
    console.log(`- log: ${state.logPath}`);
    return 1;
  }

  const health = await checkHealth(state.port, state.healthcheckPath);
  state.lastKnownStatus = health.ok ? "running" : "unhealthy";
  await upsertAppState(state);

  console.log(`App ${appName} is ${state.lastKnownStatus}.`);
  console.log(`- pid: ${state.pid}`);
  console.log(`- startedAt: ${state.startedAt}`);
  console.log(`- port: ${state.port}`);
  console.log(`- log: ${state.logPath}`);
  console.log(`- manifest: ${state.manifestPath}`);
  console.log(`- healthcheck: http://127.0.0.1:${state.port}${state.healthcheckPath}`);
  console.log(`- health: ${health.ok ? `ok (${health.status ?? 200})` : health.error ?? "failed"}`);
  return health.ok ? 0 : 1;
}
