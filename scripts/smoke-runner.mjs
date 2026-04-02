import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const scriptsDir = new URL("./", import.meta.url);
const smokePrefix = "smoke-";
const smokeSuffix = ".mjs";

function parseSmokeScript(fileName) {
  if (!fileName.startsWith(smokePrefix) || !fileName.endsWith(smokeSuffix)) {
    return undefined;
  }

  const stem = fileName.slice(smokePrefix.length, -smokeSuffix.length);
  const firstDash = stem.indexOf("-");
  if (firstDash === -1) {
    return undefined;
  }

  const mode = stem.slice(0, firstDash);
  const scenario = stem.slice(firstDash + 1);
  if (!mode || !scenario) {
    return undefined;
  }

  return {
    fileName,
    mode,
    scenario,
    fullScenario: `${mode}-${scenario}`,
  };
}

function printUsage(availableModes) {
  const modes = availableModes.length > 0 ? availableModes.join(", ") : "none";
  console.error("Usage: node scripts/smoke-runner.mjs <mode> <scenario>");
  console.error("Example: node scripts/smoke-runner.mjs runtime restore-invalid-manifest-shape");
  console.error(`Available modes: ${modes}`);
}

function runScript(fileName) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [path.join("scripts", fileName)], {
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Smoke script terminated by signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

const files = await readdir(scriptsDir);
const scripts = files.map(parseSmokeScript).filter(Boolean);
const modes = [...new Set(scripts.map((entry) => entry.mode))].sort();

const [, , modeArg, scenarioArg] = process.argv;

if (!modeArg || !scenarioArg) {
  printUsage(modes);
  process.exit(1);
}

const modeScripts = scripts.filter((entry) => entry.mode === modeArg).sort((a, b) =>
  a.fileName.localeCompare(b.fileName),
);

if (modeScripts.length === 0) {
  console.error(`Unknown smoke mode: ${modeArg}`);
  printUsage(modes);
  process.exit(1);
}

const normalizedScenario = scenarioArg
  .replace(new RegExp(`^${modeArg}-`), "")
  .replace(new RegExp(`^${modeArg}:`), "");

const exactMatch = modeScripts.find((entry) => entry.scenario === normalizedScenario);
if (exactMatch) {
  const exitCode = await runScript(exactMatch.fileName);
  process.exit(exitCode);
}

const suffixMatches = modeScripts.filter((entry) => entry.scenario.endsWith(`-${normalizedScenario}`));
if (suffixMatches.length === 1) {
  const exitCode = await runScript(suffixMatches[0].fileName);
  process.exit(exitCode);
}

if (suffixMatches.length > 1) {
  console.error(
    `Ambiguous scenario selector \"${scenarioArg}\" for mode \"${modeArg}\". Matches: ${suffixMatches
      .map((entry) => entry.scenario)
      .join(", ")}`,
  );
  process.exit(2);
}

console.error(`Unknown scenario \"${scenarioArg}\" for mode \"${modeArg}\".`);
console.error(
  `Known scenarios for ${modeArg}: ${modeScripts.map((entry) => entry.scenario).join(", ")}`,
);
process.exit(1);
