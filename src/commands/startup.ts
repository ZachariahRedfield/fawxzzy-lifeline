import {
  getStartupRegistrationStatePath,
  readStartupRegistrationState,
  updateStartupRegistrationState,
} from "../core/startup-registration.js";

export interface StartupCommandOptions {
  dryRun: boolean;
}

function printStartupStatusSummary(action: "enabled" | "disabled"): void {
  console.log(
    `Startup registration ${action} (contract state only). Platform-specific installers are not wired yet.`,
  );
}

export async function runStartupEnableCommand(
  options: StartupCommandOptions,
): Promise<number> {
  const prior = await readStartupRegistrationState();
  if (options.dryRun) {
    console.log("[dry-run] Would mark startup registration as enabled.");
    console.log(
      `[dry-run] Scope ${prior.scope} target ${prior.target} via backend ${prior.backend}.`,
    );
    return 0;
  }

  await updateStartupRegistrationState(true);
  printStartupStatusSummary("enabled");
  return 0;
}

export async function runStartupDisableCommand(
  options: StartupCommandOptions,
): Promise<number> {
  const prior = await readStartupRegistrationState();
  if (options.dryRun) {
    console.log("[dry-run] Would mark startup registration as disabled.");
    console.log(
      `[dry-run] Scope ${prior.scope} target ${prior.target} via backend ${prior.backend}.`,
    );
    return 0;
  }

  await updateStartupRegistrationState(false);
  printStartupStatusSummary("disabled");
  return 0;
}

export async function runStartupStatusCommand(): Promise<number> {
  const state = await readStartupRegistrationState();
  const statePath = await getStartupRegistrationStatePath();

  console.log("Startup registration status:");
  console.log(`- enabled: ${state.enabled}`);
  console.log(`- scope: ${state.scope}`);
  console.log(`- target: ${state.target}`);
  console.log(`- backend: ${state.backend}`);
  console.log(`- note: ${state.note}`);
  console.log(`- updatedAt: ${state.updatedAt}`);
  console.log(`- statePath: ${statePath}`);

  return 0;
}
