export const SUPPORTED_ARCHETYPES = ["next-web", "node-web"] as const;
export const SUPPORTED_ENV_MODES = ["inline", "file"] as const;
export const SUPPORTED_DEPLOY_STRATEGIES = ["rebuild", "restart"] as const;

export type AppArchetype = (typeof SUPPORTED_ARCHETYPES)[number];
export type EnvMode = (typeof SUPPORTED_ENV_MODES)[number];
export type DeployStrategy = (typeof SUPPORTED_DEPLOY_STRATEGIES)[number];

export interface AppManifest {
  name: string;
  archetype: AppArchetype;
  repo: string;
  branch: string;
  projectPath?: string;
  installCommand: string;
  buildCommand: string;
  startCommand: string;
  port: number;
  healthcheckPath: string;
  env: {
    mode: EnvMode;
    file?: string;
    requiredKeys: string[];
  };
  deploy: {
    strategy: DeployStrategy;
    workingDirectory?: string;
  };
}

export type AppManifestInput = Partial<Omit<AppManifest, "env" | "deploy">> & {
  env?: Partial<AppManifest["env"]> & {
    required?: string[];
  };
  deploy?: Partial<AppManifest["deploy"]>;
};

export interface ValidationIssue {
  path: string;
  message: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isNonEmptyString);

interface ValidateManifestOptions {
  requireRunnableFields: boolean;
}

function validateManifestLike(
  value: unknown,
  options: ValidateManifestOptions,
): {
  manifest?: AppManifest;
  issues: ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];

  if (!isRecord(value)) {
    return {
      issues: [{ path: "$", message: "manifest must be a YAML object" }],
    };
  }

  const checkString = (
    field: string,
    input: unknown,
    required = options.requireRunnableFields,
  ): string | undefined => {
    if (input === undefined) {
      if (required) {
        issues.push({ path: field, message: "must be a non-empty string" });
      }
      return undefined;
    }

    if (!isNonEmptyString(input)) {
      issues.push({ path: field, message: "must be a non-empty string" });
      return undefined;
    }

    return input;
  };

  const name = checkString("name", value.name);
  const archetype = checkString("archetype", value.archetype);
  const repo = checkString("repo", value.repo);
  const branch = checkString("branch", value.branch);
  const installCommand = checkString("installCommand", value.installCommand);
  const buildCommand = checkString("buildCommand", value.buildCommand);
  const startCommand = checkString("startCommand", value.startCommand);
  const healthcheckPath = checkString("healthcheckPath", value.healthcheckPath);

  if (archetype && !SUPPORTED_ARCHETYPES.includes(archetype as AppArchetype)) {
    issues.push({
      path: "archetype",
      message: `must be one of: ${SUPPORTED_ARCHETYPES.join(", ")}`,
    });
  }

  let projectPath: string | undefined;
  if (value.projectPath !== undefined) {
    projectPath = checkString("projectPath", value.projectPath, false);
  }

  if (value.port === undefined) {
    if (options.requireRunnableFields) {
      issues.push({
        path: "port",
        message: "must be an integer between 1 and 65535",
      });
    }
  } else if (
    typeof value.port !== "number" ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535
  ) {
    issues.push({
      path: "port",
      message: "must be an integer between 1 and 65535",
    });
  }

  if (healthcheckPath && !healthcheckPath.startsWith("/")) {
    issues.push({ path: "healthcheckPath", message: "must start with '/'" });
  }

  const envValue = value.env;
  let env: AppManifest["env"] | undefined;
  if (envValue === undefined) {
    if (options.requireRunnableFields) {
      issues.push({ path: "env", message: "must be an object" });
    }
  } else if (!isRecord(envValue)) {
    issues.push({ path: "env", message: "must be an object" });
  } else {
    const mode = checkString("env.mode", envValue.mode);
    if (mode && !SUPPORTED_ENV_MODES.includes(mode as EnvMode)) {
      issues.push({
        path: "env.mode",
        message: `must be one of: ${SUPPORTED_ENV_MODES.join(", ")}`,
      });
    }

    let file: string | undefined;
    if (envValue.file !== undefined) {
      file = checkString("env.file", envValue.file, false);
    }

    if (mode === "file" && !file) {
      issues.push({
        path: "env.file",
        message: "is required when env.mode is 'file'",
      });
    }

    const requiredKeysValue = envValue.requiredKeys ?? envValue.required ?? [];
    const usedLegacyRequired =
      envValue.required !== undefined && envValue.requiredKeys === undefined;

    if (!isStringArray(requiredKeysValue)) {
      issues.push({
        path: "env.requiredKeys",
        message:
          "must be an array when provided, and each key must be a non-empty string",
      });
    } else {
      env = {
        mode: (mode as EnvMode) ?? "inline",
        requiredKeys: requiredKeysValue,
        ...(file ? { file } : {}),
      };
    }

    if (usedLegacyRequired) {
      issues.push({
        path: "env.required",
        message: "has been renamed to env.requiredKeys",
      });
    }
  }

  const deployValue = value.deploy;
  let deploy: AppManifest["deploy"] | undefined;
  if (deployValue === undefined) {
    if (options.requireRunnableFields) {
      issues.push({ path: "deploy", message: "must be an object" });
    }
  } else if (!isRecord(deployValue)) {
    issues.push({ path: "deploy", message: "must be an object" });
  } else {
    const strategy = checkString("deploy.strategy", deployValue.strategy);
    if (
      strategy &&
      !SUPPORTED_DEPLOY_STRATEGIES.includes(strategy as DeployStrategy)
    ) {
      issues.push({
        path: "deploy.strategy",
        message: `must be one of: ${SUPPORTED_DEPLOY_STRATEGIES.join(", ")}`,
      });
    }

    let workingDirectory: string | undefined;
    if (deployValue.workingDirectory !== undefined) {
      workingDirectory = checkString(
        "deploy.workingDirectory",
        deployValue.workingDirectory,
        false,
      );
    }

    if (strategy) {
      deploy = {
        strategy: strategy as DeployStrategy,
        ...(workingDirectory ? { workingDirectory } : {}),
      };
    }
  }

  if (
    issues.length > 0 ||
    !name ||
    !archetype ||
    !repo ||
    !branch ||
    !installCommand ||
    !buildCommand ||
    !startCommand ||
    !healthcheckPath ||
    !env ||
    !deploy ||
    value.port === undefined
  ) {
    return { issues };
  }

  return {
    manifest: {
      name,
      archetype: archetype as AppArchetype,
      repo,
      branch,
      ...(projectPath ? { projectPath } : {}),
      installCommand,
      buildCommand,
      startCommand,
      port: value.port as number,
      healthcheckPath,
      env,
      deploy,
    },
    issues,
  };
}

export function validateAppManifest(value: unknown): {
  manifest?: AppManifest;
  issues: ValidationIssue[];
} {
  return validateManifestLike(value, { requireRunnableFields: true });
}

export function validateOptionalAppManifestDefaults(value: unknown): {
  issues: ValidationIssue[];
} {
  return validateManifestLike(value, { requireRunnableFields: false });
}
