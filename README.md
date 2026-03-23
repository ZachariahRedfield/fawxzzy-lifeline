# Lifeline

Lifeline is the opinionated, self-hosted local operator for manifest-defined apps. This repository is intentionally narrow: Lifeline v1 now validates manifests and runs one stable local or staging-style instance on one machine.

## Why Lifeline exists

Lifeline provides a boring, low-maintenance way to describe how an app should be installed, built, started, stopped, checked, and inspected on a self-hosted machine. It is deliberately not a hot-reload workflow replacement and deliberately not a hosted platform clone.

## What Lifeline is

- A single-package TypeScript CLI for a manifest-defined local operator.
- A home for a small, explicit app manifest contract.
- A runtime slice that can `up`, `down`, `status`, `logs`, `restart`, and `validate` one app on one machine.
- A fixture-based smoke path that verifies the runtime behavior end to end without depending on external apps.

## What Lifeline is not

- Not a cloud platform.
- Not a dashboard.
- Not an auth system.
- Not a database-backed control plane.
- Not a multi-node orchestrator.
- Not a hot reload replacement.
- Not repo clone/pull, webhook, proxy, or domain automation.

## Current v1 commands

```bash
pnpm install
pnpm build
pnpm lifeline validate examples/fitness-app.lifeline.yml
pnpm lifeline validate examples/playbook-ui.lifeline.yml
pnpm lifeline up fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml
pnpm lifeline status runtime-smoke-app
pnpm lifeline logs runtime-smoke-app
pnpm lifeline restart runtime-smoke-app
pnpm lifeline down runtime-smoke-app
```

## Runtime behavior

`lifeline up <manifest-path>` now performs the local runtime lifecycle:

- loads the manifest
- resolves `deploy.workingDirectory` relative to the manifest file
- loads `env.file` if present
- overlays `process.env` on top of env-file values
- validates `env.requiredKeys`
- runs `installCommand`
- runs `buildCommand`
- starts `startCommand` as a background process
- appends logs to `.lifeline/logs/<app-name>.log`
- stores runtime state in `.lifeline/state.json`
- polls `http://127.0.0.1:<port><healthcheckPath>` for a simple health check

## Why `workingDirectory` is required for runtime commands

Manifest validation stays structural. Runtime commands are stricter because they must operate against a real local checkout. That means `deploy.workingDirectory` must resolve on the current machine, and relative paths resolve from the manifest file location rather than from the shell's current working directory.

## Runtime state and logs

Lifeline stores its local operator artifacts under `.lifeline/`:

- `.lifeline/state.json`: explicit runtime state keyed by app name
- `.lifeline/logs/<app-name>.log`: appended stdout/stderr logs for the managed process

The directory is gitignored because it is machine-local runtime state, not source-controlled config.

## Fixture app and smoke verification

The `fixtures/runtime-smoke-app/` app exists only to verify Lifeline's runtime slice end to end. It is a tiny Node HTTP server with a `/healthz` endpoint and a matching manifest. This keeps CI deterministic and prevents runtime verification from depending on real external apps.

Run the smoke path with:

```bash
pnpm smoke:runtime
```

## Early target manifests

The fitness app and Playbook UI remain early Lifeline targets. Their manifests continue to document the shared contract shape, but actual runtime execution requires a valid local `deploy.workingDirectory` on the machine where Lifeline runs. Their application code does not live in this repository.

## Minimal dependency policy

Lifeline keeps dependencies intentionally small:

- `typescript`: compile and typecheck the CLI.
- in-repo Node shims: enough type coverage to keep the standard-library operator code buildable during bootstrap.
- `@biomejs/biome`: one tool for formatting and linting.

YAML parsing and env-file parsing are implemented inside the repo because the contracts are small and stable.

## Project documents

- [Scope](docs/scope.md)
- [Architecture](docs/architecture.md)
- [App manifest contract](docs/contracts/app-manifest.md)
- [ADR 0001: Lifeline v1 scope](docs/adr/0001-lifeline-v1-scope.md)
