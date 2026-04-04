import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  StartupBackend,
  StartupBackendInspection,
  StartupBackendRequest,
  StartupBackendResult,
} from "../startup-backend.js";

const UNIT_NAME = "lifeline-restore.service";
const SYSTEMD_MECHANISM = "systemd-user";
const EXPECTED_EXEC_START = "lifeline restore";

interface SystemctlCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

type SystemctlRunner = (args: string[]) => Promise<SystemctlCommandResult>;

interface SystemdBackendOptions {
  homeDirectory?: string;
}

function normalizeOutput(value: string): string {
  return value.trim();
}

async function runSystemctl(args: string[]): Promise<SystemctlCommandResult> {
  return new Promise((resolve) => {
    const child = spawn("systemctl", args, {
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
        stderr: normalizeOutput(`Unable to execute systemctl: ${error.message}`),
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

function resolveUnitPath(homeDirectory: string): string {
  return path.join(homeDirectory, ".config", "systemd", "user", UNIT_NAME);
}

function buildUnitContents(restoreEntrypoint: string): string {
  return [
    "[Unit]",
    "Description=Lifeline restore at login",
    "After=default.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${restoreEntrypoint}`,
    "Restart=no",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function isSystemctlUnavailable(result: SystemctlCommandResult): boolean {
  return result.code === -1;
}

function mentionsMissingUnit(result: SystemctlCommandResult): boolean {
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    combined.includes("not found") ||
    combined.includes("no files found") ||
    combined.includes("does not exist") ||
    combined.includes("not loaded")
  );
}

function includesCanonicalEntrypoint(catOutput: string): boolean {
  const normalized = catOutput.toLowerCase();
  return normalized.includes(`execstart=${EXPECTED_EXEC_START}`);
}

async function inspectUnit(runner: SystemctlRunner): Promise<StartupBackendInspection> {
  const catResult = await runner(["--user", "cat", UNIT_NAME]);

  if (isSystemctlUnavailable(catResult)) {
    return {
      supported: false,
      status: "unsupported",
      mechanism: SYSTEMD_MECHANISM,
      detail:
        "systemctl is unavailable for user-session systemd, so startup registration cannot be inspected.",
    };
  }

  if (catResult.code !== 0) {
    return {
      supported: true,
      status: "not-installed",
      mechanism: SYSTEMD_MECHANISM,
      detail: `User unit ${UNIT_NAME} is not currently registered for Lifeline startup.`,
    };
  }

  if (!includesCanonicalEntrypoint(catResult.stdout)) {
    return {
      supported: true,
      status: "not-installed",
      mechanism: SYSTEMD_MECHANISM,
      detail: `User unit ${UNIT_NAME} exists but is not configured for the canonical restore entrypoint ${EXPECTED_EXEC_START}.`,
    };
  }

  return {
    supported: true,
    status: "installed",
    mechanism: SYSTEMD_MECHANISM,
    detail: `User unit ${UNIT_NAME} is installed and configured to execute ${EXPECTED_EXEC_START} via systemd user session startup.`,
  };
}

export function createSystemdUserBackend(
  runner: SystemctlRunner = runSystemctl,
  options: SystemdBackendOptions = {},
): StartupBackend {
  const homeDirectory = options.homeDirectory ?? process.env.HOME ?? process.env.USERPROFILE ?? ".";
  const unitPath = resolveUnitPath(homeDirectory);

  return {
    id: SYSTEMD_MECHANISM,
    capabilities: ["inspect", "install", "uninstall"],
    inspect: async () => inspectUnit(runner),
    install: async (request: StartupBackendRequest): Promise<StartupBackendResult> => {
      if (request.dryRun) {
        const inspection = await inspectUnit(runner);
        return {
          status: inspection.status,
          detail:
            inspection.status === "installed"
              ? `Dry-run: user unit ${UNIT_NAME} is already configured for ${request.restoreEntrypoint}; no mutation required.`
              : `Dry-run: would write user unit ${UNIT_NAME} at ${unitPath} and enable it to run ${request.restoreEntrypoint}.`,
        };
      }

      const unitDirectory = path.dirname(unitPath);
      await mkdir(unitDirectory, { recursive: true });
      await writeFile(unitPath, buildUnitContents(request.restoreEntrypoint), "utf8");

      const reloadResult = await runner(["--user", "daemon-reload"]);
      if (isSystemctlUnavailable(reloadResult)) {
        return {
          status: "unsupported",
          detail:
            "systemctl is unavailable for user-session systemd, so startup registration cannot be installed.",
        };
      }

      if (reloadResult.code !== 0) {
        return {
          status: "not-installed",
          detail: `Failed to reload user systemd manager after writing ${unitPath}: ${reloadResult.stderr || reloadResult.stdout || "unknown systemd error"}.`,
        };
      }

      const enableResult = await runner(["--user", "enable", "--now", UNIT_NAME]);
      if (enableResult.code !== 0) {
        return {
          status: "not-installed",
          detail: `Failed to enable user unit ${UNIT_NAME}: ${enableResult.stderr || enableResult.stdout || "unknown systemd error"}.`,
        };
      }

      return {
        status: "installed",
        detail: `Installed user unit ${UNIT_NAME} at ${unitPath} and enabled it to run ${request.restoreEntrypoint}.`,
      };
    },
    uninstall: async (request: StartupBackendRequest): Promise<StartupBackendResult> => {
      if (request.dryRun) {
        const inspection = await inspectUnit(runner);
        return {
          status: inspection.status,
          detail:
            inspection.status === "installed"
              ? `Dry-run: would disable user unit ${UNIT_NAME} and remove ${unitPath}.`
              : `Dry-run: user unit ${UNIT_NAME} is not present; no mutation required.`,
        };
      }

      const disableResult = await runner(["--user", "disable", "--now", UNIT_NAME]);
      if (isSystemctlUnavailable(disableResult)) {
        return {
          status: "unsupported",
          detail:
            "systemctl is unavailable for user-session systemd, so startup registration cannot be removed.",
        };
      }

      if (disableResult.code !== 0 && !mentionsMissingUnit(disableResult)) {
        return {
          status: "not-installed",
          detail: `Failed to disable user unit ${UNIT_NAME}: ${disableResult.stderr || disableResult.stdout || "unknown systemd error"}.`,
        };
      }

      const fsPromises = (await import("node:fs/promises")) as unknown as {
        unlink(path: string): Promise<void>;
      };
      await fsPromises.unlink(unitPath).catch(() => undefined);
      const reloadResult = await runner(["--user", "daemon-reload"]);
      if (reloadResult.code !== 0) {
        return {
          status: "not-installed",
          detail: `Removed ${unitPath}, but failed to reload user systemd manager: ${reloadResult.stderr || reloadResult.stdout || "unknown systemd error"}.`,
        };
      }

      return {
        status: "not-installed",
        detail: `Disabled user unit ${UNIT_NAME} and removed ${unitPath}.`,
      };
    },
  };
}
