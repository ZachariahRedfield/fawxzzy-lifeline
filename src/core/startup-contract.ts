import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type StartupIntent = "enabled" | "disabled";

export interface StartupStatus {
  supported: boolean;
  enabled: boolean;
  mechanism: string;
  detail: string;
  scope: "machine-local";
  restoreEntrypoint: "lifeline restore";
}

export interface StartupPlan {
  action: "enable" | "disable";
  scope: "machine-local";
  restoreEntrypoint: "lifeline restore";
  backendStatus: "not-installed";
  detail: string;
}

interface StartupState {
  version: 1;
  scope: "machine-local";
  restoreEntrypoint: "lifeline restore";
  intent: StartupIntent;
  backendStatus: "not-installed";
  updatedAt: string;
}

const LIFELINE_DIR = path.resolve(process.cwd(), ".lifeline");
const STARTUP_STATE_PATH = path.join(LIFELINE_DIR, "startup.json");

function defaultState(): StartupState {
  return {
    version: 1,
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    intent: "disabled",
    backendStatus: "not-installed",
    updatedAt: new Date().toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeIntent(value: unknown): StartupIntent {
  return value === "enabled" ? "enabled" : "disabled";
}

function sanitizeUpdatedAt(value: unknown): string {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return value;
  }

  return new Date().toISOString();
}

async function readStartupState(): Promise<StartupState> {
  const raw = await readFile(STARTUP_STATE_PATH, "utf8").catch(() => "");
  if (!raw) {
    return defaultState();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultState();
  }

  if (!isRecord(parsed)) {
    return defaultState();
  }

  return {
    version: 1,
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    backendStatus: "not-installed",
    intent: sanitizeIntent(parsed.intent),
    updatedAt: sanitizeUpdatedAt(parsed.updatedAt),
  };
}

async function writeStartupState(state: StartupState): Promise<void> {
  await mkdir(LIFELINE_DIR, { recursive: true });

  const serializedState = `${JSON.stringify(state, null, 2)}\n`;
  const tempPath = path.join(
    LIFELINE_DIR,
    `startup.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  await writeFile(tempPath, serializedState, "utf8");

  const fsPromises = (await import("node:fs/promises")) as unknown as {
    rename(oldPath: string, newPath: string): Promise<void>;
    unlink(path: string): Promise<void>;
  };

  try {
    await fsPromises.rename(tempPath, STARTUP_STATE_PATH);
  } catch (error) {
    await fsPromises.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function planStartupAction(
  action: "enable" | "disable",
): Promise<StartupPlan> {
  return {
    action,
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    backendStatus: "not-installed",
    detail:
      action === "enable"
        ? "Contract intent will be recorded. Platform installer backends are not implemented yet."
        : "Contract intent will be cleared. Platform installer backends are not implemented yet.",
  };
}

export async function setStartupIntent(intent: StartupIntent): Promise<void> {
  const current = await readStartupState();
  await writeStartupState({
    ...current,
    intent,
    updatedAt: new Date().toISOString(),
  });
}

export async function getStartupStatus(): Promise<StartupStatus> {
  const state = await readStartupState();
  return {
    supported: false,
    enabled: state.intent === "enabled",
    mechanism: "contract-only",
    detail:
      state.intent === "enabled"
        ? "Startup intent is enabled in Lifeline state, but no OS installer backend is installed yet."
        : "Startup intent is disabled in Lifeline state.",
    scope: state.scope,
    restoreEntrypoint: state.restoreEntrypoint,
  };
}
