import type {
  StartupBackend,
  StartupBackendInspection,
  StartupBackendRequest,
  StartupBackendResult,
} from "../startup-backend.js";

const AIX_INITTAB_MECHANISM = "aix-inittab";
const INITTAB_ENTRY_ID = "llrestore";
const INITTAB_RESTORE_COMMAND =
  "/bin/sh -lc 'lifeline restore' >/dev/null 2>&1";
const EXPECTED_RESTORE_ENTRYPOINT = "lifeline restore";

interface AixCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

type AixCommandRunner = (
  command: string,
  args: string[],
) => Promise<AixCommandResult>;

function normalizeOutput(value: string): string {
  return value.trim();
}

function buildCanonicalInittabEntry(): string {
  return `${INITTAB_ENTRY_ID}:2:once:${INITTAB_RESTORE_COMMAND}`;
}

function hasCanonicalRestoreWiring(entry: string): boolean {
  const normalized = entry.replace(/\s+/g, " ").trim().toLowerCase();
  return (
    normalized.startsWith(`${INITTAB_ENTRY_ID}:2:once:`) &&
    normalized.includes(EXPECTED_RESTORE_ENTRYPOINT)
  );
}

function isRunnerUnavailable(result: AixCommandResult): boolean {
  return result.code === -1;
}

function isEntryMissing(result: AixCommandResult): boolean {
  if (result.code === 0) {
    return false;
  }

  const diagnostics = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    diagnostics.includes("not found") ||
    diagnostics.includes("does not exist") ||
    diagnostics.includes("0513-004")
  );
}

async function runAixCommand(
  command: string,
  args: string[],
): Promise<AixCommandResult> {
  const childProcess = await import("node:child_process");

  return new Promise((resolve) => {
    const child = childProcess.spawn(command, args, {
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
        stderr: normalizeOutput(
          `Unable to execute ${command}: ${error.message}`,
        ),
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

async function inspectRegistration(
  runner: AixCommandRunner,
): Promise<StartupBackendInspection> {
  const lsitabResult = await runner("lsitab", [INITTAB_ENTRY_ID]);

  if (isRunnerUnavailable(lsitabResult)) {
    return {
      supported: false,
      status: "unsupported",
      mechanism: AIX_INITTAB_MECHANISM,
      detail:
        "AIX inittab tooling is unavailable, so startup registration cannot be inspected.",
    };
  }

  if (isEntryMissing(lsitabResult)) {
    return {
      supported: true,
      status: "not-installed",
      mechanism: AIX_INITTAB_MECHANISM,
      detail: `AIX inittab entry ${INITTAB_ENTRY_ID} is not currently registered for Lifeline startup.`,
    };
  }

  const inittabEntry = lsitabResult.stdout.trim();

  if (!hasCanonicalRestoreWiring(inittabEntry)) {
    return {
      supported: true,
      status: "not-installed",
      mechanism: AIX_INITTAB_MECHANISM,
      detail: `AIX inittab entry ${INITTAB_ENTRY_ID} exists but is not configured for the canonical restore entrypoint ${EXPECTED_RESTORE_ENTRYPOINT}.`,
    };
  }

  return {
    supported: true,
    status: "installed",
    mechanism: AIX_INITTAB_MECHANISM,
    detail: `AIX inittab entry ${INITTAB_ENTRY_ID} is configured to run ${EXPECTED_RESTORE_ENTRYPOINT} at startup.`,
  };
}

export function createAixInittabBackend(
  runner: AixCommandRunner = runAixCommand,
): StartupBackend {
  return {
    id: AIX_INITTAB_MECHANISM,
    capabilities: ["inspect", "install", "uninstall"],
    inspect: async () => inspectRegistration(runner),
    install: async (
      request: StartupBackendRequest,
    ): Promise<StartupBackendResult> => {
      if (request.dryRun) {
        const inspection = await inspectRegistration(runner);
        return {
          status: inspection.status,
          detail:
            inspection.status === "installed"
              ? `Dry-run: AIX inittab entry ${INITTAB_ENTRY_ID} is already configured for ${request.restoreEntrypoint}; no mutation required.`
              : `Dry-run: would create or update AIX inittab entry ${INITTAB_ENTRY_ID} to run ${request.restoreEntrypoint} at startup.`,
        };
      }

      const lsitabResult = await runner("lsitab", [INITTAB_ENTRY_ID]);
      if (isRunnerUnavailable(lsitabResult)) {
        return {
          status: "unsupported",
          detail:
            "AIX inittab tooling is unavailable, so startup registration cannot be installed.",
        };
      }

      const entryExists =
        lsitabResult.code === 0 && Boolean(lsitabResult.stdout.trim());
      const desiredEntry = buildCanonicalInittabEntry();

      const installCommand = entryExists ? "chitab" : "mkitab";
      const installResult = await runner(installCommand, [desiredEntry]);

      if (isRunnerUnavailable(installResult)) {
        return {
          status: "unsupported",
          detail:
            "AIX inittab tooling is unavailable, so startup registration cannot be installed.",
        };
      }

      if (installResult.code !== 0) {
        return {
          status: "not-installed",
          detail: `Failed to ${entryExists ? "update" : "create"} AIX inittab entry ${INITTAB_ENTRY_ID}: ${installResult.stderr || installResult.stdout || "unknown inittab error"}.`,
        };
      }

      return {
        status: "installed",
        detail: `${entryExists ? "Updated" : "Installed"} AIX inittab entry ${INITTAB_ENTRY_ID} to run ${request.restoreEntrypoint} at startup.`,
      };
    },
    uninstall: async (
      request: StartupBackendRequest,
    ): Promise<StartupBackendResult> => {
      if (request.dryRun) {
        const inspection = await inspectRegistration(runner);
        return {
          status: inspection.status,
          detail:
            inspection.status === "installed"
              ? `Dry-run: would remove AIX inittab entry ${INITTAB_ENTRY_ID}.`
              : `Dry-run: AIX inittab entry ${INITTAB_ENTRY_ID} is not present; no mutation required.`,
        };
      }

      const removeResult = await runner("rmitab", [INITTAB_ENTRY_ID]);
      if (isRunnerUnavailable(removeResult)) {
        return {
          status: "unsupported",
          detail:
            "AIX inittab tooling is unavailable, so startup registration cannot be removed.",
        };
      }

      if (removeResult.code !== 0 && !isEntryMissing(removeResult)) {
        return {
          status: "not-installed",
          detail: `Failed to remove AIX inittab entry ${INITTAB_ENTRY_ID}: ${removeResult.stderr || removeResult.stdout || "unknown inittab error"}.`,
        };
      }

      if (isEntryMissing(removeResult)) {
        return {
          status: "not-installed",
          detail: `AIX inittab entry ${INITTAB_ENTRY_ID} is already absent.`,
        };
      }

      return {
        status: "not-installed",
        detail: `Removed AIX inittab entry ${INITTAB_ENTRY_ID}.`,
      };
    },
  };
}
