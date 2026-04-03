import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDir = new URL("./", import.meta.url);
const suitesPath = new URL("./smoke-suites.json", import.meta.url);
const smokePrefix = "smoke-";
const smokeSuffix = ".mjs";

async function loadSuites() {
  const raw = await readFile(suitesPath, "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Smoke suites must be a JSON object mapping suite names to arrays.");
  }

  const suites = Object.entries(parsed);
  for (const [suiteName, scenarios] of suites) {
    if (!Array.isArray(scenarios) || scenarios.length === 0) {
      throw new Error(`Smoke suite "${suiteName}" must be a non-empty array.`);
    }
    if (scenarios.some((entry) => typeof entry !== "string" || entry.length === 0)) {
      throw new Error(`Smoke suite "${suiteName}" contains an invalid scenario entry.`);
    }
  }

  return parsed;
}

function printUsage(suiteNames) {
  console.error("Usage: node scripts/smoke-suite-runner.mjs <suite|all|list>");
  console.error(`Known suites: ${suiteNames.join(", ") || "none"}`);
}

function runSmokeScript(scenarioName) {
  const fileName = `${smokePrefix}${scenarioName}${smokeSuffix}`;
  const filePath = path.join(fileURLToPath(scriptsDir), fileName);

  return new Promise((resolve, reject) => {
    const child = spawn("node", [filePath], {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve({ code: 1, signal });
        return;
      }
      resolve({ code: code ?? 1, signal: undefined });
    });
  });
}

async function runSuite(suiteName, scenarios) {
  console.log(`Running smoke suite "${suiteName}" (${scenarios.length} scenarios)...`);
  for (const scenario of scenarios) {
    console.log(`→ ${scenario}`);
    const result = await runSmokeScript(scenario);
    if (result.signal) {
      console.error(`Smoke scenario "${scenario}" terminated by signal ${result.signal}.`);
      process.exit(result.code);
    }
    if (result.code !== 0) {
      process.exit(result.code);
    }
  }
}

const suites = await loadSuites();
const suiteNames = Object.keys(suites);
const [, , suiteArg] = process.argv;

if (!suiteArg) {
  printUsage(suiteNames);
  process.exit(1);
}

if (suiteArg === "list") {
  for (const suiteName of suiteNames) {
    console.log(suiteName);
  }
  process.exit(0);
}

if (suiteArg === "all") {
  for (const suiteName of suiteNames) {
    await runSuite(suiteName, suites[suiteName]);
  }
  process.exit(0);
}

const suiteScenarios = suites[suiteArg];
if (!suiteScenarios) {
  console.error(`Unknown smoke suite: ${suiteArg}`);
  printUsage(suiteNames);
  process.exit(1);
}

await runSuite(suiteArg, suiteScenarios);
