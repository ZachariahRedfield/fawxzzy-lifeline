import process from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { access, readdir, stat } from "node:fs/promises";

const DIST_CLI_PATH = "dist/cli.js";
const SOURCE_ROOT = "src";

function failWithPreflightError(reason) {
  console.error("[smoke preflight] Lifeline CLI build check failed.");
  console.error(`[smoke preflight] ${reason}`);
  console.error("[smoke preflight] Run `pnpm build` before executing smoke tests.");
  process.exit(1);
}

async function latestMtimeMsInTree(rootDir) {
  let latest = 0;
  const entries = await readdir(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, await latestMtimeMsInTree(fullPath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!entry.name.endsWith(".ts")) {
      continue;
    }

    const entryStat = await stat(fullPath);
    latest = Math.max(latest, entryStat.mtimeMs);
  }

  return latest;
}

export async function ensureBuilt() {
  let cliStat;

  try {
    await access(DIST_CLI_PATH);
    cliStat = await stat(DIST_CLI_PATH);
  } catch {
    failWithPreflightError(`Missing ${DIST_CLI_PATH}.`);
  }

  let latestSourceMtimeMs;
  try {
    latestSourceMtimeMs = await latestMtimeMsInTree(SOURCE_ROOT);
  } catch {
    failWithPreflightError(`Unable to read source tree at ${SOURCE_ROOT}/.`);
  }

  if (latestSourceMtimeMs > cliStat.mtimeMs) {
    failWithPreflightError(
      `Detected stale build artifacts: ${DIST_CLI_PATH} is older than source files in ${SOURCE_ROOT}/.`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await ensureBuilt();
  console.error("[smoke preflight] OK: dist/cli.js is present and up to date.");
}
