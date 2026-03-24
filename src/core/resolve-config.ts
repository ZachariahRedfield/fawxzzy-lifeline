import type {
  AppManifest,
  AppManifestInput,
} from "../contracts/app-manifest.js";
import { validateAppManifest } from "../contracts/app-manifest.js";
import { ValidationError } from "./errors.js";
import { loadManifestFile } from "./load-manifest.js";
import {
  loadPlaybookArchetypeDefaults,
  resolvePlaybookPath,
} from "./load-playbook-exports.js";

export interface ResolveConfigOptions {
  manifestPath: string;
  playbookPath?: string | undefined;
}

export interface ResolvedConfigResult {
  manifestPath: string;
  resolvedManifest: AppManifest;
  rawManifest: AppManifestInput;
  playbookPath?: string | undefined;
  usedPlaybookDefaults: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeManifestWithDefaults(
  manifest: AppManifestInput,
  defaults?: Partial<AppManifest>,
): AppManifestInput {
  const merged: AppManifestInput = {
    ...defaults,
    ...manifest,
  };

  if (defaults?.env || isRecord(manifest.env)) {
    const requiredKeys = Array.isArray(manifest.env?.requiredKeys)
      ? manifest.env.requiredKeys
      : Array.isArray(manifest.env?.required)
        ? manifest.env.required
        : Array.isArray(defaults?.env?.requiredKeys)
          ? defaults.env.requiredKeys
          : [];

      merged.env = {
        ...(defaults?.env ?? {}),
        ...(isRecord(manifest.env) ? manifest.env : {}),
        requiredKeys,
      };
    }

  if (defaults?.deploy || isRecord(manifest.deploy)) {
    merged.deploy = {
      ...(defaults?.deploy ?? {}),
      ...(isRecord(manifest.deploy) ? manifest.deploy : {}),
    };
  }

  return merged;
}

export async function resolveManifestConfig(
  options: ResolveConfigOptions,
): Promise<ResolvedConfigResult> {
  const rawManifest = (await loadManifestFile(
    options.manifestPath,
  )) as AppManifestInput;
  const playbookPath = await resolvePlaybookPath(options.playbookPath);

  let defaults: Partial<AppManifest> | undefined;
  if (playbookPath) {
    if (!isRecord(rawManifest) || typeof rawManifest.archetype !== "string") {
      throw new ValidationError(
        `Manifest ${options.manifestPath} must include archetype before Playbook defaults can be loaded.`,
      );
    }

    defaults = await loadPlaybookArchetypeDefaults(
      playbookPath,
      rawManifest.archetype as AppManifest["archetype"],
    );
  }

  const merged = mergeManifestWithDefaults(rawManifest, defaults);
  const result = validateAppManifest(merged);
  if (result.issues.length > 0 || !result.manifest) {
    const issueLines = result.issues
      .map((issue) => `- ${issue.path}: ${issue.message}`)
      .join("\n");
    throw new ValidationError(
      `Resolved config is incomplete or invalid: ${options.manifestPath}\n${issueLines}`,
    );
  }

  return {
    manifestPath: options.manifestPath,
    resolvedManifest: result.manifest,
    rawManifest,
    ...(playbookPath ? { playbookPath } : {}),
    usedPlaybookDefaults: Boolean(playbookPath),
  };
}
