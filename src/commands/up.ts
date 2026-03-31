import path from "node:path";

import type { AppManifest } from "../contracts/app-manifest.js";
import { ManifestLoadError, ValidationError } from "../core/errors.js";
import { checkHealth, waitForHealth } from "../core/healthcheck.js";
import { loadEnvFile } from "../core/load-env-file.js";
import { appendLogHeader, getLogPath } from "../core/log-store.js";
import {
  findListeningPortOwnerPid,
  isProcessAlive,
  runForegroundCommand,
  startDetachedCommand,
} from "../core/process-manager.js";
import { resolveManifestConfig } from "../core/resolve-config.js";
import { resolveWorkingDirectory } from "../core/resolve-working-directory.js";
import { getAppState, upsertAppState } from "../core/state-store.js";

export interface PreparedRuntimeApp {
  manifest: AppManifest;
  manifestPath: string;
  workingDirectory: string;
  env: NodeJS.ProcessEnv;
  playbookPath?: string | undefined;
}

export async function prepareRuntimeApp(
  manifestPathInput: string,
  playbookPath?: string,
): Promise<PreparedRuntimeApp> {
  const manifestPath = path.resolve(manifestPathInput);
  const resolved = await resolveManifestConfig(
    playbookPath ? { manifestPath, playbookPath } : { manifestPath },
  );

  const workingDirectory = await resolveWorkingDirectory(
    manifestPath,
    resolved.resolvedManifest,
  );
  const fileEnv = resolved.resolvedManifest.env.file
    ? await loadEnvFile(
        path.resolve(
          path.dirname(manifestPath),
          resolved.resolvedManifest.env.file,
        ),
      )
    : {};
  const env: NodeJS.ProcessEnv = {
    ...fileEnv,
    ...process.env,
  };

  const missingKeys = resolved.resolvedManifest.env.requiredKeys.filter(
    (key) => !env[key],
  );
  if (missingKeys.length > 0) {
    throw new ValidationError(
      `App ${resolved.resolvedManifest.name} is missing required environment keys: ${missingKeys.join(", ")}.`,
    );
  }

  return {
    manifest: resolved.resolvedManifest,
    manifestPath,
    workingDirectory,
    env,
    ...(resolved.playbookPath ? { playbookPath: resolved.playbookPath } : {}),
  };
}

export async function runUpCommand(
  manifestPathInput: string,
  playbookPath?: string,
): Promise<number> {
  try {
    const prepared = await prepareRuntimeApp(manifestPathInput, playbookPath);
    const existing = await getAppState(prepared.manifest.name);
    if (existing && (await isProcessAlive(existing.supervisorPid))) {
      console.error(
        `App ${prepared.manifest.name} is already managed by supervisor pid ${existing.supervisorPid}.`,
      );
      return 1;
    }
    const existingPortOwner = await findListeningPortOwnerPid(
      prepared.manifest.port,
    );
    if (existingPortOwner) {
      console.error(
        `App ${prepared.manifest.name} cannot start: port ${prepared.manifest.port} is already occupied by pid ${existingPortOwner}.`,
      );
      return 1;
    }

    const logPath = await getLogPath(prepared.manifest.name);
    await appendLogHeader(
      logPath,
      `=== lifeline up ${new Date().toISOString()} ===`,
    );

    console.log(
      `Installing ${prepared.manifest.name} in ${prepared.workingDirectory}...`,
    );
    await runForegroundCommand({
      command: prepared.manifest.installCommand,
      cwd: prepared.workingDirectory,
      env: prepared.env,
      label: `${prepared.manifest.name} installCommand`,
    });

    console.log(
      `Building ${prepared.manifest.name} in ${prepared.workingDirectory}...`,
    );
    await runForegroundCommand({
      command: prepared.manifest.buildCommand,
      cwd: prepared.workingDirectory,
      env: prepared.env,
      label: `${prepared.manifest.name} buildCommand`,
    });

    const startedAt = new Date().toISOString();
    await upsertAppState({
      name: prepared.manifest.name,
      manifestPath: prepared.manifestPath,
      ...(prepared.playbookPath ? { playbookPath: prepared.playbookPath } : {}),
      workingDirectory: prepared.workingDirectory,
      supervisorPid: process.pid,
      childPid: undefined,
      wrapperPid: undefined,
      listenerPid: undefined,
      portOwnerPid: undefined,
      port: prepared.manifest.port,
      healthcheckPath: prepared.manifest.healthcheckPath,
      logPath,
      startedAt,
      lastKnownStatus: "stopped",
      restartPolicy: prepared.manifest.runtime.restartPolicy,
      restartCount: 0,
      lastExitCode: undefined,
      lastExitAt: undefined,
      restorable: prepared.manifest.runtime.restorable,
      crashLoopDetected: false,
      blockedReason: undefined,
    });

    console.log(`Starting supervisor for ${prepared.manifest.name}...`);
    const cliPath = path.resolve(process.argv[1] || "dist/cli.js");
    const supervisorPid = await startDetachedCommand({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)} supervise ${JSON.stringify(prepared.manifest.name)}`,
      cwd: process.cwd(),
      env: process.env,
      label: `${prepared.manifest.name} supervisor`,
    });

    const state = await getAppState(prepared.manifest.name);
    if (!state) {
      console.error(`Unable to load state for app ${prepared.manifest.name}.`);
      return 1;
    }

    await upsertAppState({
      ...state,
      supervisorPid,
      startedAt,
    });

    const health = await waitForHealth(
      prepared.manifest.port,
      prepared.manifest.healthcheckPath,
    );

    const refreshed = await getAppState(prepared.manifest.name);
    if (refreshed) {
      await upsertAppState({
        ...refreshed,
        lastKnownStatus: health.ok ? "running" : "unhealthy",
      });
    }

    if (!health.ok) {
      console.error(
        `App ${prepared.manifest.name} supervisor started with pid ${supervisorPid}, but healthcheck failed at http://127.0.0.1:${prepared.manifest.port}${prepared.manifest.healthcheckPath}${health.error ? `: ${health.error}` : ""}.`,
      );
      return 1;
    }

    const confirmed = await checkHealth(
      prepared.manifest.port,
      prepared.manifest.healthcheckPath,
    );
    const finalState = await getAppState(prepared.manifest.name);
    console.log(`App ${prepared.manifest.name} is running.`);
    console.log(`- supervisor pid: ${supervisorPid}`);
    console.log(`- child pid: ${finalState?.childPid ?? "pending"}`);
    console.log(`- port: ${prepared.manifest.port}`);
    console.log(`- log: ${logPath}`);
    console.log(`- restartPolicy: ${prepared.manifest.runtime.restartPolicy}`);
    if (prepared.playbookPath) {
      console.log(`- playbook: ${prepared.playbookPath}`);
    }
    console.log(`- health: ${confirmed.status ?? "ok"}`);
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
