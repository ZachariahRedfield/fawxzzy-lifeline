import {
  getStartupStatus,
  planStartupAction,
  setStartupIntent,
} from "../core/startup-contract.js";

function printStatus(): Promise<number> {
  return getStartupStatus().then((status) => {
    console.log(`Startup supported: ${status.supported ? "yes" : "no"}`);
    console.log(`Startup enabled: ${status.enabled ? "yes" : "no"}`);
    console.log(`- mechanism: ${status.mechanism}`);
    console.log(`- scope: ${status.scope}`);
    console.log(`- restore entrypoint: ${status.restoreEntrypoint}`);
    console.log(`- detail: ${status.detail}`);
    return 0;
  });
}

export async function runStartupCommand(
  action: string | undefined,
  option: string | undefined,
): Promise<number> {
  if (!action) {
    console.error("Missing startup action. Use one of: enable, disable, status.");
    return 1;
  }

  const dryRun = option === "--dry-run";
  if (option && !dryRun) {
    console.error(`Unknown startup option: ${option}. Only --dry-run is supported.`);
    return 1;
  }

  if (action === "enable") {
    const plan = await planStartupAction("enable");
    if (dryRun) {
      console.log("Startup enable dry-run:");
      console.log(`- scope: ${plan.scope}`);
      console.log(`- restore entrypoint: ${plan.restoreEntrypoint}`);
      console.log(`- backend status: ${plan.backendStatus}`);
      console.log(`- detail: ${plan.detail}`);
      return 0;
    }

    await setStartupIntent("enabled");
    console.log("Startup intent enabled.");
    console.log("Platform-specific installer backends are not implemented yet.");
    return printStatus();
  }

  if (action === "disable") {
    const plan = await planStartupAction("disable");
    if (dryRun) {
      console.log("Startup disable dry-run:");
      console.log(`- scope: ${plan.scope}`);
      console.log(`- restore entrypoint: ${plan.restoreEntrypoint}`);
      console.log(`- backend status: ${plan.backendStatus}`);
      console.log(`- detail: ${plan.detail}`);
      return 0;
    }

    await setStartupIntent("disabled");
    console.log("Startup intent disabled.");
    return printStatus();
  }

  if (action === "status") {
    if (dryRun) {
      console.error("The --dry-run option is only valid with startup enable|disable.");
      return 1;
    }
    return printStatus();
  }

  console.error(`Unknown startup action: ${action}. Use one of: enable, disable, status.`);
  return 1;
}
