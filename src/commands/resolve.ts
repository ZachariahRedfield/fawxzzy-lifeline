import { ManifestLoadError, ValidationError } from "../core/errors.js";
import { resolveManifestConfig } from "../core/resolve-config.js";

export async function runResolveCommand(
  manifestPath: string,
  playbookPath?: string,
): Promise<number> {
  try {
    const resolved = await resolveManifestConfig(
      playbookPath ? { manifestPath, playbookPath } : { manifestPath },
    );
    console.log(JSON.stringify(resolved.resolvedManifest, null, 2));
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
