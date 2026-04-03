import {
  findListeningPortOwnerPid,
  isProcessAlive,
} from "../core/process-manager.js";
import { checkHealth } from "../core/healthcheck.js";
import { getAppState, upsertAppState } from "../core/state-store.js";

type StatusMode = "standard" | "proof-json" | "proof-text";

type StatusCommandOptions = {
  mode?: StatusMode;
  enforceProofGate?: boolean;
};

type RuntimeSnapshot = {
  appName: string;
  supervisorAlive: boolean;
  wrapperAlive: boolean;
  listenerAlive: boolean;
  managedChildAlive: boolean;
  managedPortOwner: boolean;
  inferredManagedPid: number | undefined;
  portOwnerPid: number | undefined;
  health: {
    ok: boolean;
    error?: string;
    status?: number;
  };
};

type ProofState = "ready" | "blocked" | "conflicted" | "not-ready";

function deriveProof(snapshot: RuntimeSnapshot): {
  ok: boolean;
  state: ProofState;
  reasons: string[];
} {
  if (
    snapshot.supervisorAlive &&
    snapshot.health.ok &&
    snapshot.managedChildAlive &&
    snapshot.managedPortOwner
  ) {
    return {
      ok: true,
      state: "ready",
      reasons: ["supervisor, managed child, port ownership, and healthcheck are healthy"],
    };
  }

  if (snapshot.portOwnerPid && !snapshot.managedPortOwner) {
    return {
      ok: false,
      state: "blocked",
      reasons: [`port is occupied by non-managed pid ${snapshot.portOwnerPid}`],
    };
  }

  if (snapshot.supervisorAlive && snapshot.managedChildAlive && !snapshot.health.ok) {
    return {
      ok: false,
      state: "conflicted",
      reasons: [snapshot.health.error ?? "healthcheck failed while managed process is alive"],
    };
  }

  return {
    ok: false,
    state: "not-ready",
    reasons: [
      !snapshot.supervisorAlive ? "supervisor is not running" : "managed app process is not running",
    ],
  };
}

function serializeProofPayload(snapshot: RuntimeSnapshot): {
  mode: "proof";
  proof: {
    ok: boolean;
    state: ProofState;
    reasons: string[];
  };
  parallel_work: string[];
  runtime: {
    app: string;
    status: string;
    supervisor_alive: boolean;
    child_alive: boolean;
    listener_alive: boolean;
    managed_port_owner: boolean;
    port_owner_pid?: number;
    managed_pid?: number;
    health: {
      ok: boolean;
      status?: number;
      error?: string;
    };
  };
} {
  const proof = deriveProof(snapshot);

  return {
    mode: "proof",
    proof,
    parallel_work: [],
    runtime: {
      app: snapshot.appName,
      status: proof.state,
      supervisor_alive: snapshot.supervisorAlive,
      child_alive: snapshot.managedChildAlive,
      listener_alive: snapshot.listenerAlive,
      managed_port_owner: snapshot.managedPortOwner,
      ...(snapshot.portOwnerPid ? { port_owner_pid: snapshot.portOwnerPid } : {}),
      ...(snapshot.inferredManagedPid ? { managed_pid: snapshot.inferredManagedPid } : {}),
      health: {
        ok: snapshot.health.ok,
        ...(snapshot.health.status ? { status: snapshot.health.status } : {}),
        ...(snapshot.health.error ? { error: snapshot.health.error } : {}),
      },
    },
  };
}

function printProofText(payload: ReturnType<typeof serializeProofPayload>): void {
  console.log(`Proof status for ${payload.runtime.app}: ${payload.proof.state}`);
  console.log(`- proof.ok: ${payload.proof.ok}`);
  console.log(`- reasons: ${payload.proof.reasons.join("; ")}`);
  console.log(`- supervisorAlive: ${payload.runtime.supervisor_alive}`);
  console.log(`- childAlive: ${payload.runtime.child_alive}`);
  console.log(`- managedPortOwner: ${payload.runtime.managed_port_owner}`);
  console.log(
    `- health: ${payload.runtime.health.ok ? `ok (${payload.runtime.health.status ?? 200})` : (payload.runtime.health.error ?? "failed")}`,
  );
}

export async function runStatusCommand(
  appName: string,
  options: StatusCommandOptions = {},
): Promise<number> {
  const state = await getAppState(appName);
  if (!state) {
    console.error(`No runtime state found for app ${appName}.`);
    return 1;
  }

  const supervisorAlive = await isProcessAlive(state.supervisorPid);
  const wrapperAlive = state.wrapperPid
    ? await isProcessAlive(state.wrapperPid)
    : false;
  const listenerAlive = state.listenerPid
    ? await isProcessAlive(state.listenerPid)
    : false;
  const portOwnerPid = await findListeningPortOwnerPid(state.port);

  const inferredManagedPid = state.childPid ?? state.listenerPid;
  const managedChildAlive = inferredManagedPid ? await isProcessAlive(inferredManagedPid) : false;
  const managedPortOwner =
    Boolean(portOwnerPid) &&
    Boolean(
      (state.childPid && portOwnerPid === state.childPid) ||
        (state.listenerPid && portOwnerPid === state.listenerPid),
    );

  if (!supervisorAlive) {
    if (portOwnerPid) {
      state.lastKnownStatus = "blocked";
      state.blockedReason = `port ${state.port} occupied by pid ${portOwnerPid}`;
    } else {
      state.lastKnownStatus = state.crashLoopDetected ? "crash-loop" : "stopped";
      state.blockedReason = undefined;
    }
  }

  const shouldCheckHealth = Boolean(portOwnerPid || managedChildAlive);
  const health = shouldCheckHealth
    ? await checkHealth(state.port, state.healthcheckPath)
    : { ok: false, error: "managed app process not running" };

  if (supervisorAlive && health.ok && managedChildAlive && managedPortOwner) {
    state.lastKnownStatus = "running";
    state.childPid = inferredManagedPid;
    state.listenerPid = portOwnerPid ?? state.listenerPid;
    state.blockedReason = undefined;
  } else if (supervisorAlive && managedPortOwner && !health.ok) {
    state.lastKnownStatus = "unhealthy";
    state.listenerPid = portOwnerPid ?? state.listenerPid;
    state.blockedReason = undefined;
  } else if (supervisorAlive && !managedChildAlive && portOwnerPid) {
    state.lastKnownStatus = "blocked";
    state.blockedReason = `port ${state.port} occupied by pid ${portOwnerPid}`;
  } else if (supervisorAlive) {
    state.lastKnownStatus = "stopped";
    state.blockedReason = undefined;
  }

  state.portOwnerPid = portOwnerPid;
  await upsertAppState(state);

  const runtimeSnapshot: RuntimeSnapshot = {
    appName,
    supervisorAlive,
    wrapperAlive,
    listenerAlive,
    managedChildAlive,
    managedPortOwner,
    inferredManagedPid,
    portOwnerPid,
    health,
  };

  if (options.mode === "proof-json" || options.mode === "proof-text") {
    const payload = serializeProofPayload(runtimeSnapshot);

    if (options.mode === "proof-json") {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      printProofText(payload);
    }

    return options.enforceProofGate && !payload.proof.ok ? 1 : 0;
  }

  console.log(`App ${appName} is ${state.lastKnownStatus}.`);
  console.log(
    `- supervisor: ${supervisorAlive ? `alive (pid ${state.supervisorPid})` : `stopped (pid ${state.supervisorPid})`}`,
  );
  console.log(
    `- child: ${managedChildAlive ? `alive (pid ${inferredManagedPid})` : "stopped"}`,
  );
  console.log(
    `- wrapper: ${wrapperAlive ? `alive (pid ${state.wrapperPid})` : "stopped"}`,
  );
  console.log(
    `- listener: ${listenerAlive ? `alive (pid ${state.listenerPid})` : "unknown/stopped"}`,
  );
  console.log(`- portOwner: ${portOwnerPid ? `pid ${portOwnerPid}` : "none"}`);
  console.log(`- startedAt: ${state.startedAt}`);
  console.log(`- port: ${state.port}`);
  console.log(`- log: ${state.logPath}`);
  console.log(`- manifest: ${state.manifestPath}`);
  if (state.playbookPath) {
    console.log(`- playbook: ${state.playbookPath}`);
  }
  console.log(`- restartPolicy: ${state.restartPolicy}`);
  console.log(`- restartCount: ${state.restartCount}`);
  console.log(`- crashLoopDetected: ${state.crashLoopDetected}`);
  if (state.blockedReason) {
    console.log(`- blockedReason: ${state.blockedReason}`);
  }
  if (state.lastExitCode !== undefined) {
    console.log(`- lastExitCode: ${state.lastExitCode}`);
  }
  if (state.lastExitAt) {
    console.log(`- lastExitAt: ${state.lastExitAt}`);
  }
  console.log(
    `- healthcheck: http://127.0.0.1:${state.port}${state.healthcheckPath}`,
  );
  console.log(
    `- health: ${health.ok ? `ok (${health.status ?? 200})` : (health.error ?? "failed")}`,
  );

  return supervisorAlive && health.ok && managedChildAlive && managedPortOwner ? 0 : 1;
}
