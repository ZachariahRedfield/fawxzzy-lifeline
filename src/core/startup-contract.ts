import { access } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { LifelineError } from "./errors.js";

const WINDOWS_TASK_NAME = "\\Lifeline\\Restore";
const WINDOWS_MECHANISM = "windows-task-scheduler";

export interface StartupStatus {
  supported: boolean;
  enabled: boolean;
  mechanism: string;
  detail: string;
}

interface StartupBackend {
  readonly mechanism: string;
  enableAutoStart(): Promise<void>;
  disableAutoStart(): Promise<void>;
  getAutoStartStatus(): Promise<StartupStatus>;
}

interface CapturedCommand {
  code: number | null;
  stdout: string;
  stderr: string;
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

async function runCapture(
  command: string,
  args: string[],
): Promise<CapturedCommand> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function resolveRestoreEntrypoint(): { command: string; args: string[] } {
  const cliPath = process.argv[1];

  if (!cliPath) {
    throw new LifelineError(
      "Unable to resolve Lifeline CLI path from process.argv[1]; startup registration requires running from the built CLI entrypoint.",
      "STARTUP_RUNTIME_PATH_ERROR",
    );
  }

  const resolvedCliPath = path.resolve(cliPath);
  const maybeNodeBinary = path.basename(process.execPath).toLowerCase();

  if (maybeNodeBinary === "node" || maybeNodeBinary === "node.exe") {
    return {
      command: process.execPath,
      args: [resolvedCliPath, "restore"],
    };
  }

  return {
    command: process.execPath,
    args: ["restore"],
  };
}

async function resolveRestoreTaskCommand(): Promise<string> {
  const entrypoint = resolveRestoreEntrypoint();

  await access(entrypoint.command).catch(() => {
    throw new LifelineError(
      `Unable to access runtime executable at ${entrypoint.command}.`,
      "STARTUP_RUNTIME_PATH_ERROR",
    );
  });

  if (entrypoint.args[0]?.endsWith(".js")) {
    const cliPath = entrypoint.args[0];
    await access(cliPath).catch(() => {
      throw new LifelineError(
        `Unable to access built CLI entrypoint at ${cliPath}; run pnpm build before enabling startup.`,
        "STARTUP_RUNTIME_PATH_ERROR",
      );
    });
  }

  return [quoted(entrypoint.command), ...entrypoint.args.map(quoted)].join(" ");
}

class WindowsStartupBackend implements StartupBackend {
  readonly mechanism = WINDOWS_MECHANISM;

  async enableAutoStart(): Promise<void> {
    const taskCommand = await resolveRestoreTaskCommand();

    const result = await runCapture("schtasks", [
      "/Create",
      "/TN",
      WINDOWS_TASK_NAME,
      "/SC",
      "ONLOGON",
      "/F",
      "/TR",
      taskCommand,
    ]);

    if (result.code !== 0) {
      const message = (result.stderr || result.stdout || "unknown error").trim();
      throw new LifelineError(
        `Failed to register startup task via Task Scheduler: ${message}`,
        "STARTUP_BACKEND_ERROR",
      );
    }
  }

  async disableAutoStart(): Promise<void> {
    const result = await runCapture("schtasks", [
      "/Delete",
      "/TN",
      WINDOWS_TASK_NAME,
      "/F",
    ]);

    if (result.code === 0) {
      return;
    }

    const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (output.includes("cannot find the file specified")) {
      return;
    }

    const message = (result.stderr || result.stdout || "unknown error").trim();
    throw new LifelineError(
      `Failed to unregister startup task via Task Scheduler: ${message}`,
      "STARTUP_BACKEND_ERROR",
    );
  }

  async getAutoStartStatus(): Promise<StartupStatus> {
    const expectedTaskCommand = await resolveRestoreTaskCommand();
    const result = await runCapture("schtasks", [
      "/Query",
      "/TN",
      WINDOWS_TASK_NAME,
      "/XML",
    ]);

    if (result.code !== 0) {
      const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
      if (output.includes("cannot find the file specified")) {
        return {
          supported: true,
          enabled: false,
          mechanism: this.mechanism,
          detail: `${WINDOWS_TASK_NAME} is not registered.`,
        };
      }

      const message = (result.stderr || result.stdout || "unknown error").trim();
      throw new LifelineError(
        `Failed to query startup task via Task Scheduler: ${message}`,
        "STARTUP_BACKEND_ERROR",
      );
    }

    const normalizedXml = result.stdout.replace(/\s+/g, " ");
    const normalizedExpected = expectedTaskCommand.replace(/\s+/g, " ");
    const commandMatches = normalizedXml.includes(normalizedExpected);

    return {
      supported: true,
      enabled: true,
      mechanism: this.mechanism,
      detail: commandMatches
        ? `${WINDOWS_TASK_NAME} is registered and points to lifeline restore.`
        : `${WINDOWS_TASK_NAME} exists but command does not match expected restore entrypoint.`,
    };
  }
}

class UnsupportedStartupBackend implements StartupBackend {
  readonly mechanism = "unsupported";

  async enableAutoStart(): Promise<void> {
    throw new LifelineError(
      `Startup registration is not supported on platform ${process.platform}.`,
      "STARTUP_UNSUPPORTED_PLATFORM",
    );
  }

  async disableAutoStart(): Promise<void> {
    throw new LifelineError(
      `Startup registration is not supported on platform ${process.platform}.`,
      "STARTUP_UNSUPPORTED_PLATFORM",
    );
  }

  async getAutoStartStatus(): Promise<StartupStatus> {
    return {
      supported: false,
      enabled: false,
      mechanism: this.mechanism,
      detail: `Startup registration is not supported on platform ${process.platform}.`,
    };
  }
}

function resolveBackend(): StartupBackend {
  if (process.platform === "win32") {
    return new WindowsStartupBackend();
  }

  return new UnsupportedStartupBackend();
}

export async function enableStartup(): Promise<void> {
  await resolveBackend().enableAutoStart();
}

export async function disableStartup(): Promise<void> {
  await resolveBackend().disableAutoStart();
}

export async function getStartupStatus(): Promise<StartupStatus> {
  return await resolveBackend().getAutoStartStatus();
}
