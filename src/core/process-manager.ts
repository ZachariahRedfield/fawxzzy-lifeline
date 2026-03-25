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

async function runCapture(
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
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

export async function startDetachedCommand(options: {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
}): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(options.command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      detached: !isWindows(),
      stdio: "ignore",
    });

    child.on("error", (error) => {
      reject(
        new ProcessManagerError(
          `Failed to start ${options.label}: ${error.message}`,
        ),
      );
    });

    child.on("spawn", () => {
      child.unref();
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

export async function findListeningPortOwnerPid(
  port: number,
): Promise<number | undefined> {
  if (isWindows()) {
    const result = await runCapture("netstat", ["-ano", "-p", "tcp"]);
    if (result.code !== 0) {
      return undefined;
    }

    const lines = result.stdout.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes("LISTENING")) {
        continue;
      }
      const parts = trimmed.split(/\s+/);
      if (parts.length < 5) {
        continue;
      }
      const localAddress = parts[1];
      const pidRaw = parts[4];
      if (!localAddress?.endsWith(`:${port}`)) {
        continue;
      }
      const pid = Number(pidRaw);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    }

    return undefined;
  }

  const lsof = await runCapture("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])
    .catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (lsof.code === 0) {
    const first = lsof.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first) {
      const pid = Number(first);
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    }
  }

  const ss = await runCapture("ss", ["-ltnp"])
    .catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (ss.code !== 0) {
    return undefined;
  }

  const lines = ss.stdout.split(/\r?\n/);
  for (const line of lines) {
    if (!line.includes(`:${port}`)) {
      continue;
    }
    const pidMatch = line.match(/pid=(\d+)/);
    if (!pidMatch) {
      continue;
    }
    const pid = Number(pidMatch[1]);
    if (Number.isInteger(pid) && pid > 0) {
      return pid;
    }
  }

  return undefined;
}

export async function waitForPortToClear(
  port: number,
  timeoutMs = 8_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ownerPid = await findListeningPortOwnerPid(port);
    if (!ownerPid) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return (await findListeningPortOwnerPid(port)) === undefined;
}

export async function stopProcess(pid: number): Promise<void> {
  if (!(await isProcessAlive(pid))) {
    return;
  }

  if (isWindows()) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
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
