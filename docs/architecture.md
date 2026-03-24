# Architecture

Lifeline uses a simple four-part architecture.

## 1. Manifest contract

The manifest contract is the source of truth for how a Lifeline-managed app should be described. It captures repo location, branch, commands, port, healthcheck, environment expectations, and deployment strategy.

Manifest validation can stay structural in manifest-only mode. When a Playbook path is provided, Lifeline resolves a final config first and validates the resolved result instead.

## 2. Optional Playbook export surface

Playbook is one repo with two roles:

- a human-facing local UI/workflow for operators
- a machine-readable Lifeline export surface at `<playbook-path>/exports/lifeline/`

Lifeline only consumes Playbook export files from disk. There are no HTTP calls, no requirement that the Playbook UI be running, and no runtime dependency on an external service.

The current export loader reads:

- `schema-version.json`
- `archetypes/next-web.yml`
- `archetypes/node-web.yml`

`schema-version.json` accepts the checked-in Playbook shape `{ "schemaVersion": <number|string>, "exportFamily": "lifeline-archetypes" }` and keeps legacy compatibility for `exportFamily: "lifeline"` and for `{ "version": <number> }`. Lifeline normalizes accepted export-family values at the boundary to `lifeline-archetypes` before continuing resolution.

Failure handling is intentionally explicit:

- missing export directory
- missing schema version file
- missing `schemaVersion`/`version`
- wrong `exportFamily` when present
- unsupported schema version
- missing requested archetype file

All of these fail clearly before execution.

## 3. CLI operator

The CLI is the operator-facing entrypoint. In the current v1 slice it implements:

- `validate`: parse YAML and validate either the raw manifest or the resolved config
- `resolve`: print the final config that Lifeline will execute
- `up`: resolve config, prepare env, run install/build, start the app, persist state, and perform a health check
- `status`: recompute process liveness and health instead of trusting stale state blindly
- `logs`: print a boring tail of the stored app log file
- `down`: stop the process cleanly and remove runtime state
- `restart`: stop the app and rerun the full lifecycle from the stored manifest path and stored Playbook path when applicable

The CLI remains intentionally human-readable and narrow.

## 4. Local runtime layer

The runtime layer is still intentionally small:

- `resolve-config` merges optional Playbook defaults with explicit manifest values
- merge precedence is fixed: Playbook defaults first, manifest values second
- only known top-level fields plus `env` and `deploy` are merged
- Playbook archetype exports may omit `env` defaults; manifest `env` values are then used directly
- validation targets the final resolved config, not optional producer sections in isolation
- `deploy.workingDirectory` identifies the local app checkout to operate on
- env-file parsing is in-repo and minimal (`KEY=VALUE`, comments, blank lines)
- `child_process.spawn` runs install/build as foreground steps and start as a detached background process
- `.lifeline/state.json` stores explicit runtime state keyed by app name, including `playbookPath` when used
- `.lifeline/logs/<app-name>.log` stores appended stdout/stderr logs
- health checks poll `http://127.0.0.1:<port><healthcheckPath>` for up to about 30 seconds
- stop behavior is cross-platform: `taskkill` on Windows, process-group termination on POSIX where available

## Fixture-driven verification

Lifeline verifies runtime behavior with in-repo fixtures instead of real external apps. That keeps CI deterministic, avoids maintenance drag, and ensures the operator stays grounded in the shared contract rather than app-specific logic.

The repository now has two complementary smoke paths:

- manifest-only runtime verification with `fixtures/runtime-smoke-app/`
- Playbook-backed resolution verification with `fixtures/playbook-export/` plus a slimmer manifest fixture
