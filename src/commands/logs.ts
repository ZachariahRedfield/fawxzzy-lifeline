import { tailLogFile } from "../core/log-store.js";
import { getAppState } from "../core/state-store.js";

export async function runLogsCommand(appName: string, lineCount = 100): Promise<number> {
  const state = await getAppState(appName);
  if (!state) {
    console.error(`No runtime state found for app ${appName}.`);
    return 1;
  }

  const lines = await tailLogFile(state.logPath, lineCount);
  if (lines.length === 0) {
    console.log(`No logs found for app ${appName} at ${state.logPath}.`);
    return 0;
  }

  console.log(lines.join("\n"));
  return 0;
}
