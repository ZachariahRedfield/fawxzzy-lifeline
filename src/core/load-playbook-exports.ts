import { access } from "node:fs/promises";
import path from "node:path";

import { readFile } from "node:fs/promises";
import type { AppArchetype, AppManifest } from "../contracts/app-manifest.js";
import { ManifestLoadError, ValidationError } from "./errors.js";
import { parseSimpleYaml } from "./load-manifest.js";

export const SUPPORTED_PLAYBOOK_SCHEMA_VERSION = 1;

export type PlaybookArchetypeDefaults = Pick<
  AppManifest,
  | "installCommand"
  | "buildCommand"
  | "startCommand"
  | "port"
  | "healthcheckPath"
  | "env"
  | "deploy"
>;

export interface PlaybookExports {
  playbookPath: string;
  exportPath: string;
  schemaVersion: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(
      `Playbook export field ${field} must be a non-empty string.`,
    );
  }

  return value;
}

function assertStringArray(field: string, value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) => typeof entry !== "string" || entry.trim().length === 0,
    )
  ) {
    throw new ValidationError(
      `Playbook export field ${field} must be an array of non-empty strings.`,
    );
  }

  return value;
}

async function readYamlFile(filePath: string): Promise<unknown> {
  let raw: string;

  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown read error";
    throw new ManifestLoadError(
      `Could not read Playbook export at ${filePath}: ${message}`,
    );
  }

  try {
    return parseSimpleYaml(raw);
  } catch (error) {
    if (error instanceof ManifestLoadError) {
      throw error;
    }

    const message =
      error instanceof Error ? error.message : "unknown parse error";
    throw new ManifestLoadError(
      `Could not parse Playbook export YAML at ${filePath}: ${message}`,
    );
  }
}

export async function resolvePlaybookPath(
  explicitPath?: string,
): Promise<string | undefined> {
  const configuredPath = explicitPath ?? process.env.LIFELINE_PLAYBOOK_PATH;
  return configuredPath ? path.resolve(configuredPath) : undefined;
}

export async function loadPlaybookExports(
  playbookPathInput: string,
): Promise<PlaybookExports> {
  const playbookPath = path.resolve(playbookPathInput);
  const exportPath = path.join(playbookPath, "exports", "lifeline");

  try {
    await access(exportPath);
  } catch {
    throw new ValidationError(
      `Playbook export directory does not exist: ${exportPath}. Expected <playbook-path>/exports/lifeline/.`,
    );
  }

  const schemaVersionPath = path.join(exportPath, "schema-version.json");
  let rawSchema: string;
  try {
    rawSchema = await readFile(schemaVersionPath, "utf8");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown read error";
    throw new ManifestLoadError(
      `Could not read Playbook schema version file at ${schemaVersionPath}: ${message}`,
    );
  }

  let parsedSchema: unknown;
  try {
    parsedSchema = JSON.parse(rawSchema);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown parse error";
    throw new ManifestLoadError(
      `Could not parse Playbook schema version file at ${schemaVersionPath}: ${message}`,
    );
  }

  if (!isRecord(parsedSchema) || typeof parsedSchema.version !== "number") {
    throw new ValidationError(
      `Playbook schema version file is invalid: ${schemaVersionPath}. Expected {"version": <number>}.`,
    );
  }

  if (parsedSchema.version !== SUPPORTED_PLAYBOOK_SCHEMA_VERSION) {
    throw new ValidationError(
      `Unsupported Playbook schema version ${parsedSchema.version} at ${schemaVersionPath}. Supported version: ${SUPPORTED_PLAYBOOK_SCHEMA_VERSION}.`,
    );
  }

  return {
    playbookPath,
    exportPath,
    schemaVersion: parsedSchema.version,
  };
}

export async function loadPlaybookArchetypeDefaults(
  playbookPathInput: string,
  archetype: AppArchetype,
): Promise<PlaybookArchetypeDefaults> {
  const exports = await loadPlaybookExports(playbookPathInput);
  const archetypePath = path.join(
    exports.exportPath,
    "archetypes",
    `${archetype}.yml`,
  );

  try {
    await access(archetypePath);
  } catch {
    throw new ValidationError(
      `Playbook archetype export is missing for ${archetype}: ${archetypePath}.`,
    );
  }

  const parsed = await readYamlFile(archetypePath);
  if (!isRecord(parsed)) {
    throw new ValidationError(
      `Playbook archetype export ${archetypePath} must be a YAML object.`,
    );
  }

  const envValue = parsed.env;
  if (!isRecord(envValue)) {
    throw new ValidationError(
      `Playbook archetype export ${archetypePath} is missing env defaults.`,
    );
  }

  const deployValue = parsed.deploy;
  if (!isRecord(deployValue)) {
    throw new ValidationError(
      `Playbook archetype export ${archetypePath} is missing deploy defaults.`,
    );
  }

  const port = parsed.port;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new ValidationError(
      "Playbook export field port must be an integer between 1 and 65535.",
    );
  }

  const envMode = assertNonEmptyString(
    "env.mode",
    envValue.mode,
  ) as AppManifest["env"]["mode"];
  const envFile =
    envValue.file === undefined
      ? undefined
      : assertNonEmptyString("env.file", envValue.file);
  const requiredKeys = assertStringArray(
    "env.requiredKeys",
    envValue.requiredKeys ?? envValue.required,
  );
  const strategy = assertNonEmptyString(
    "deploy.strategy",
    deployValue.strategy,
  ) as AppManifest["deploy"]["strategy"];
  const workingDirectory =
    deployValue.workingDirectory === undefined
      ? undefined
      : assertNonEmptyString(
          "deploy.workingDirectory",
          deployValue.workingDirectory,
        );

  return {
    installCommand: assertNonEmptyString(
      "installCommand",
      parsed.installCommand,
    ),
    buildCommand: assertNonEmptyString("buildCommand", parsed.buildCommand),
    startCommand: assertNonEmptyString("startCommand", parsed.startCommand),
    port,
    healthcheckPath: assertNonEmptyString(
      "healthcheckPath",
      parsed.healthcheckPath,
    ),
    env: {
      mode: envMode,
      ...(envFile ? { file: envFile } : {}),
      requiredKeys,
    },
    deploy: {
      strategy,
      ...(workingDirectory ? { workingDirectory } : {}),
    },
  };
}
