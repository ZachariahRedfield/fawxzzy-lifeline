import path from "node:path";

import { ensureBuilt } from "./lib/ensure-built.mjs";

await ensureBuilt();

const { resolvePlaybookPath } = await import("../dist/core/load-playbook-exports.js");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const originalEnv = process.env.LIFELINE_PLAYBOOK_PATH;

try {
  process.env.LIFELINE_PLAYBOOK_PATH = "./from-env";

  const explicitResolution = await resolvePlaybookPath("./from-explicit");
  assert(
    explicitResolution === path.resolve("./from-explicit"),
    `expected explicit path to win over env var, received ${explicitResolution}`,
  );

  const envResolution = await resolvePlaybookPath(undefined);
  assert(
    envResolution === path.resolve("./from-env"),
    `expected env var path to be used when explicit path is absent, received ${envResolution}`,
  );

  assert(path.isAbsolute(envResolution), `expected resolved env path to be absolute, received ${envResolution}`);
  assert(path.isAbsolute(explicitResolution), `expected resolved explicit path to be absolute, received ${explicitResolution}`);

  delete process.env.LIFELINE_PLAYBOOK_PATH;
  const noPathResolution = await resolvePlaybookPath(undefined);
  assert(noPathResolution === undefined, `expected undefined with no explicit/env path, received ${noPathResolution}`);

  console.log("resolvePlaybookPath deterministic precedence verification passed.");
} finally {
  if (originalEnv === undefined) {
    delete process.env.LIFELINE_PLAYBOOK_PATH;
  } else {
    process.env.LIFELINE_PLAYBOOK_PATH = originalEnv;
  }
}
