import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  StartupBackend,
  StartupBackendInspection,
  StartupBackendRequest,
  StartupBackendResult,
} from "../startup-backend.js";

const RC_SCRIPT_NAME = "lifeline_restore";
const FREEBSD_RC_D_MECHANISM = "freebsd-rc.d";
const EXPECTED_RESTORE_ENTRYPOINT = "lifeline restore";

interface FreebsdBackendOptions {
  rcDDirectory?: string;
  rcConfDirectory?: string;
}

function resolveScriptPath(rcDDirectory: string): string {
  return path.join(rcDDirectory, RC_SCRIPT_NAME);
}

function resolveRcConfPath(rcConfDirectory: string): string {
  return path.join(rcConfDirectory, RC_SCRIPT_NAME);
}

function buildRcScriptContents(): string {
  return [
    "#!/bin/sh",
    "",
    `# PROVIDE: ${RC_SCRIPT_NAME}`,
    "# REQUIRE: LOGIN",
    "# KEYWORD: shutdown",
    "",
    ". /etc/rc.subr",
    "",
    `name=\"${RC_SCRIPT_NAME}\"`,
    "rcvar=${name}_enable",
    "pidfile=\"/var/run/${name}.pid\"",
    "start_cmd=\"${name}_start\"",
    "stop_cmd=\"${name}_stop\"",
    "",
    `${RC_SCRIPT_NAME}_start() {`,
    "  /usr/sbin/daemon -f -p \"${pidfile}\" /bin/sh -lc 'lifeline restore'",
    "}",
    "",
    `${RC_SCRIPT_NAME}_stop() {`,
    "  if [ -f \"${pidfile}\" ]; then",
    "    kill \"$(cat \"${pidfile}\")\" 2>/dev/null || true",
    "    rm -f \"${pidfile}\"",
    "  fi",
    "}",
    "",
    "load_rc_config ${name}",
    ": ${lifeline_restore_enable:=\"NO\"}",
    "",
    "run_rc_command \"$1\"",
    "",
  ].join("\n");
}

function buildRcConfContents(): string {
  return `${RC_SCRIPT_NAME}_enable=\"YES\"\n`;
}

function hasCanonicalRestoreEntrypoint(scriptContents: string): boolean {
  return scriptContents.includes("lifeline restore");
}

function isEnabledInRcConf(rcConfContents: string): boolean {
  return /lifeline_restore_enable\s*=\s*\"YES\"/i.test(rcConfContents);
}

function asInspection(detail: string, status: "installed" | "not-installed"): StartupBackendInspection {
  return {
    supported: true,
    status,
    mechanism: FREEBSD_RC_D_MECHANISM,
    detail,
  };
}

export function createFreebsdRcDBackend(options: FreebsdBackendOptions = {}): StartupBackend {
  const rcDDirectory = options.rcDDirectory ?? "/usr/local/etc/rc.d";
  const rcConfDirectory = options.rcConfDirectory ?? "/etc/rc.conf.d";
  const scriptPath = resolveScriptPath(rcDDirectory);
  const rcConfPath = resolveRcConfPath(rcConfDirectory);

  async function inspectRegistration(): Promise<StartupBackendInspection> {
    const scriptContents = await readFile(scriptPath, "utf8").catch(() => "");
    const rcConfContents = await readFile(rcConfPath, "utf8").catch(() => "");

    if (!scriptContents && !rcConfContents) {
      return asInspection(
        `rc.d service ${RC_SCRIPT_NAME} is not currently registered for Lifeline startup.`,
        "not-installed",
      );
    }

    if (!scriptContents || !hasCanonicalRestoreEntrypoint(scriptContents)) {
      return asInspection(
        `rc.d service ${RC_SCRIPT_NAME} exists but is not configured for the canonical restore entrypoint ${EXPECTED_RESTORE_ENTRYPOINT}.`,
        "not-installed",
      );
    }

    if (!rcConfContents || !isEnabledInRcConf(rcConfContents)) {
      return asInspection(
        `rc.d service ${RC_SCRIPT_NAME} exists at ${scriptPath} but is not enabled via ${rcConfPath}.`,
        "not-installed",
      );
    }

    return asInspection(
      `rc.d service ${RC_SCRIPT_NAME} is installed at ${scriptPath} and enabled via ${rcConfPath} to run ${EXPECTED_RESTORE_ENTRYPOINT} at startup.`,
      "installed",
    );
  }

  return {
    id: FREEBSD_RC_D_MECHANISM,
    capabilities: ["inspect", "install", "uninstall"],
    inspect: inspectRegistration,
    install: async (request: StartupBackendRequest): Promise<StartupBackendResult> => {
      if (request.dryRun) {
        const inspection = await inspectRegistration();
        return {
          status: inspection.status,
          detail:
            inspection.status === "installed"
              ? `Dry-run: rc.d service ${RC_SCRIPT_NAME} is already configured for ${request.restoreEntrypoint}; no mutation required.`
              : `Dry-run: would write ${scriptPath}, set executable permissions, and enable ${RC_SCRIPT_NAME} via ${rcConfPath} for ${request.restoreEntrypoint}.`,
        };
      }

      try {
        await mkdir(rcDDirectory, { recursive: true });
        await mkdir(rcConfDirectory, { recursive: true });
        await writeFile(scriptPath, buildRcScriptContents(), "utf8");
        const fsPromises = (await import("node:fs/promises")) as unknown as {
          chmod(path: string, mode: number): Promise<void>;
        };
        await fsPromises.chmod(scriptPath, 0o755);
        await writeFile(rcConfPath, buildRcConfContents(), "utf8");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
          status: "not-installed",
          detail: `Failed to install FreeBSD rc.d startup service ${RC_SCRIPT_NAME}: ${detail}.`,
        };
      }

      return {
        status: "installed",
        detail: `Installed rc.d service ${RC_SCRIPT_NAME} at ${scriptPath} and enabled it via ${rcConfPath} to run ${request.restoreEntrypoint}.`,
      };
    },
    uninstall: async (request: StartupBackendRequest): Promise<StartupBackendResult> => {
      if (request.dryRun) {
        const inspection = await inspectRegistration();
        return {
          status: inspection.status,
          detail:
            inspection.status === "installed"
              ? `Dry-run: would remove ${scriptPath} and disable ${RC_SCRIPT_NAME} by removing ${rcConfPath}.`
              : `Dry-run: rc.d service ${RC_SCRIPT_NAME} is not present; no mutation required.`,
        };
      }

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
            detail: `Failed to remove rc.d service script ${scriptPath}: ${detail}.`,
          };
        }
      }

      try {
        await fsPromises.unlink(rcConfPath);
        removed = true;
      } catch (error) {
        if ((error as { code?: string })?.code !== "ENOENT") {
          const detail = error instanceof Error ? error.message : String(error);
          return {
            status: "not-installed",
            detail: `Failed to remove rc.conf startup enablement ${rcConfPath}: ${detail}.`,
          };
        }
      }

      if (!removed) {
        return {
          status: "not-installed",
          detail: `rc.d service ${RC_SCRIPT_NAME} is already absent from ${scriptPath} and ${rcConfPath}.`,
        };
      }

      return {
        status: "not-installed",
        detail: `Removed rc.d service ${RC_SCRIPT_NAME} at ${scriptPath} and removed startup enablement ${rcConfPath}.`,
      };
    },
  };
}
