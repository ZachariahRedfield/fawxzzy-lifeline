import { readFile } from "node:fs/promises";

import { ValidationError } from "./errors.js";

export async function loadEnvFile(
  path: string,
): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown read error";
    throw new ValidationError(`Could not read env file at ${path}: ${message}`);
  }

  const env: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      throw new ValidationError(
        `Invalid env line ${index + 1} in ${path}: expected KEY=VALUE`,
      );
    }

    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1);

    if (key.length === 0) {
      throw new ValidationError(
        `Invalid env line ${index + 1} in ${path}: missing key`,
      );
    }

    env[key] = value;
  }

  return env;
}
