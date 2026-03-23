import { access } from "node:fs/promises";
import path from "node:path";

import type { AppManifest } from "../contracts/app-manifest.js";
import { ValidationError } from "./errors.js";

export async function resolveWorkingDirectory(manifestPath: string, manifest: AppManifest): Promise<string> {
  const configured = manifest.deploy.workingDirectory;
  if (!configured) {
    throw new ValidationError(
      `Manifest ${manifestPath} is missing deploy.workingDirectory, which is required for runtime commands.`,
    );
  }

  const resolved = path.resolve(path.dirname(path.resolve(manifestPath)), configured);

  try {
    await access(resolved);
  } catch {
    throw new ValidationError(
      `Working directory for app ${manifest.name} does not exist: ${resolved} (from ${manifestPath}).`,
    );
  }

  return resolved;
}
