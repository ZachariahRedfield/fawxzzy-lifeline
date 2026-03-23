#!/usr/bin/env node
import { runDownCommand } from "./commands/down.js";
import { runLogsCommand } from "./commands/logs.js";
import { runRestartCommand } from "./commands/restart.js";
import { runStatusCommand } from "./commands/status.js";
import { runUpCommand } from "./commands/up.js";
import { runValidateCommand } from "./commands/validate.js";
import { LifelineError } from "./core/errors.js";

function printUsage(): void {
  console.log(`Lifeline v1\n\nUsage:\n  lifeline validate <manifest-path>\n  lifeline up <manifest-path>\n  lifeline down <app-name>\n  lifeline status <app-name>\n  lifeline logs <app-name> [line-count]\n  lifeline restart <app-name>`);
}

async function main(argv: string[]): Promise<number> {
  const [command, target, option] = argv;

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
      return runValidateCommand(target);
    case "up":
      if (!target) {
        console.error("Missing manifest path.");
        printUsage();
        return 1;
      }
      return runUpCommand(target);
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
      return runRestartCommand(target);
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
