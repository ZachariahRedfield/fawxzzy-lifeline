import { spawn } from "node:child_process";
import process from "node:process";

const cli = ["node", "dist/cli.js"];
const playbookPath = "fixtures/playbook-export";
const manifestPath =
  "fixtures/runtime-smoke-app/runtime-smoke-app.playbook.lifeline.yml";
const appName = "runtime-smoke-app";

function run(args, { allowFailure = false, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli[0], [...cli.slice(1), ...args], {
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

try {
  await cleanup();

  const resolveOutput = await run([
    "resolve",
    manifestPath,
    "--playbook-path",
    playbookPath,
  ]);
  if (!resolveOutput.stdout.includes('"installCommand": "node -e')) {
    throw new Error(
      `Expected resolved defaults in output, got:\n${resolveOutput.stdout}\n${resolveOutput.stderr}`,
    );
  }

  await run(["validate", manifestPath, "--playbook-path", playbookPath]);
  await run(["up", manifestPath, "--playbook-path", playbookPath]);

  const status = await run(["status", appName]);
  if (!status.stdout.includes("is running")) {
    throw new Error(
      `Expected running status, got:\n${status.stdout}\n${status.stderr}`,
    );
  }

  await run(["restart", appName]);

  const envResolve = await run(["resolve", manifestPath], {
    env: {
      ...process.env,
      LIFELINE_PLAYBOOK_PATH: playbookPath,
    },
  });
  if (!envResolve.stdout.includes('"healthcheckPath": "/healthz"')) {
    throw new Error(
      `Expected env fallback resolution output, got:\n${envResolve.stdout}\n${envResolve.stderr}`,
    );
  }

  await run(["down", appName]);
} catch (error) {
  await cleanup();
  throw error;
}
