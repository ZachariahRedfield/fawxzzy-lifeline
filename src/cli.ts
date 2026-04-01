#!/usr/bin/env node
import { runDownCommand } from "./commands/down.js";
import { runLogsCommand } from "./commands/logs.js";
import { runResolveCommand } from "./commands/resolve.js";
import { runRestartCommand } from "./commands/restart.js";
import { runRestoreCommand } from "./commands/restore.js";
import {
  runStartupDisableCommand,
  runStartupEnableCommand,
  runStartupStatusCommand,
} from "./commands/startup.js";
import { runStatusCommand } from "./commands/status.js";
import { runUpCommand } from "./commands/up.js";
import { runValidateCommand } from "./commands/validate.js";
import { LifelineError } from "./core/errors.js";
import { runSupervisor } from "./core/supervisor.js";

function printUsage(): void {
  console.log(
    "Lifeline v1\n\nUsage:\n  lifeline validate <manifest-path> [--playbook-path <path>]\n  lifeline resolve <manifest-path> [--playbook-path <path>]\n  lifeline up <manifest-path> [--playbook-path <path>]\n  lifeline down <app-name>\n  lifeline status <app-name>\n  lifeline logs <app-name> [line-count]\n  lifeline restart <app-name> [--playbook-path <path>]\n  lifeline restore\n  lifeline startup <enable|disable|status> [--dry-run]",
  );
}

function parseStartupOptions(args: string[]): {
  action?: string | undefined;
  dryRun: boolean;
} {
  const positional: string[] = [];
  let dryRun = false;

  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    positional.push(arg);
  }

  return { action: positional[0], dryRun };
}

function parsePlaybookOption(args: string[]): {
  target?: string | undefined;
  option?: string | undefined;
  playbookPath?: string | undefined;
} {
  const positional: string[] = [];
  let playbookPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }

    if (arg === "--playbook-path") {
      const nextArg = args[index + 1];
      if (!nextArg) {
        throw new LifelineError(
          "Missing value for --playbook-path.",
          "CLI_ARGUMENT_ERROR",
        );
      }
      playbookPath = nextArg;
      index += 1;
      continue;
    }
    positional.push(arg);
  }

  return {
    target: positional[0],
    option: positional[1],
    ...(playbookPath ? { playbookPath } : {}),
  };
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { target, option, playbookPath } = parsePlaybookOption(rest);

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return 0;
  }

  switch (command) {
    case "validate":
      if (!target) {
        console.error("Missing manifest path.");
        printUsage();
        return 1;
      }
      return runValidateCommand(target, playbookPath);
    case "resolve":
      if (!target) {
        console.error("Missing manifest path.");
        printUsage();
        return 1;
      }
      return runResolveCommand(target, playbookPath);
    case "up":
      if (!target) {
        console.error("Missing manifest path.");
        printUsage();
        return 1;
      }
      return runUpCommand(target, playbookPath);
    case "down":
      if (!target) {
        console.error("Missing app name.");
        printUsage();
        return 1;
      }
      return runDownCommand(target);
    case "status":
      if (!target) {
        console.error("Missing app name.");
        printUsage();
        return 1;
      }
      return runStatusCommand(target);
    case "logs": {
      if (!target) {
        console.error("Missing app name.");
        printUsage();
        return 1;
      }
      const parsedLineCount = option ? Number(option) : 100;
      if (!Number.isInteger(parsedLineCount) || parsedLineCount < 1) {
        console.error(`Invalid line count: ${option}`);
        return 1;
      }
      return runLogsCommand(target, parsedLineCount);
    }
    case "restart":
      if (!target) {
        console.error("Missing app name.");
        printUsage();
        return 1;
      }
      return runRestartCommand(target, playbookPath);
    case "restore":
      return runRestoreCommand();
    case "startup": {
      const startup = parseStartupOptions(rest);
      if (!startup.action) {
        console.error(
          "Missing startup action. Use enable, disable, or status.",
        );
        printUsage();
        return 1;
      }

      if (startup.action === "enable") {
        return runStartupEnableCommand({ dryRun: startup.dryRun });
      }
      if (startup.action === "disable") {
        return runStartupDisableCommand({ dryRun: startup.dryRun });
      }
      if (startup.action === "status") {
        return runStartupStatusCommand();
      }

      console.error(`Unknown startup action: ${startup.action}`);
      printUsage();
      return 1;
    }
    case "supervise":
      if (!target) {
        console.error("Missing app name.");
        return 1;
      }
      return runSupervisor(target);
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof LifelineError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`Unexpected error: ${message}`);
    process.exitCode = 1;
  });
