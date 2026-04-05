import { createAixInittabBackend } from "../dist/core/startup-backends/aix-inittab.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function buildRunnerHarness() {
  let entry = "";

  const calls = [];

  const runner = async (command, args) => {
    calls.push([command, ...args]);

    if (command === "lsitab") {
      if (!entry) {
        return {
          code: 1,
          stdout: "",
          stderr:
            "0513-004 The specified entry was not found in the /etc/inittab file.",
        };
      }
      return { code: 0, stdout: entry, stderr: "" };
    }

    if (command === "mkitab" || command === "chitab") {
      const [candidate] = args;
      entry = candidate;
      return { code: 0, stdout: "", stderr: "" };
    }

    if (command === "rmitab") {
      if (!entry) {
        return {
          code: 1,
          stdout: "",
          stderr:
            "0513-004 The specified entry was not found in the /etc/inittab file.",
        };
      }
      entry = "";
      return { code: 0, stdout: "", stderr: "" };
    }

    throw new Error(
      `Unexpected command invocation: ${command} ${args.join(" ")}`,
    );
  };

  return {
    runner,
    setEntry(value) {
      entry = value;
    },
    getCalls() {
      return calls.slice();
    },
  };
}

async function main() {
  const harness = buildRunnerHarness();
  const backend = createAixInittabBackend(harness.runner);

  const initialInspect = await backend.inspect();
  assert(
    initialInspect.status === "not-installed",
    `Expected initial inspect status not-installed, got ${initialInspect.status}.`,
  );

  const dryRunInstall = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunInstall.status === "not-installed",
    `Expected dry-run install status not-installed, got ${dryRunInstall.status}.`,
  );
  assert(
    dryRunInstall.detail.includes("Dry-run:"),
    "Expected dry-run install detail to include Dry-run marker.",
  );

  const installResult = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    installResult.status === "installed",
    `Expected install status installed, got ${installResult.status}.`,
  );

  const inspectAfterInstall = await backend.inspect();
  assert(
    inspectAfterInstall.status === "installed",
    `Expected inspect status installed after install, got ${inspectAfterInstall.status}.`,
  );
  assert(
    inspectAfterInstall.detail.includes("lifeline restore"),
    `Expected inspect detail to include canonical restore entrypoint, got: ${inspectAfterInstall.detail}`,
  );

  harness.setEntry("llrestore:2:once:/bin/sh -lc 'echo drifted'");
  const inspectDrift = await backend.inspect();
  assert(
    inspectDrift.status === "not-installed",
    `Expected drifted inspect status not-installed, got ${inspectDrift.status}.`,
  );

  const reinstallResult = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    reinstallResult.status === "installed",
    `Expected reinstall status installed, got ${reinstallResult.status}.`,
  );

  const dryRunUninstall = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunUninstall.status === "installed",
    `Expected dry-run uninstall status installed, got ${dryRunUninstall.status}.`,
  );
  assert(
    dryRunUninstall.detail.includes("Dry-run:"),
    "Expected dry-run uninstall detail to include Dry-run marker.",
  );

  const uninstallResult = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    uninstallResult.status === "not-installed",
    `Expected uninstall status not-installed, got ${uninstallResult.status}.`,
  );

  const inspectAfterUninstall = await backend.inspect();
  assert(
    inspectAfterUninstall.status === "not-installed",
    `Expected inspect status not-installed after uninstall, got ${inspectAfterUninstall.status}.`,
  );

  const mutationCommands = harness
    .getCalls()
    .filter(
      ([command]) =>
        command === "mkitab" || command === "chitab" || command === "rmitab",
    )
    .map(([command]) => command);

  assert(
    mutationCommands.includes("mkitab") &&
      mutationCommands.includes("chitab") &&
      mutationCommands.includes("rmitab"),
    `Expected install/update/uninstall commands mkitab/chitab/rmitab, got: ${mutationCommands.join(", ")}`,
  );

  console.log("Deterministic AIX startup backend verification passed.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `Deterministic AIX startup backend verification failed: ${message}`,
  );
  process.exitCode = 1;
});
