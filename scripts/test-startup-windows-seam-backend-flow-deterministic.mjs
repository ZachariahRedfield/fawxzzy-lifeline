import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function createSchedulerHarness() {
  const state = { installed: false };

  return async (args) => {
    const command = args.join(" ");
    if (command.startsWith("/Query")) {
      if (!state.installed) {
        return { code: 1, stdout: "", stderr: "ERROR: task not found." };
      }

      return {
        code: 0,
        stdout: "TaskName: \\LifelineRestoreAtLogon\nTask To Run: lifeline restore",
        stderr: "",
      };
    }

    if (command.startsWith("/Create")) {
      state.installed = true;
      return { code: 0, stdout: "SUCCESS: task created.", stderr: "" };
    }

    if (command.startsWith("/Delete")) {
      state.installed = false;
      return { code: 0, stdout: "SUCCESS: task deleted.", stderr: "" };
    }

    return { code: 1, stdout: "", stderr: `Unexpected command: ${command}` };
  };
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-startup-seam-win-"));
  const previousCwd = process.cwd();
  process.chdir(tempRoot);

  try {
    const { createWindowsTaskSchedulerBackend } = await import(
      "../dist/core/startup-backends/windows-task-scheduler.js"
    );
    const { getStartupStatus, planStartupAction } = await import("../dist/core/startup-contract.js");
    const { runStartupCommand } = await import("../dist/commands/startup.js");

    const backend = createWindowsTaskSchedulerBackend(createSchedulerHarness());
    const initialStatus = await getStartupStatus(backend);
    assert(initialStatus.backendStatus === "not-installed", "Expected initial startup backend status not-installed.");

    const enablePlan = await planStartupAction("enable", backend);
    assert(enablePlan.backendStatus === "not-installed", "Expected enable plan to preserve not-installed status.");

    const dryRunCode = await runStartupCommand("enable", "--dry-run", backend);
    assert(dryRunCode === 0, `Expected startup enable --dry-run to succeed, got ${dryRunCode}.`);

    const statusAfterDryRun = await getStartupStatus(backend);
    assert(
      statusAfterDryRun.backendStatus === "not-installed",
      "Expected startup backend status to remain not-installed after dry-run.",
    );

    const enableCode = await runStartupCommand("enable", undefined, backend);
    assert(enableCode === 0, `Expected startup enable to succeed, got ${enableCode}.`);

    const statusAfterEnable = await getStartupStatus(backend);
    assert(statusAfterEnable.backendStatus === "installed", "Expected startup backend status installed after enable.");

    const persistedState = JSON.parse(await readFile(path.join(tempRoot, ".lifeline", "startup.json"), "utf8"));
    assert(
      persistedState.backendStatus === "installed",
      `Expected persisted backendStatus installed after enable, got ${persistedState.backendStatus}.`,
    );

    const disableCode = await runStartupCommand("disable", undefined, backend);
    assert(disableCode === 0, `Expected startup disable to succeed, got ${disableCode}.`);

    const statusAfterDisable = await getStartupStatus(backend);
    assert(
      statusAfterDisable.backendStatus === "not-installed",
      "Expected startup backend status not-installed after disable.",
    );
  } finally {
    process.chdir(previousCwd);
  }

  console.log("Deterministic startup Windows seam/backend flow verification passed.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Deterministic startup Windows seam/backend flow verification failed: ${message}`);
  process.exitCode = 1;
});
