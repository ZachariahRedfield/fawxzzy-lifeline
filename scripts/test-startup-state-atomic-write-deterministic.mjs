import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lifeline-startup-state-atomic-"));
const originalCwd = process.cwd();

try {
  process.chdir(tempRoot);

  const startupContractModule = await import(
    new URL("../dist/core/startup-contract.js", import.meta.url)
  );
  const { getStartupStatus, setStartupIntent } = startupContractModule;

  const writeCount = 200;

  for (let index = 0; index < writeCount; index += 1) {
    const intent = index % 2 === 0 ? "enabled" : "disabled";
    await setStartupIntent(intent);
  }

  const startupStatePath = path.join(tempRoot, ".lifeline", "startup.json");
  const rawStartupState = await readFile(startupStatePath, "utf8");

  if (!rawStartupState.endsWith("\n")) {
    throw new Error("Expected startup state file to preserve trailing newline formatting.");
  }

  let parsedStartupState;
  try {
    parsedStartupState = JSON.parse(rawStartupState);
  } catch (error) {
    throw new Error(`Expected valid JSON in final startup state file. Error: ${String(error)}`);
  }

  const expectedFinalIntent = (writeCount - 1) % 2 === 0 ? "enabled" : "disabled";

  if (parsedStartupState?.intent !== expectedFinalIntent) {
    throw new Error(
      `Expected startup intent ${expectedFinalIntent}, received ${String(parsedStartupState?.intent)}.`,
    );
  }

  if (parsedStartupState?.restoreEntrypoint !== "lifeline restore") {
    throw new Error(
      `Expected restoreEntrypoint lifeline restore, received ${String(parsedStartupState?.restoreEntrypoint)}.`,
    );
  }

  if (parsedStartupState?.backendStatus !== "not-installed") {
    throw new Error(
      `Expected backendStatus not-installed, received ${String(parsedStartupState?.backendStatus)}.`,
    );
  }

  const status = await getStartupStatus();
  if (status.enabled !== (expectedFinalIntent === "enabled")) {
    throw new Error("Expected getStartupStatus() to return final persisted startup intent.");
  }

  console.log("Startup state atomic write deterministic verification passed.");
} finally {
  process.chdir(originalCwd);
}
