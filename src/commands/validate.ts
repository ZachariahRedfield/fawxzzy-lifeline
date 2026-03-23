import { loadManifestFile } from "../core/load-manifest.js";
import { ManifestLoadError } from "../core/errors.js";
import { validateAppManifest } from "../contracts/app-manifest.js";

export async function runValidateCommand(manifestPath: string): Promise<number> {
  try {
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
    if (error instanceof ManifestLoadError) {
      console.error(error.message);
      return 1;
    }

    throw error;
  }
}
