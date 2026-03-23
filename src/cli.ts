#!/usr/bin/env node
import { runValidateCommand } from "./commands/validate.js";

function printUsage(): void {
  console.log(`Lifeline v1\n\nUsage:\n  lifeline validate <manifest-path>`);
}

async function main(argv: string[]): Promise<number> {
  const [command, manifestPath] = argv;

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return 0;
  }

  if (command !== "validate") {
    console.error(`Unknown command: ${command}`);
    printUsage();
    return 1;
  }

  if (!manifestPath) {
    console.error("Missing manifest path.");
    printUsage();
    return 1;
  }

  return runValidateCommand(manifestPath);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Unexpected error: ${message}`);
    process.exitCode = 1;
  });
