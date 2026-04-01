import {
  disableStartup,
  enableStartup,
  getStartupStatus,
} from "../core/startup-contract.js";

export async function runStartupCommand(action: string | undefined): Promise<number> {
  if (!action) {
    console.error("Missing startup action. Use one of: enable, disable, status.");
    return 1;
  }

  if (action === "enable") {
    await enableStartup();
    const status = await getStartupStatus();
    console.log("Startup auto-start enabled.");
    console.log(`- mechanism: ${status.mechanism}`);
    console.log(`- detail: ${status.detail}`);
    return 0;
  }

  if (action === "disable") {
    await disableStartup();
    const status = await getStartupStatus();
    console.log("Startup auto-start disabled.");
    console.log(`- mechanism: ${status.mechanism}`);
    console.log(`- detail: ${status.detail}`);
    return 0;
  }

  if (action === "status") {
    const status = await getStartupStatus();
    console.log(`Startup supported: ${status.supported ? "yes" : "no"}`);
    console.log(`Startup enabled: ${status.enabled ? "yes" : "no"}`);
    console.log(`- mechanism: ${status.mechanism}`);
    console.log(`- detail: ${status.detail}`);
    return status.supported && status.enabled ? 0 : 1;
  }

  console.error(`Unknown startup action: ${action}. Use one of: enable, disable, status.`);
  return 1;
}
