import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const errorsModuleUrl = pathToFileURL(
  fileURLToPath(new URL("../dist/core/errors.js", import.meta.url)),
);

const {
  LifelineError,
  ManifestLoadError,
  ValidationError,
  RuntimeStateError,
  ProcessManagerError,
} = await import(errorsModuleUrl.href);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const base = new LifelineError("base failure");
assert(base instanceof Error, "LifelineError should extend Error.");
assert(base.name === "LifelineError", `Expected LifelineError name, received ${base.name}.`);
assert(base.code === "LIFELINE_ERROR", `Expected default LifelineError code, received ${base.code}.`);
assert(base.message === "base failure", "LifelineError should preserve message text.");

const contractCases = [
  {
    label: "ManifestLoadError",
    instance: new ManifestLoadError("manifest failed"),
    expectedName: "ManifestLoadError",
    expectedCode: "MANIFEST_LOAD_ERROR",
  },
  {
    label: "ValidationError",
    instance: new ValidationError("validation failed"),
    expectedName: "ValidationError",
    expectedCode: "VALIDATION_ERROR",
  },
  {
    label: "RuntimeStateError",
    instance: new RuntimeStateError("runtime state failed"),
    expectedName: "RuntimeStateError",
    expectedCode: "RUNTIME_STATE_ERROR",
  },
  {
    label: "ProcessManagerError",
    instance: new ProcessManagerError("process manager failed"),
    expectedName: "ProcessManagerError",
    expectedCode: "PROCESS_MANAGER_ERROR",
  },
];

for (const testCase of contractCases) {
  assert(testCase.instance instanceof LifelineError, `${testCase.label} should extend LifelineError.`);
  assert(testCase.instance instanceof Error, `${testCase.label} should extend Error.`);
  assert(
    testCase.instance.name === testCase.expectedName,
    `${testCase.label} name mismatch. Expected ${testCase.expectedName}, received ${testCase.instance.name}.`,
  );
  assert(
    testCase.instance.code === testCase.expectedCode,
    `${testCase.label} code mismatch. Expected ${testCase.expectedCode}, received ${testCase.instance.code}.`,
  );
}

console.log("Error class contract deterministic verification passed.");
