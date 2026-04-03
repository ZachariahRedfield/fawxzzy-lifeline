import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const suitesFile = new URL("./test-suites.json", import.meta.url);

function usage(suites) {
  const available = [...suites, "all"].join(", ");
  console.error("Usage: node scripts/test-runner.mjs <suite|all|list>");
  console.error(`Known suites: ${available}`);
}

function runScript(fileName) {
  return new Promise((resolve) => {
    const child = spawn("node", [path.join("scripts", fileName)], {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", (error) => {
      console.error(`Failed to launch ${fileName}: ${error.message}`);
      resolve(1);
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        console.error(`Script ${fileName} terminated by signal ${signal}`);
        resolve(1);
        return;
      }

      resolve(code ?? 1);
    });
  });
}

async function loadSuites() {
  const content = await readFile(suitesFile, "utf8");
  const registry = JSON.parse(content);

  for (const [suiteName, scripts] of Object.entries(registry)) {
    if (!Array.isArray(scripts) || scripts.some((script) => typeof script !== "string")) {
      throw new Error(`Invalid suite entry for "${suiteName}" in scripts/test-suites.json`);
    }
  }

  return registry;
}

async function runSuite(suiteName, scripts) {
  let failures = 0;
  let lastCode = 0;

  console.log(`\n==> suite:${suiteName} (${scripts.length} script${scripts.length === 1 ? "" : "s"})`);

  for (const fileName of scripts) {
    console.log(`\n--> ${fileName}`);
    const code = await runScript(fileName);
    if (code !== 0) {
      failures += 1;
      lastCode = code;
      console.error(`✖ ${fileName} failed with exit code ${code}`);
    }
  }

  if (failures > 0) {
    console.error(`\nSuite "${suiteName}" completed with ${failures} failure(s).`);
    return lastCode || 1;
  }

  console.log(`\nSuite "${suiteName}" passed.`);
  return 0;
}

const suites = await loadSuites();
const suiteNames = Object.keys(suites);
const [, , command] = process.argv;

if (!command) {
  usage(suiteNames);
  process.exit(1);
}

if (command === "list") {
  console.log(suiteNames.join("\n"));
  process.exit(0);
}

if (command !== "all" && !suites[command]) {
  console.error(`Unknown suite "${command}".`);
  usage(suiteNames);
  process.exit(1);
}

const suitesToRun = command === "all" ? suiteNames : [command];

let totalFailures = 0;
let finalExitCode = 0;
for (const suiteName of suitesToRun) {
  const code = await runSuite(suiteName, suites[suiteName]);
  if (code !== 0) {
    totalFailures += 1;
    finalExitCode = code;
  }
}

if (totalFailures > 0) {
  console.error(`\n${totalFailures} suite(s) failed.`);
  process.exit(finalExitCode || 1);
}

console.log("\nAll requested suites passed.");
