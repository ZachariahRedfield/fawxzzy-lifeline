import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface RuntimeAppState {
  name: string;
  manifestPath: string;
  playbookPath?: string | undefined;
  workingDirectory: string;
  pid: number;
  port: number;
  healthcheckPath: string;
  logPath: string;
  startedAt: string;
  lastKnownStatus: "running" | "stopped" | "unhealthy";
}

export interface RuntimeStateFile {
  apps: Record<string, RuntimeAppState>;
}

const LIFELINE_DIR = path.resolve(process.cwd(), ".lifeline");
const STATE_PATH = path.join(LIFELINE_DIR, "state.json");

async function ensureStateDirectory(): Promise<void> {
  await mkdir(LIFELINE_DIR, { recursive: true });
}

export async function getStatePath(): Promise<string> {
  await ensureStateDirectory();
  return STATE_PATH;
}

export async function readState(): Promise<RuntimeStateFile> {
  await ensureStateDirectory();

  const raw = await readFile(STATE_PATH, "utf8").catch(() => "");
  if (!raw) {
    return { apps: {} };
  }

  const parsed = JSON.parse(raw) as Partial<RuntimeStateFile>;
  return { apps: parsed.apps ?? {} };
}

export async function writeState(state: RuntimeStateFile): Promise<void> {
  await ensureStateDirectory();
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function getAppState(
  appName: string,
): Promise<RuntimeAppState | undefined> {
  const state = await readState();
  return state.apps[appName];
}

export async function upsertAppState(appState: RuntimeAppState): Promise<void> {
  const state = await readState();
  state.apps[appState.name] = appState;
  await writeState(state);
}

export async function removeAppState(appName: string): Promise<void> {
  const state = await readState();
  delete state.apps[appName];
  await writeState(state);
}
