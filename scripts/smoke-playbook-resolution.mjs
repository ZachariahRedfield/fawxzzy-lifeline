import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const packageManagerExecutable = process.platform === "win32"
  ? "pnpm.cmd"
  : "pnpm";
const packageManagerArgs = ["lifeline"];
const fixturePlaybookPath = "fixtures/playbook-export";
const manifestPath =
  "fixtures/runtime-smoke-app/runtime-smoke-app.playbook.lifeline.yml";
const appName = "runtime-smoke-app";

function run(args, { allowFailure = false, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(packageManagerExecutable, [...packageManagerArgs, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && !allowFailure) {
        reject(
          new Error(
            `Command failed: ${args.join(" ")}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function cleanup() {
  await run(["down", appName], { allowFailure: true });
}

async function withTemporaryPlaybook(mutateSchemaVersionJson, validateError) {
  const tempRoot = await mkdtemp(
    path.join(tmpdir(), "lifeline-playbook-smoke-"),
  );
  try {
    const tempPlaybookPath = path.join(tempRoot, "playbook-export");
    await cp(fixturePlaybookPath, tempPlaybookPath, { recursive: true });

    const schemaVersionPath = path.join(
      tempPlaybookPath,
      "exports",
      "lifeline",
      "schema-version.json",
    );
    await writeFile(
      schemaVersionPath,
      JSON.stringify(mutateSchemaVersionJson, null, 2),
      "utf8",
    );

    const result = await run(
      ["resolve", manifestPath, "--playbook-path", tempPlaybookPath],
      { allowFailure: true },
    );
    validateError(result);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function withTemporaryArchetype(mutateArchetypeYaml, validateError) {
  const tempRoot = await mkdtemp(
    path.join(tmpdir(), "lifeline-playbook-smoke-archetype-"),
  );
  try {
    const tempPlaybookPath = path.join(tempRoot, "playbook-export");
    await cp(fixturePlaybookPath, tempPlaybookPath, { recursive: true });

    const archetypePath = path.join(
      tempPlaybookPath,
      "exports",
      "lifeline",
      "archetypes",
      "node-web.yml",
    );
    await writeFile(archetypePath, mutateArchetypeYaml, "utf8");

    const result = await run(
      ["resolve", manifestPath, "--playbook-path", tempPlaybookPath],
      { allowFailure: true },
    );
    validateError(result);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function parseManifestPort(manifestRaw) {
  const match = manifestRaw.match(/^port:\s*(\d+)\s*$/m);
  if (!match) {
    throw new Error(`Expected fixture manifest to include explicit port: ${manifestPath}`);
  }
  return Number(match[1]);
}

try {
  await cleanup();

  const manifestRaw = await readFile(manifestPath, "utf8");
  const expectedManifestPort = parseManifestPort(manifestRaw);

  const resolveOutput = await run([
    "resolve",
    manifestPath,
    "--playbook-path",
    fixturePlaybookPath,
  ]);
  if (!resolveOutput.stdout.includes('"installCommand": "node -e')) {
    throw new Error(
      `Expected resolved defaults in output, got:\n${resolveOutput.stdout}\n${resolveOutput.stderr}`,
    );
  }
  if (!resolveOutput.stdout.includes('"requiredKeys": []')) {
    throw new Error(
      `Expected missing manifest env requirements to normalize to an empty list in resolved output, got:\n${resolveOutput.stdout}\n${resolveOutput.stderr}`,
    );
  }
  if (!resolveOutput.stdout.includes('"workingDirectory": "."')) {
    throw new Error(
      `Expected manifest deploy workingDirectory to remain in resolved output when archetype omits deploy defaults, got:\n${resolveOutput.stdout}\n${resolveOutput.stderr}`,
    );
  }
  if (!resolveOutput.stdout.includes(`"port": ${expectedManifestPort}`)) {
    throw new Error(
      `Expected resolved config to keep explicit manifest port (${expectedManifestPort}) when archetype omits port defaults, got:\n${resolveOutput.stdout}\n${resolveOutput.stderr}`,
    );
  }

  await run(["validate", manifestPath, "--playbook-path", fixturePlaybookPath]);

  const envResolve = await run(["resolve", manifestPath], {
    env: {
      ...process.env,
      LIFELINE_PLAYBOOK_PATH: fixturePlaybookPath,
    },
  });
  if (!envResolve.stdout.includes('"healthcheckPath": "/healthz"')) {
    throw new Error(
      `Expected env fallback resolution output, got:\n${envResolve.stdout}\n${envResolve.stderr}`,
    );
  }

  await withTemporaryPlaybook(
    { schemaVersion: "1", exportFamily: "lifeline-archetypes" },
    (result) => {
      if (result.code !== 0) {
        throw new Error(
          `Expected schemaVersion as numeric string to be accepted, got:\n${result.stdout}\n${result.stderr}`,
        );
      }
    },
  );

  await withTemporaryPlaybook(
    { schemaVersion: 1, exportFamily: "lifeline" },
    (result) => {
      if (result.code !== 0) {
        throw new Error(
          `Expected legacy exportFamily compatibility to be accepted, got:\n${result.stdout}\n${result.stderr}`,
        );
      }
    },
  );

  await withTemporaryPlaybook(
    { schemaVersion: 1, exportFamily: "playbook" },
    (result) => {
      if (
        result.code === 0 ||
        !result.stderr.includes("Unsupported Playbook export family")
      ) {
        throw new Error(
          `Expected wrong exportFamily to fail clearly, got:\n${result.stdout}\n${result.stderr}`,
        );
      }
    },
  );

  await withTemporaryPlaybook(
    { exportFamily: "lifeline-archetypes" },
    (result) => {
      if (result.code === 0 || !result.stderr.includes("schemaVersion")) {
        throw new Error(
          `Expected missing schema version to fail clearly, got:\n${result.stdout}\n${result.stderr}`,
        );
      }
    },
  );

  await withTemporaryArchetype(`installCommand: 42\n`, (result) => {
    if (
      result.code === 0 ||
      !result.stderr.includes("Playbook export shape is invalid")
    ) {
      throw new Error(
        `Expected invalid Playbook export shape to fail clearly, got:\n${result.stdout}\n${result.stderr}`,
      );
    }
  });

  await withTemporaryArchetype(
    [
      `installCommand: node -e "console.log('install ok')"`,
      `buildCommand: node -e "console.log('build ok')"`,
    ].join("\n"),
    (result) => {
      if (
        result.code === 0 ||
        !result.stderr.includes("Resolved config is incomplete or invalid")
      ) {
        throw new Error(
          `Expected incomplete resolved config to fail clearly, got:\n${result.stdout}\n${result.stderr}`,
        );
      }
    },
  );

} catch (error) {
  await cleanup();
  throw error;
}
