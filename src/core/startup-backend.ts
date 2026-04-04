export type StartupBackendStatus = "installed" | "not-installed" | "unsupported";
export type RuntimePlatform = string;

import { createWindowsTaskSchedulerBackend } from "./startup-backends/windows-task-scheduler.js";

export interface StartupBackendInspection {
  supported: boolean;
  status: StartupBackendStatus;
  mechanism: string;
  detail: string;
}

export interface StartupBackendRequest {
  scope: "machine-local";
  restoreEntrypoint: "lifeline restore";
  dryRun: boolean;
}

export interface StartupBackendResult {
  status: StartupBackendStatus;
  detail: string;
}

export interface StartupBackend {
  id: string;
  inspect(): Promise<StartupBackendInspection>;
  install(request: StartupBackendRequest): Promise<StartupBackendResult>;
  uninstall(request: StartupBackendRequest): Promise<StartupBackendResult>;
}

function createUnsupportedBackend(platform: RuntimePlatform): StartupBackend {
  const detail = `No startup installer backend is available on ${platform} yet.`;

  return {
    id: "unsupported",
    inspect: async () => ({
      supported: false,
      status: "unsupported",
      mechanism: "contract-only",
      detail,
    }),
    install: async (request) => ({
      status: "unsupported",
      detail: request.dryRun
        ? `${detail} Dry-run only reports the contract plan.`
        : `${detail} Intent can still be recorded for future backend availability.`,
    }),
    uninstall: async () => ({
      status: "unsupported",
      detail:
        "No startup installer backend is currently configured, so there is nothing platform-specific to remove.",
    }),
  };
}

export function resolveStartupBackend(platform: RuntimePlatform = process.platform): StartupBackend {
  if (platform === "win32") {
    return createWindowsTaskSchedulerBackend();
  }

  return createUnsupportedBackend(platform);
}
