import { spawn } from "node:child_process";
import { open } from "node:fs/promises";

import { ProcessManagerError } from "./errors.js";

export interface RunCommandOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
}

export interface StartBackgroundOptions extends RunCommandOptions {
  logPath: string;
}

function isWindows(): boolean {
  return process.platform === "win32";
}

export async function runForegroundCommand(
  options: RunCommandOptions,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: "inherit",
    });

    child.on("error", (error) => {
      reject(
        new ProcessManagerError(
          `Failed to start ${options.label}: ${error.message}`,
        ),
      );
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new ProcessManagerError(
          `${options.label} failed in ${options.cwd} with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}.`,
        ),
      );
    });
  });
}

export async function startBackgroundProcess(
  options: StartBackgroundOptions,
): Promise<number> {
  const logHandle = await open(options.logPath, "a");

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(options.command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      detached: !isWindows(),
      stdio: ["ignore", logHandle.fd, logHandle.fd],
    });

    child.on("error", async (error) => {
      await logHandle.close();
      reject(
        new ProcessManagerError(
          `Failed to start ${options.label}: ${error.message}`,
        ),
      );
    });

    child.on("spawn", async () => {
      child.unref();
      await logHandle.close();
      if (!child.pid) {
        reject(
          new ProcessManagerError(
            `Failed to start ${options.label}: missing pid.`,
          ),
        );
        return;
      }
      resolve(child.pid);
    });
  });
}

export async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopProcess(pid: number): Promise<void> {
  if (!(await isProcessAlive(pid))) {
    return;
  }

  if (isWindows()) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: true,
        stdio: "ignore",
      });
      child.on("error", (error) =>
        reject(
          new ProcessManagerError(
            `Failed to stop pid ${pid}: ${error.message}`,
          ),
        ),
      );
      child.on("exit", (code) => {
        if (code === 0 || code === 128) {
          resolve();
          return;
        }
        reject(
          new ProcessManagerError(
            `taskkill failed for pid ${pid} with exit code ${code ?? "unknown"}.`,
          ),
        );
      });
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown stop error";
      throw new ProcessManagerError(`Failed to stop pid ${pid}: ${message}`);
    }
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await isProcessAlive(pid))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "unknown kill error";
      throw new ProcessManagerError(
        `Failed to force stop pid ${pid}: ${message}`,
      );
    }
  }
}
