import { loadManifestFile } from "../core/load-manifest.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

interface FitnessMirrorManifest {
  name?: unknown;
  archetype?: unknown;
  port?: unknown;
  healthcheckPath?: unknown;
  deploy?: {
    workingDirectory?: unknown;
  };
}

const EXPECTED_SHAPE: Record<string, unknown> = {
  name: "fitness",
  archetype: "node-web",
  port: 4301,
  healthcheckPath: "/login",
  "deploy.workingDirectory": "..",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateFitnessMirrorManifest(
  manifest: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (!isRecord(manifest)) {
    return [{ path: "$", message: "manifest must be a YAML object" }];
  }

  const candidate = manifest as FitnessMirrorManifest;
  const topLevelKeys = Object.keys(manifest).sort();
  const expectedTopLevelKeys = [
    "archetype",
    "deploy",
    "healthcheckPath",
    "name",
    "port",
  ];

  if (JSON.stringify(topLevelKeys) !== JSON.stringify(expectedTopLevelKeys)) {
    issues.push({
      path: "$",
      message: `expected top-level keys: ${expectedTopLevelKeys.join(", ")}`,
    });
  }

  if (candidate.name !== EXPECTED_SHAPE.name) {
    issues.push({
      path: "name",
      message: `must equal '${EXPECTED_SHAPE.name}' for Fitness mirror boundary`,
    });
  }

  if (candidate.archetype !== EXPECTED_SHAPE.archetype) {
    issues.push({
      path: "archetype",
      message: `must equal '${EXPECTED_SHAPE.archetype}' for Fitness mirror boundary`,
    });
  }

  if (candidate.port !== EXPECTED_SHAPE.port) {
    issues.push({
      path: "port",
      message: `must equal ${EXPECTED_SHAPE.port} for Fitness mirror boundary`,
    });
  }

  if (candidate.healthcheckPath !== EXPECTED_SHAPE.healthcheckPath) {
    issues.push({
      path: "healthcheckPath",
      message: `must equal '${EXPECTED_SHAPE.healthcheckPath}' for Fitness mirror boundary`,
    });
  }

  if (!isRecord(candidate.deploy)) {
    issues.push({ path: "deploy", message: "must be an object" });
    return issues;
  }

  const deployKeys = Object.keys(candidate.deploy).sort();
  if (JSON.stringify(deployKeys) !== JSON.stringify(["workingDirectory"])) {
    issues.push({
      path: "deploy",
      message: "expected deploy keys: workingDirectory",
    });
  }

  if (candidate.deploy.workingDirectory !== EXPECTED_SHAPE["deploy.workingDirectory"]) {
    issues.push({
      path: "deploy.workingDirectory",
      message: `must equal '${EXPECTED_SHAPE["deploy.workingDirectory"]}' for Fitness mirror boundary`,
    });
  }

  return issues;
}

export async function validateFitnessMirrorManifestFile(
  manifestPath: string,
): Promise<ValidationIssue[]> {
  const rawManifest = await loadManifestFile(manifestPath);
  return validateFitnessMirrorManifest(rawManifest);
}
