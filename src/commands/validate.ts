import { validateAppManifest } from "../contracts/app-manifest.js";
import { ManifestLoadError, ValidationError } from "../core/errors.js";
import { loadManifestFile } from "../core/load-manifest.js";
import { resolveManifestConfig } from "../core/resolve-config.js";

export async function runValidateCommand(
  manifestPath: string,
  playbookPath?: string,
): Promise<number> {
  try {
    if (playbookPath || process.env.LIFELINE_PLAYBOOK_PATH) {
      const resolved = await resolveManifestConfig(
        playbookPath ? { manifestPath, playbookPath } : { manifestPath },
      );
      console.log(`Resolved manifest is valid: ${manifestPath}`);
      console.log(`- app: ${resolved.resolvedManifest.name}`);
      console.log(`- archetype: ${resolved.resolvedManifest.archetype}`);
      console.log(`- port: ${resolved.resolvedManifest.port}`);
      if (resolved.playbookPath) {
        console.log(`- playbook: ${resolved.playbookPath}`);
      }
      return 0;
    }

    const rawManifest = await loadManifestFile(manifestPath);
    const result = validateAppManifest(rawManifest);

    if (result.issues.length > 0) {
      console.error(`Manifest is invalid: ${manifestPath}`);
      for (const issue of result.issues) {
        console.error(`- ${issue.path}: ${issue.message}`);
      }
      return 1;
    }

    console.log(`Manifest is valid: ${manifestPath}`);
    console.log(`- app: ${result.manifest?.name}`);
    console.log(`- archetype: ${result.manifest?.archetype}`);
    console.log(`- port: ${result.manifest?.port}`);
    return 0;
  } catch (error) {
    if (
      error instanceof ManifestLoadError ||
      error instanceof ValidationError
    ) {
      console.error(error.message);
      return 1;
    }

    throw error;
  }
}
