import { spawn } from "node:child_process";
import type {
  StartupBackend,
  StartupBackendInspection,
  StartupBackendRequest,
  StartupBackendResult,
} from "../startup-backend.js";

const TASK_NAME = "LifelineRestoreAtLogon";
const TASK_MECHANISM = "windows-task-scheduler";
const RESTORE_ENTRYPOINT = "lifeline restore";

interface SchedulerCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

type SchedulerRunner = (args: string[]) => Promise<SchedulerCommandResult>;

function normalizeOutput(value: string): string {
  return value.trim();
}

async function runSchtasks(args: string[]): Promise<SchedulerCommandResult> {
  return new Promise((resolve) => {
    const child = spawn("schtasks", args, {
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: unknown) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk: unknown) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      resolve({
        code: -1,
        stdout: normalizeOutput(stdout),
        stderr: normalizeOutput(`Unable to execute schtasks: ${error.message}`),
      });
    });

    child.on("exit", (code: number | null) => {
      resolve({
        code: typeof code === "number" ? code : 1,
        stdout: normalizeOutput(stdout),
        stderr: normalizeOutput(stderr),
      });
    });
  });
}

function matchesConfiguredTask(queryOutput: string): boolean {
  const normalized = queryOutput.toLowerCase();
  const expectedEntrypoint = RESTORE_ENTRYPOINT.toLowerCase();
  return (
    normalized.includes(TASK_NAME.toLowerCase()) &&
    normalized.includes(expectedEntrypoint)
  );
}

function isSchedulerUnavailable(result: SchedulerCommandResult): boolean {
  return result.code === -1;
}

function isTaskMissing(result: SchedulerCommandResult): boolean {
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return combined.includes("cannot find") || combined.includes("task not found");
}

async function inspectTask(
  runner: SchedulerRunner,
): Promise<StartupBackendInspection> {
  const queryResult = await runner([
    "/Query",
    "/TN",
    TASK_NAME,
    "/V",
    "/FO",
    "LIST",
  ]);

  if (isSchedulerUnavailable(queryResult)) {
    return {
      supported: false,
      status: "unsupported",
      mechanism: TASK_MECHANISM,
      detail:
        "Windows Task Scheduler CLI is unavailable, so startup registration cannot be inspected.",
    };
  }

  if (queryResult.code !== 0) {
    return {
      supported: true,
      status: "not-installed",
      mechanism: TASK_MECHANISM,
      detail: `Task ${TASK_NAME} is not currently registered in Windows Task Scheduler.`,
    };
  }

  if (!matchesConfiguredTask(queryResult.stdout)) {
    return {
      supported: true,
      status: "not-installed",
      mechanism: TASK_MECHANISM,
      detail: `Task ${TASK_NAME} exists but is not configured for the canonical restore entrypoint ${RESTORE_ENTRYPOINT}.`,
    };
  }

  return {
    supported: true,
    status: "installed",
    mechanism: TASK_MECHANISM,
    detail: `Task ${TASK_NAME} is installed and configured to execute ${RESTORE_ENTRYPOINT} at user logon.`,
  };
}

function buildCreateTaskArgs(restoreEntrypoint: string): string[] {
  return [
    "/Create",
    "/TN",
    TASK_NAME,
    "/SC",
    "ONLOGON",
    "/TR",
    restoreEntrypoint,
    "/F",
  ];
}

export function createWindowsTaskSchedulerBackend(
  runner: SchedulerRunner = runSchtasks,
): StartupBackend {
  return {
    id: TASK_MECHANISM,
    capabilities: ["inspect", "install", "uninstall"],
    inspect: async () => inspectTask(runner),
    install: async (
      request: StartupBackendRequest,
    ): Promise<StartupBackendResult> => {
      if (request.dryRun) {
        const inspection = await inspectTask(runner);
        return {
          status: inspection.status === "unsupported" ? "unsupported" : inspection.status,
          detail:
            inspection.status === "installed"
              ? `Dry-run: task ${TASK_NAME} is already registered for ${request.restoreEntrypoint}; no mutation required.`
              : `Dry-run: would register Windows Task Scheduler task ${TASK_NAME} to run ${request.restoreEntrypoint} on user logon.`,
        };
      }

      const createResult = await runner(buildCreateTaskArgs(request.restoreEntrypoint));
      if (isSchedulerUnavailable(createResult)) {
        return {
          status: "unsupported",
          detail:
            "Windows Task Scheduler CLI is unavailable, so startup registration cannot be installed.",
        };
      }

      if (createResult.code !== 0) {
        const errorDetail =
          createResult.stderr ||
          createResult.stdout ||
          "unknown scheduler error";
        return {
          status: "not-installed",
          detail: `Failed to register task ${TASK_NAME}: ${errorDetail}.`,
        };
      }

      return {
        status: "installed",
        detail: `Registered task ${TASK_NAME} to run ${request.restoreEntrypoint} on user logon.`,
      };
    },
    uninstall: async (
      request: StartupBackendRequest,
    ): Promise<StartupBackendResult> => {
      if (request.dryRun) {
        const inspection = await inspectTask(runner);
        return {
          status: inspection.status === "unsupported" ? "unsupported" : inspection.status,
          detail:
            inspection.status === "installed"
              ? `Dry-run: would remove Windows Task Scheduler task ${TASK_NAME}.`
              : `Dry-run: task ${TASK_NAME} is not present; no mutation required.`,
        };
      }

      const deleteResult = await runner(["/Delete", "/TN", TASK_NAME, "/F"]);

      if (isSchedulerUnavailable(deleteResult)) {
        return {
          status: "unsupported",
          detail:
            "Windows Task Scheduler CLI is unavailable, so startup registration cannot be removed.",
        };
      }

      if (deleteResult.code !== 0) {
        if (isTaskMissing(deleteResult)) {
          return {
            status: "not-installed",
            detail: `Task ${TASK_NAME} is already absent from Windows Task Scheduler.`,
          };
        }

        return {
          status: "not-installed",
          detail:
            `Task ${TASK_NAME} is already absent or could not be removed. ` +
            `${deleteResult.stderr || deleteResult.stdout || "Scheduler did not return extra details."}`,
        };
      }

      return {
        status: "not-installed",
        detail: `Removed task ${TASK_NAME} from Windows Task Scheduler.`,
      };
    },
  };
}
