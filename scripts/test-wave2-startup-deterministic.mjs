import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function ensureBuiltCli() {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  try {
    await access(cliPath);
  } catch {
    await execFileAsync("pnpm", ["build"], {
      cwd: repoRoot,
      env: process.env,
    });
  }
}

async function verifyRestoreEntrypointWiring() {
  const cliSource = await readFile(
    new URL("../src/cli.ts", import.meta.url),
    "utf8",
  );

  assert(
    cliSource.includes("runRestoreCommand") &&
      cliSource.includes('case "restore":'),
    "Expected src/cli.ts to keep restore entrypoint wired through runRestoreCommand.",
  );

  assert(
    cliSource.includes("lifeline restore"),
    "Expected CLI usage output to keep the restore command discoverable.",
  );
}

async function verifyContractSurfaceWiring() {
  const startupCommandSource = await readFile(
    new URL("../src/commands/startup.ts", import.meta.url),
    "utf8",
  );
  const startupCoreSource = await readFile(
    new URL("../src/core/startup-contract.ts", import.meta.url),
    "utf8",
  );
  const startupBackendSource = await readFile(
    new URL("../src/core/startup-backend.ts", import.meta.url),
    "utf8",
  );

  assert(
    startupCommandSource.includes("--dry-run"),
    "Expected startup command to expose --dry-run planning support.",
  );

  assert(
    startupCoreSource.includes("resolveStartupBackend"),
    "Expected startup core to route planning/status through startup backend resolution.",
  );

  assert(
    startupCommandSource.includes("backend.install") &&
      startupCommandSource.includes("backend.uninstall"),
    "Expected startup command to wire enable/disable through backend install and uninstall calls.",
  );

  assert(
    startupBackendSource.includes('status: "unsupported"'),
    "Expected default startup backend to report unsupported status cleanly.",
  );

  assert(
    startupCoreSource.includes('restoreEntrypoint: "lifeline restore"'),
    "Expected startup core to keep restore entrypoint as lifeline restore.",
  );
}

async function verifySeamInstallDisableStatusAndDryRun() {
  await ensureBuiltCli();

  const tempDir = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(path.join(os.tmpdir(), "lifeline-wave2-startup-")),
  );
  const previousCwd = process.cwd();
  process.chdir(tempDir);

  try {
    const startupContractModule = await import(
      new URL("../dist/core/startup-contract.js", import.meta.url)
    );
    const {
      planStartupAction,
      createStartupMutationRequest,
      setStartupIntent,
      getStartupStatus,
    } = startupContractModule;

    const statePath = path.join(tempDir, ".lifeline", "startup.json");
    const fakeBackendState = {
      installed: false,
      installRequests: [],
      uninstallRequests: [],
    };

    const fakeBackend = {
      id: "deterministic-fake-backend",
      capabilities: ["inspect", "install", "uninstall"],
      inspect: async () => ({
        supported: true,
        status: fakeBackendState.installed ? "installed" : "not-installed",
        mechanism: "deterministic-fake-backend",
        detail: fakeBackendState.installed
          ? "Fake backend reports startup registration installed."
          : "Fake backend reports startup registration not installed.",
      }),
      install: async (request) => {
        fakeBackendState.installRequests.push(request);
        if (request.dryRun) {
          return {
            status: "not-installed",
            detail: "Dry-run: fake backend would install startup registration.",
          };
        }

        fakeBackendState.installed = true;
        return {
          status: "installed",
          detail: "Fake backend installed startup registration.",
        };
      },
      uninstall: async (request) => {
        fakeBackendState.uninstallRequests.push(request);
        if (request.dryRun) {
          return {
            status: fakeBackendState.installed ? "installed" : "not-installed",
            detail: "Dry-run: fake backend would remove startup registration.",
          };
        }

        fakeBackendState.installed = false;
        return {
          status: "not-installed",
          detail: "Fake backend removed startup registration.",
        };
      },
    };

    const dryRunEnablePlan = await planStartupAction("enable", fakeBackend);
    assert(
      dryRunEnablePlan.backendStatus === "not-installed",
      "Expected enable dry-run plan to stay not-installed.",
    );
    assert(
      fakeBackendState.installRequests.length === 1 &&
        fakeBackendState.installRequests[0].dryRun === true,
      "Expected enable plan to call backend install through dry-run seam request.",
    );
    await access(statePath).then(
      () => {
        throw new Error(
          "Dry-run planning must not create .lifeline/startup.json.",
        );
      },
      () => undefined,
    );

    const enableResult = await fakeBackend.install(
      createStartupMutationRequest(),
    );
    await setStartupIntent("enabled", enableResult.status);
    const statusAfterEnable = await getStartupStatus(fakeBackend);
    assert(
      statusAfterEnable.enabled === true,
      "Expected startup status to report enabled after install mutation.",
    );
    assert(
      statusAfterEnable.detail.includes("installed"),
      `Expected enabled startup status detail to include installed signal, got: ${statusAfterEnable.detail}`,
    );

    const dryRunDisablePlan = await planStartupAction("disable", fakeBackend);
    assert(
      dryRunDisablePlan.backendStatus === "installed",
      `Expected disable dry-run plan to reflect installed backend state, got ${dryRunDisablePlan.backendStatus}.`,
    );
    assert(
      fakeBackendState.uninstallRequests.length === 1 &&
        fakeBackendState.uninstallRequests[0].dryRun === true,
      "Expected disable plan to call backend uninstall through dry-run seam request.",
    );

    const disableResult = await fakeBackend.uninstall(
      createStartupMutationRequest(),
    );
    await setStartupIntent("disabled", disableResult.status);
    const statusAfterDisable = await getStartupStatus(fakeBackend);
    assert(
      statusAfterDisable.enabled === false,
      "Expected startup status to report disabled after uninstall mutation.",
    );
    assert(
      statusAfterDisable.detail.includes("not installed"),
      `Expected disabled startup status detail to include not-installed signal, got: ${statusAfterDisable.detail}`,
    );
  } finally {
    process.chdir(previousCwd);
  }
}

async function verifyBackendResolutionCoverageAndFallback() {
  await ensureBuiltCli();
  const startupBackendModule = await import(
    new URL("../dist/core/startup-backend.js", import.meta.url)
  );
  const { resolveStartupBackend } = startupBackendModule;

  const darwinBackend = resolveStartupBackend({ platform: "darwin" });
  assert(
    darwinBackend.id === "launchd-agent",
    `Expected darwin backend to resolve to launchd-agent, got ${darwinBackend.id}.`,
  );

  const linuxBackend = resolveStartupBackend({ platform: "linux" });
  assert(
    linuxBackend.id === "systemd-user",
    `Expected linux backend to resolve to systemd-user, got ${linuxBackend.id}.`,
  );

  const win32Backend = resolveStartupBackend({ platform: "win32" });
  assert(
    win32Backend.id === "windows-task-scheduler",
    `Expected win32 backend to resolve to windows-task-scheduler, got ${win32Backend.id}.`,
  );

  const freebsdBackend = resolveStartupBackend({ platform: "freebsd" });
  assert(
    freebsdBackend.id === "freebsd-rc.d",
    `Expected freebsd backend to resolve to freebsd-rc.d, got ${freebsdBackend.id}.`,
  );

  const openbsdBackend = resolveStartupBackend({ platform: "openbsd" });
  assert(
    openbsdBackend.id === "openbsd-rcctl",
    `Expected openbsd backend to resolve to openbsd-rcctl, got ${openbsdBackend.id}.`,
  );

  const netbsdBackend = resolveStartupBackend({ platform: "netbsd" });
  assert(
    netbsdBackend.id === "netbsd-rc.d",
    `Expected netbsd backend to resolve to netbsd-rc.d, got ${netbsdBackend.id}.`,
  );

  const aixBackend = resolveStartupBackend({ platform: "aix" });
  assert(
    aixBackend.id === "aix-inittab",
    `Expected aix backend to resolve to aix-inittab, got ${aixBackend.id}.`,
  );
  const aixInspection = await aixBackend.inspect();
  assert(
    ["installed", "not-installed", "unsupported"].includes(
      aixInspection.status,
    ),
    `Expected aix inspection status installed|not-installed|unsupported, got ${aixInspection.status}.`,
  );

  const unknownBackend = resolveStartupBackend({ platform: "sunos" });
  const fallbackInspection = await unknownBackend.inspect();
  assert(
    fallbackInspection.supported === false,
    "Expected unsupported fallback backend to report supported=false.",
  );
  assert(
    fallbackInspection.mechanism === "contract-only",
    `Expected contract-only mechanism, got ${fallbackInspection.mechanism}.`,
  );
  assert(
    fallbackInspection.detail.includes(
      "No startup installer backend is available on sunos yet.",
    ),
    `Expected unsupported inspection detail to include platform name, got: ${fallbackInspection.detail}`,
  );
}

async function verifyFreebsdRcDBackendDeterministicBehavior() {
  await ensureBuiltCli();

  const { mkdtemp, readFile } = await import("node:fs/promises");
  const startupBackendFreebsdModule = await import(
    new URL("../dist/core/startup-backends/freebsd-rcd.js", import.meta.url)
  );
  const { createFreebsdRcDBackend } = startupBackendFreebsdModule;

  const tempRoot = await mkdtemp(
    path.join(os.tmpdir(), "lifeline-freebsd-backend-"),
  );
  const rcDDirectory = path.join(tempRoot, "usr", "local", "etc", "rc.d");
  const rcConfDirectory = path.join(tempRoot, "etc", "rc.conf.d");

  const backend = createFreebsdRcDBackend({ rcDDirectory, rcConfDirectory });

  const dryRunInstall = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunInstall.status === "not-installed",
    `Expected FreeBSD dry-run install status not-installed, got ${dryRunInstall.status}.`,
  );
  assert(
    dryRunInstall.detail.includes("would write") &&
      dryRunInstall.detail.includes("lifeline_restore"),
    `Expected FreeBSD dry-run install detail to describe rc.d intent, got: ${dryRunInstall.detail}`,
  );

  const installResult = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    installResult.status === "installed",
    `Expected FreeBSD install status installed, got ${installResult.status}.`,
  );

  const scriptPath = path.join(rcDDirectory, "lifeline_restore");
  const rcConfPath = path.join(rcConfDirectory, "lifeline_restore");
  const scriptContents = await readFile(scriptPath, "utf8");
  const rcConfContents = await readFile(rcConfPath, "utf8");
  assert(
    scriptContents.includes("lifeline restore"),
    `Expected installed rc.d script to keep canonical restore entrypoint.\n${scriptContents}`,
  );
  assert(
    rcConfContents.includes('lifeline_restore_enable="YES"'),
    `Expected installed rc.conf entry to enable startup.\n${rcConfContents}`,
  );

  const inspectResult = await backend.inspect();
  assert(
    inspectResult.status === "installed",
    `Expected FreeBSD inspect status installed after install, got ${inspectResult.status}.`,
  );

  const dryRunUninstall = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunUninstall.detail.includes("would remove") ||
      dryRunUninstall.detail.includes("is not present"),
    `Expected FreeBSD dry-run uninstall detail to describe deterministic removal intent, got: ${dryRunUninstall.detail}`,
  );

  const uninstallResult = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    uninstallResult.status === "not-installed",
    `Expected FreeBSD uninstall status not-installed, got ${uninstallResult.status}.`,
  );

  const inspectAfterUninstall = await backend.inspect();
  assert(
    inspectAfterUninstall.status === "not-installed",
    `Expected FreeBSD inspect status not-installed after uninstall, got ${inspectAfterUninstall.status}.`,
  );
}

async function verifyAixInittabBackendDeterministicBehavior() {
  await ensureBuiltCli();

  const startupBackendAixModule = await import(
    new URL("../dist/core/startup-backends/aix-inittab.js", import.meta.url)
  );
  const { createAixInittabBackend } = startupBackendAixModule;

  let inittabEntry = "";
  const invocations = [];

  const runner = async (command, args) => {
    invocations.push([command, ...args]);

    if (command === "lsitab") {
      if (!inittabEntry) {
        return {
          code: 1,
          stdout: "",
          stderr:
            "0513-004 The specified entry was not found in the /etc/inittab file.",
        };
      }
      return { code: 0, stdout: inittabEntry, stderr: "" };
    }

    if (command === "mkitab" || command === "chitab") {
      [inittabEntry] = args;
      return { code: 0, stdout: "", stderr: "" };
    }

    if (command === "rmitab") {
      if (!inittabEntry) {
        return {
          code: 1,
          stdout: "",
          stderr:
            "0513-004 The specified entry was not found in the /etc/inittab file.",
        };
      }
      inittabEntry = "";
      return { code: 0, stdout: "", stderr: "" };
    }

    throw new Error(
      `Unexpected AIX backend invocation: ${command} ${args.join(" ")}`,
    );
  };

  const backend = createAixInittabBackend(runner);

  const initialInspection = await backend.inspect();
  assert(
    initialInspection.status === "not-installed",
    `Expected initial AIX inspect status not-installed, got ${initialInspection.status}.`,
  );

  const dryRunInstall = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunInstall.status === "not-installed",
    `Expected AIX dry-run install status not-installed, got ${dryRunInstall.status}.`,
  );
  assert(
    dryRunInstall.detail.includes("Dry-run:"),
    `Expected AIX dry-run install detail marker, got: ${dryRunInstall.detail}`,
  );

  const installResult = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    installResult.status === "installed",
    `Expected AIX install status installed, got ${installResult.status}.`,
  );

  inittabEntry = "llrestore:2:once:/bin/sh -lc 'echo drift'";
  const driftedInspection = await backend.inspect();
  assert(
    driftedInspection.status === "not-installed",
    `Expected drifted AIX inspect status not-installed, got ${driftedInspection.status}.`,
  );

  const reconcileResult = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    reconcileResult.status === "installed",
    `Expected AIX reconcile install status installed, got ${reconcileResult.status}.`,
  );

  const inspectAfterInstall = await backend.inspect();
  assert(
    inspectAfterInstall.status === "installed",
    `Expected AIX inspect status installed after install, got ${inspectAfterInstall.status}.`,
  );

  const dryRunUninstall = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunUninstall.status === "installed",
    `Expected AIX dry-run uninstall status installed, got ${dryRunUninstall.status}.`,
  );

  const uninstallResult = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    uninstallResult.status === "not-installed",
    `Expected AIX uninstall status not-installed, got ${uninstallResult.status}.`,
  );

  const inspectAfterUninstall = await backend.inspect();
  assert(
    inspectAfterUninstall.status === "not-installed",
    `Expected AIX inspect status not-installed after uninstall, got ${inspectAfterUninstall.status}.`,
  );

  const mutationCommands = invocations
    .filter(
      ([command]) =>
        command === "mkitab" || command === "chitab" || command === "rmitab",
    )
    .map(([command]) => command);

  assert(
    mutationCommands.includes("mkitab") &&
      mutationCommands.includes("chitab") &&
      mutationCommands.includes("rmitab"),
    `Expected AIX install/update/uninstall command coverage, got ${mutationCommands.join(", ")}.`,
  );
}

async function verifyLaunchdBackendDeterministicBehavior() {
  await ensureBuiltCli();

  const { mkdtemp, readFile } = await import("node:fs/promises");
  const startupBackendLaunchdModule = await import(
    new URL("../dist/core/startup-backends/launchd.js", import.meta.url)
  );
  const { createLaunchdBackend } = startupBackendLaunchdModule;

  const tempHome = await mkdtemp(
    path.join(os.tmpdir(), "lifeline-launchd-backend-"),
  );
  const invoked = [];

  const runner = async (args) => {
    invoked.push(args);

    if (args.join(" ") === "print gui/502/io.lifeline.restore") {
      return {
        code: 1,
        stdout: "",
        stderr:
          'Could not find service "io.lifeline.restore" in domain for user gui/502',
      };
    }

    if (args.join(" ") === "bootout gui/502/io.lifeline.restore") {
      return { code: 0, stdout: "", stderr: "" };
    }

    if (
      args.join(" ") ===
      `bootstrap gui/502 ${path.join(tempHome, "Library", "LaunchAgents", "io.lifeline.restore.plist")}`
    ) {
      return { code: 0, stdout: "", stderr: "" };
    }

    throw new Error(
      `Unexpected launchctl invocation in deterministic test: ${args.join(" ")}`,
    );
  };

  const backend = createLaunchdBackend(runner, {
    homeDirectory: tempHome,
    uid: 502,
  });

  const dryRunInstall = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunInstall.status === "not-installed",
    `Expected launchd dry-run install status not-installed, got ${dryRunInstall.status}.`,
  );
  assert(
    dryRunInstall.detail.includes("would write") &&
      dryRunInstall.detail.includes("bootstrap io.lifeline.restore"),
    `Expected launchd dry-run install detail to describe plist/bootstrap intent, got: ${dryRunInstall.detail}`,
  );

  const installResult = await backend.install({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    installResult.status === "installed",
    `Expected launchd install status installed, got ${installResult.status}.`,
  );

  const plistPath = path.join(
    tempHome,
    "Library",
    "LaunchAgents",
    "io.lifeline.restore.plist",
  );
  const rawPlist = await readFile(plistPath, "utf8");
  assert(
    rawPlist.includes("<string>lifeline</string>") &&
      rawPlist.includes("<string>restore</string>"),
    `Expected installed launchd plist to keep canonical restore entrypoint.\n${rawPlist}`,
  );

  const dryRunUninstall = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunUninstall.detail.includes(
      "LaunchAgent io.lifeline.restore is not present",
    ) ||
      dryRunUninstall.detail.includes(
        "would bootout LaunchAgent io.lifeline.restore",
      ),
    `Expected launchd dry-run uninstall detail to describe deterministic removal intent, got: ${dryRunUninstall.detail}`,
  );

  const uninstallResult = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: false,
  });
  assert(
    uninstallResult.status === "not-installed",
    `Expected launchd uninstall status not-installed, got ${uninstallResult.status}.`,
  );

  const invokedCommands = invoked.map((command) => command.join(" "));
  assert(
    invokedCommands.includes(`bootstrap gui/502 ${plistPath}`),
    `Expected launchd install path to run bootstrap.\ncommands:\n${invokedCommands.join("\n")}`,
  );
  assert(
    invokedCommands.includes("bootout gui/502/io.lifeline.restore"),
    `Expected launchd uninstall path to run bootout.\ncommands:\n${invokedCommands.join("\n")}`,
  );
}

async function verifySystemdBackendDeterministicBehavior() {
  await ensureBuiltCli();

  const { mkdtemp, readFile } = await import("node:fs/promises");
  const startupBackendSystemdModule = await import(
    new URL("../dist/core/startup-backends/systemd.js", import.meta.url)
  );
  const { createSystemdUserBackend } = startupBackendSystemdModule;

  const tempHome = await mkdtemp(
    path.join(os.tmpdir(), "lifeline-systemd-backend-"),
  );
  const invoked = [];

  const runner = async (args) => {
    invoked.push(args);

    if (args.join(" ") === "--user cat lifeline-restore.service") {
      return {
        code: 1,
        stdout: "",
        stderr: "Unit lifeline-restore.service could not be found.",
      };
    }

    if (args.join(" ") === "--user daemon-reload") {
      return { code: 0, stdout: "", stderr: "" };
    }

    if (args.join(" ") === "--user enable --now lifeline-restore.service") {
      return { code: 0, stdout: "Created symlink.", stderr: "" };
    }

    if (args.join(" ") === "--user disable --now lifeline-restore.service") {
      return { code: 0, stdout: "Removed symlink.", stderr: "" };
    }

    throw new Error(
      `Unexpected systemctl invocation in deterministic test: ${args.join(" ")}`,
    );
  };

  const backend = createSystemdUserBackend(runner, { homeDirectory: tempHome });

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
    dryRunInstall.detail.includes(
      "would write user unit lifeline-restore.service",
    ),
    `Expected dry-run install detail to describe unit creation, got: ${dryRunInstall.detail}`,
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
  const unitPath = path.join(
    tempHome,
    ".config",
    "systemd",
    "user",
    "lifeline-restore.service",
  );
  const rawUnit = await readFile(unitPath, "utf8");
  assert(
    rawUnit.includes("ExecStart=lifeline restore"),
    `Expected installed unit file to keep canonical restore entrypoint.
${rawUnit}`,
  );

  const dryRunUninstall = await backend.uninstall({
    scope: "machine-local",
    restoreEntrypoint: "lifeline restore",
    dryRun: true,
  });
  assert(
    dryRunUninstall.detail.includes(
      "user unit lifeline-restore.service is not present",
    ) ||
      dryRunUninstall.detail.includes(
        "would disable user unit lifeline-restore.service",
      ),
    `Expected dry-run uninstall detail to describe deterministic removal intent, got: ${dryRunUninstall.detail}`,
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

  const invokedCommands = invoked.map((command) => command.join(" "));
  assert(
    invokedCommands.includes("--user daemon-reload") &&
      invokedCommands.includes("--user enable --now lifeline-restore.service"),
    `Expected install path to run daemon-reload and enable --now.
commands:
${invokedCommands.join("\n")}`,
  );
  assert(
    invokedCommands.includes("--user disable --now lifeline-restore.service"),
    `Expected uninstall path to run disable --now.
commands:
${invokedCommands.join("\n")}`,
  );
}

async function main() {
  await verifyRestoreEntrypointWiring();
  await verifyContractSurfaceWiring();
  await verifySeamInstallDisableStatusAndDryRun();
  await verifyBackendResolutionCoverageAndFallback();
  await verifyFreebsdRcDBackendDeterministicBehavior();
  await verifyAixInittabBackendDeterministicBehavior();
  await verifyLaunchdBackendDeterministicBehavior();
  await verifySystemdBackendDeterministicBehavior();
  console.log("Wave 2 startup deterministic verification passed.");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Wave 2 startup deterministic verification failed: ${message}`);
  process.exitCode = 1;
});
