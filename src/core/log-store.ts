import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";

const LIFELINE_DIR = path.resolve(process.cwd(), ".lifeline");
const LOGS_DIR = path.join(LIFELINE_DIR, "logs");

export async function ensureLogDirectory(): Promise<string> {
  await mkdir(LOGS_DIR, { recursive: true });
  return LOGS_DIR;
}

export async function getLogPath(appName: string): Promise<string> {
  const logsDir = await ensureLogDirectory();
  return path.join(logsDir, `${appName}.log`);
}

export async function appendLogHeader(
  logPath: string,
  line: string,
): Promise<void> {
  const handle = await open(logPath, "a");
  await handle.appendFile(`${line}\n`);
  await handle.close();
}

export async function tailLogFile(
  logPath: string,
  lineCount: number,
): Promise<string[]> {
  const raw = await readFile(logPath, "utf8").catch(() => "");
  const lines = raw.split(/\r?\n/).filter((line) => line.length > 0);
  return lines.slice(-lineCount);
}
