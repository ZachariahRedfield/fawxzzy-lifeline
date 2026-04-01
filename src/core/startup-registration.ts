import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type StartupRegistrationBackend = "unconfigured";

export interface StartupRegistrationState {
  enabled: boolean;
  scope: "machine-local";
  target: "lifeline-restore";
  backend: StartupRegistrationBackend;
  updatedAt: string;
  note: string;
}

const LIFELINE_DIR = path.resolve(process.cwd(), ".lifeline");
const STARTUP_STATE_PATH = path.join(LIFELINE_DIR, "startup.json");

function createDefaultState(): StartupRegistrationState {
  return {
    enabled: false,
    scope: "machine-local",
    target: "lifeline-restore",
    backend: "unconfigured",
    updatedAt: new Date().toISOString(),
    note: "Wave 2 contract only: platform installers are not implemented yet.",
  };
}

async function ensureLifelineDirectory(): Promise<void> {
  await mkdir(LIFELINE_DIR, { recursive: true });
}

export async function readStartupRegistrationState(): Promise<StartupRegistrationState> {
  const raw = await readFile(STARTUP_STATE_PATH, "utf8").catch(() => "");
  if (!raw) {
    return createDefaultState();
  }

  const parsed = JSON.parse(raw) as Partial<StartupRegistrationState>;
  return {
    enabled: parsed.enabled ?? false,
    scope: parsed.scope ?? "machine-local",
    target: parsed.target ?? "lifeline-restore",
    backend: parsed.backend ?? "unconfigured",
    updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    note:
      parsed.note ??
      "Wave 2 contract only: platform installers are not implemented yet.",
  };
}

export async function writeStartupRegistrationState(
  state: StartupRegistrationState,
): Promise<void> {
  await ensureLifelineDirectory();
  await writeFile(
    STARTUP_STATE_PATH,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}

export async function updateStartupRegistrationState(
  enabled: boolean,
): Promise<StartupRegistrationState> {
  const current = await readStartupRegistrationState();
  const next: StartupRegistrationState = {
    ...current,
    enabled,
    updatedAt: new Date().toISOString(),
  };
  await writeStartupRegistrationState(next);
  return next;
}

export async function getStartupRegistrationStatePath(): Promise<string> {
  return STARTUP_STATE_PATH;
}
