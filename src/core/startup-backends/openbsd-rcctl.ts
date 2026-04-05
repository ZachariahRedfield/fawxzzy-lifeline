import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  StartupBackend,
  StartupBackendInspection,
  StartupBackendRequest,
  StartupBackendResult,
} from "../startup-backend.js";

const SERVICE_NAME = "lifeline_restore";
const OPENBSD_RCCTL_MECHANISM = "openbsd-rcctl";
const EXPECTED_RESTORE_ENTRYPOINT = "lifeline restore";

interface RcctlCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

type RcctlRunner = (args: string[]) => Promise<RcctlCommandResult>;

interface OpenbsdRcctlBackendOptions {
  rcDDirectory?: string;
}

function normalizeOutput(value: string): string {
  return value.trim();
}

async function runRcctl(args: string[]): Promise<RcctlCommandResult> {
  const childProcess = await import("node:child_process");

  return new Promise((resolve) => {
    const child = childProcess.spawn("rcctl", args, {
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
        stderr: normalizeOutput(`Unable to execute rcctl: ${error.message}`),
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

function resolveScriptPath(rcDDirectory: string): string {
  return path.join(rcDDirectory, SERVICE_NAME);
}

function buildRcScriptContents(): string {
  return [
    "#!/bin/ksh",
    "",
    ". /etc/rc.d/rc.subr",
    "",
    `name=\"${SERVICE_NAME}\"`,
    "daemon=\"/usr/local/bin/lifeline\"",
    "daemon_flags=\"restore\"",
    "",
    "rc_cmd $1",
    "",
  ].join("\n");
}

function isRcctlUnavailable(result: RcctlCommandResult): boolean {
  return result.code === -1;
}

function isEnabledStatus(stdout: string): boolean {
  return stdout.trim().toLowerCase() === "on";
}

function includesCanonicalEntrypoint(scriptContents: string): boolean {
  const normalized = scriptContents.toLowerCase();
  return normalized.includes('daemon="/usr/local/bin/lifeline"') && normalized.includes('daemon_flags="restore"');
}

function includesCanonicalFlags(stdout: string): boolean {
  return stdout.trim().toLowerCase() === "restore";
}

async function inspectRegistration(
  runner: RcctlRunner,
  scriptPath: string,
): Promise<StartupBackendInspection> {
  const scriptContents = await readFile(scriptPath, "utf8").catch(() => "");

  if (!scriptContents) {
    return {
      supported: true,
      status: "not-installed",
      mechanism: OPENBSD_RCCTL_MECHANISM,
      detail: `rcctl service ${SERVICE_NAME} is not currently registered for Lifeline startup.`,
    };
  }

  if (!includesCanonicalEntrypoint(scriptContents)) {
    return {
      supported: true,
      status: "not-installed",
      mechanism: OPENBSD_RCCTL_MECHANISM,
      detail: `rcctl service ${SERVICE_NAME} exists but is not configured for the canonical restore entrypoint ${EXPECTED_RESTORE_ENTRYPOINT}.`,
    };
  }

  const statusResult = await runner(["get", SERVICE_NAME, "status"]);
  if (isRcctlUnavailable(statusResult)) {
    return {
      supported: false,
      status: "unsupported",
      mechanism: OPENBSD_RCCTL_MECHANISM,
      detail: "rcctl is unavailable, so OpenBSD startup registration cannot be inspected.",
    };
  }

  const flagsResult = await runner(["get", SERVICE_NAME, "flags"]);
  if (isRcctlUnavailable(flagsResult)) {
    return {
      supported: false,
      status: "unsupported",
      mechanism: OPENBSD_RCCTL_MECHANISM,
      detail: "rcctl is unavailable, so OpenBSD startup registration cannot be inspected.",
    };
  }

  if (statusResult.code !== 0 || !isEnabledStatus(statusResult.stdout)) {
    return {
      supported: true,
      status: "not-installed",
      mechanism: OPENBSD_RCCTL_MECHANISM,
      detail: `rcctl service ${SERVICE_NAME} exists at ${scriptPath} but is not enabled for startup.`,
    };
  }

  if (flagsResult.code !== 0 || !includesCanonicalFlags(flagsResult.stdout)) {
    return {
      supported: true,
      status: "not-installed",
      mechanism: OPENBSD_RCCTL_MECHANISM,
      detail: `rcctl service ${SERVICE_NAME} is enabled but not configured to run ${EXPECTED_RESTORE_ENTRYPOINT}.`,
    };
  }

  return {
    supported: true,
    status: "installed",
    mechanism: OPENBSD_RCCTL_MECHANISM,
    detail: `rcctl service ${SERVICE_NAME} is installed at ${scriptPath} and enabled to run ${EXPECTED_RESTORE_ENTRYPOINT} at startup.`,
  };
}

export function createOpenbsdRcctlBackend(
  runner: RcctlRunner = runRcctl,
  options: OpenbsdRcctlBackendOptions = {},
): StartupBackend {
  const rcDDirectory = options.rcDDirectory ?? "/etc/rc.d";
  const scriptPath = resolveScriptPath(rcDDirectory);

  return {
    id: OPENBSD_RCCTL_MECHANISM,
    capabilities: ["inspect", "install", "uninstall"],
    inspect: async () => inspectRegistration(runner, scriptPath),
    install: async (request: StartupBackendRequest): Promise<StartupBackendResult> => {
      if (request.dryRun) {
        const inspection = await inspectRegistration(runner, scriptPath);
        return {
          status: inspection.status,
          detail:
            inspection.status === "installed"
              ? `Dry-run: rcctl service ${SERVICE_NAME} is already configured for ${request.restoreEntrypoint}; no mutation required.`
              : `Dry-run: would write ${scriptPath}, enable ${SERVICE_NAME}, and set rcctl flags to run ${request.restoreEntrypoint}.`,
        };
      }

      try {
        await mkdir(rcDDirectory, { recursive: true });
        await writeFile(scriptPath, buildRcScriptContents(), "utf8");
        const fsPromises = (await import("node:fs/promises")) as unknown as {
          chmod(path: string, mode: number): Promise<void>;
        };
        await fsPromises.chmod(scriptPath, 0o755);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          status: "not-installed",
          detail: `Failed to write OpenBSD rc.d script ${scriptPath}: ${detail}.`,
        };
      }

      const setFlagsResult = await runner(["set", SERVICE_NAME, "flags", "restore"]);
      if (isRcctlUnavailable(setFlagsResult)) {
        return {
          status: "unsupported",
          detail: "rcctl is unavailable, so OpenBSD startup registration cannot be installed.",
        };
      }

      if (setFlagsResult.code !== 0) {
        return {
          status: "not-installed",
          detail: `Failed to set rcctl flags for ${SERVICE_NAME}: ${setFlagsResult.stderr || setFlagsResult.stdout || "unknown rcctl error"}.`,
        };
      }

      const enableResult = await runner(["enable", SERVICE_NAME]);
      if (isRcctlUnavailable(enableResult)) {
        return {
          status: "unsupported",
          detail: "rcctl is unavailable, so OpenBSD startup registration cannot be installed.",
        };
      }

      if (enableResult.code !== 0) {
        return {
          status: "not-installed",
          detail: `Failed to enable rcctl service ${SERVICE_NAME}: ${enableResult.stderr || enableResult.stdout || "unknown rcctl error"}.`,
        };
      }

      return {
        status: "installed",
        detail: `Installed rcctl service ${SERVICE_NAME} at ${scriptPath} and enabled it to run ${request.restoreEntrypoint} at startup.`,
      };
    },
    uninstall: async (request: StartupBackendRequest): Promise<StartupBackendResult> => {
      if (request.dryRun) {
        const inspection = await inspectRegistration(runner, scriptPath);
        return {
          status: inspection.status,
          detail:
            inspection.status === "installed"
              ? `Dry-run: would disable rcctl service ${SERVICE_NAME}, clear startup flags, and remove ${scriptPath}.`
              : `Dry-run: rcctl service ${SERVICE_NAME} is not present; no mutation required.`,
        };
      }

      const disableResult = await runner(["disable", SERVICE_NAME]);
      if (isRcctlUnavailable(disableResult)) {
        return {
          status: "unsupported",
          detail: "rcctl is unavailable, so OpenBSD startup registration cannot be removed.",
        };
      }

      if (disableResult.code !== 0) {
        return {
          status: "not-installed",
          detail: `Failed to disable rcctl service ${SERVICE_NAME}: ${disableResult.stderr || disableResult.stdout || "unknown rcctl error"}.`,
        };
      }

      await runner(["set", SERVICE_NAME, "flags", ""]).catch(() => undefined);

      const fsPromises = (await import("node:fs/promises")) as unknown as {
        unlink(path: string): Promise<void>;
      };

      let removed = false;
      try {
        await fsPromises.unlink(scriptPath);
        removed = true;
      } catch (error) {
        if ((error as { code?: string })?.code !== "ENOENT") {
          const detail = error instanceof Error ? error.message : String(error);
          return {
            status: "not-installed",
            detail: `Failed to remove OpenBSD rc.d script ${scriptPath}: ${detail}.`,
          };
        }
      }

      if (!removed) {
        return {
          status: "not-installed",
          detail: `rcctl service ${SERVICE_NAME} is already absent from ${scriptPath}.`,
        };
      }

      return {
        status: "not-installed",
        detail: `Disabled rcctl service ${SERVICE_NAME}, cleared startup flags, and removed ${scriptPath}.`,
      };
    },
  };
}
