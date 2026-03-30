import process from "node:process";
import { access } from "node:fs/promises";

const BUILD_ERROR_MESSAGE =
  "Lifeline CLI is not built. Run `pnpm build` before executing smoke tests.";

export async function ensureBuilt() {
  try {
    await access("dist/cli.js");
  } catch {
    console.error(BUILD_ERROR_MESSAGE);
    process.exit(1);
  }
}
