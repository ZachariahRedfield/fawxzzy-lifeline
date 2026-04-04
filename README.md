# Lifeline

Lifeline is the opinionated, self-hosted local operator for manifest-defined apps. This repository is intentionally narrow: Lifeline v1 validates manifests, resolves optional Playbook defaults from disk, runs one stable local or staging-style instance on one machine, and includes the merged Wave 2 startup contract surface for deterministic `lifeline restore` startup intent management.

## Why Lifeline exists

Lifeline provides a boring, low-maintenance way to describe how an app should be installed, built, started, stopped, checked, and inspected on a self-hosted machine. It is deliberately not a hot-reload workflow replacement and deliberately not a hosted platform clone.

## What Lifeline is

- A single-package TypeScript CLI for a manifest-defined local operator.
- A home for a small, explicit app manifest contract.
- A file-based config resolver that can optionally read Playbook archetype exports from a local checkout.
- A runtime slice that can `resolve`, `up`, `down`, `status`, `logs`, `restart`, `restore`, `startup`, and `validate` one app on one machine.
- Fixture-based smoke paths that verify manifest-only runtime behavior and Playbook-backed resolution without depending on an external Playbook repo.

## What Lifeline is not

- Not a cloud platform.
- Not a dashboard.
- Not an auth system.
- Not a database-backed control plane.
- Not a multi-node orchestrator.
- Not a hot reload replacement.
- Not repo clone/pull, webhook, proxy, or domain automation.
- Not coupled to a running Playbook process, service, or UI.

## Current v1 commands

```bash
pnpm install
pnpm build
pnpm lifeline validate examples/fitness-app.lifeline.yml
pnpm lifeline resolve fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml
pnpm lifeline resolve fixtures/runtime-smoke-app/runtime-smoke-app.playbook.lifeline.yml --playbook-path fixtures/playbook-export
pnpm lifeline validate fixtures/runtime-smoke-app/runtime-smoke-app.playbook.lifeline.yml --playbook-path fixtures/playbook-export
pnpm lifeline up fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml
pnpm lifeline up fixtures/runtime-smoke-app/runtime-smoke-app.playbook.lifeline.yml --playbook-path fixtures/playbook-export
pnpm lifeline status runtime-smoke-app
pnpm lifeline logs runtime-smoke-app
pnpm lifeline restart runtime-smoke-app
pnpm lifeline restore
pnpm lifeline startup status
pnpm lifeline startup enable
pnpm lifeline startup disable
pnpm lifeline down runtime-smoke-app
```

## Optional Playbook integration

Playbook is treated as one repo with two separate roles:

- a human-facing local UI/workflow for operators
- a machine-readable export surface for Lifeline at `<playbook-path>/exports/lifeline/`

Lifeline only consumes the checked-in export files from disk. It does not call a Playbook HTTP API, does not require Playbook to be running, and still works fully in manifest-only mode.

### Playbook path precedence

1. `--playbook-path <path>`
2. `LIFELINE_PLAYBOOK_PATH`
3. no Playbook path, which means manifest-only mode

If a Playbook path is supplied but invalid, Lifeline fails clearly before runtime execution.

### Playbook export metadata contract

Lifeline reads `<playbook-path>/exports/lifeline/schema-version.json` and accepts:

- canonical/current contract: `{ "schemaVersion": <number|string>, "exportFamily": "lifeline-archetypes" }`
- legacy compatibility: `{ "version": <number> }`

Behavior is explicit:

- `schemaVersion` takes precedence over `version` when both are present
- `exportFamily` accepts `lifeline-archetypes` (canonical) and `lifeline` (legacy compatibility), and Lifeline normalizes internally to `lifeline-archetypes`
- missing schema version fields fail clearly
- unsupported schema versions fail clearly

### Merge precedence

Resolution is intentionally small and explicit:

1. start from Playbook archetype defaults when a Playbook path is available
2. apply manifest values on top
3. explicit manifest values always win

Lifeline only merges known top-level manifest fields plus the nested `env`, `deploy`, and `runtime` sections. It does not perform arbitrary deep-merge magic.
Playbook archetype exports are sparse optional default bundles. They may omit any app-default field (`installCommand`, `buildCommand`, `startCommand`, `healthcheckPath`, `env`, `deploy`, `port`), and missing runtime requirements must then come from explicit manifest values.

## Validation and resolution behavior

- `lifeline validate <manifest>` validates the raw manifest structure only.
- `lifeline validate <manifest> --playbook-path <path>` validates the resolved config, so required runtime fields may come from Playbook defaults.
- Lifeline treats Playbook archetypes as optional default bundles and validates only fields that are present in those exports.
- Lifeline enforces runnable requirements only on the final resolved config after defaults+manifest merge.
- The runtime `port` requirement can come from either Playbook defaults or explicit manifest values.
- `lifeline resolve <manifest>` prints the fully resolved config that Lifeline would execute.
- `lifeline up` and `lifeline restart` use the same resolution path as `resolve`.
- If an app was started with Playbook defaults, Lifeline stores the resolved Playbook path in `.lifeline/state.json` so `restart` remains deterministic without retyping flags.

## Runtime behavior

`lifeline up <manifest-path>` performs the local runtime lifecycle:

- loads the manifest
- optionally loads Playbook archetype defaults from disk
- resolves config before validation and execution
- resolves `deploy.workingDirectory` relative to the manifest file
- loads `env.file` if present
- overlays `process.env` on top of env-file values
- normalizes missing `env.requiredKeys` to `[]`
- validates provided `env.requiredKeys` entries
- runs `installCommand`
- runs `buildCommand`
- starts a detached Lifeline supervisor for the app
- supervisor starts `startCommand`, watches exits, and restarts on failures with bounded backoff
- appends app output and supervisor lifecycle events to `.lifeline/logs/<app-name>.log`
- stores supervisor pid, wrapper child pid, and tracked listener pid/port ownership metadata in `.lifeline/state.json`
- polls `http://127.0.0.1:<port><healthcheckPath>` for a simple health check and reports blocked/unhealthy states when restart cannot reclaim the managed port
- `lifeline down` reclaims the real managed listener and waits for managed port release before reporting success
- supports `lifeline restore` to restart restorable apps from persisted state


## Startup registration contract (Wave 2)

Lifeline Wave 2 introduces a platform-neutral startup registration contract for machine-local auto-start of the `lifeline restore` flow.

Commands:

```bash
pnpm lifeline startup status
pnpm lifeline startup enable
pnpm lifeline startup disable
pnpm lifeline startup enable --dry-run
pnpm lifeline startup disable --dry-run
```

Current merged Wave 2 startup-contract behavior:

- `startup enable` calls backend seam `install` and persists intent to enabled in `.lifeline/startup.json`.
- `startup disable` calls backend seam `uninstall` and persists intent to disabled in `.lifeline/startup.json`.
- `startup status` reports scope, canonical restore entrypoint (`lifeline restore`), mechanism (`contract-only`), and backend readiness from seam inspection.
- `--dry-run` prints a startup action plan without mutating `.lifeline/startup.json` or performing backend install/uninstall writes.
- Default `win32` backend resolution now routes to the Windows Task Scheduler backend (`windows-task-scheduler`) rather than the generic unsupported seam fallback.
- `linux` and `darwin` currently fall back to the unsupported contract-only backend until platform installers land.

Deterministic status output shape:

```text
Startup supported: <yes|no>
Startup enabled: <yes|no>
Startup backend status: <installed|not-installed|unsupported>
- mechanism: contract-only
- scope: machine-local
- restore entrypoint: lifeline restore
- detail: <backend/status detail>
```

Windows backend behavior notes:

- On `win32`, backend status is sourced from the Task Scheduler seam, while startup status mechanism contract wording remains `contract-only` in docs parity surfaces.
- If Scheduler tooling is unavailable, backend status becomes `unsupported` with explicit detail (for example, `Windows Task Scheduler CLI is unavailable, so startup registration cannot be inspected.`).

Unsupported-platform detail must remain explicit (for example, `No startup installer backend is available on linux yet.`) so startup state is not tribal knowledge.

## Slim manifest example with Playbook defaults

This manifest is intentionally incomplete on its own, but becomes runnable when paired with a Playbook export for the `node-web` archetype:

```yaml
name: runtime-smoke-app
archetype: node-web
repo: local-fixture
branch: main
```

Run it with:

```bash
pnpm lifeline resolve fixtures/runtime-smoke-app/runtime-smoke-app.playbook.lifeline.yml \
  --playbook-path fixtures/playbook-export
```

## Runtime state and logs

Lifeline stores its local operator artifacts under `.lifeline/`:

- `.lifeline/state.json`: explicit runtime state keyed by app name, including stored manifest path, optional stored `playbookPath`, supervisor/child pids, restart metadata, and restore flags
- `.lifeline/logs/<app-name>.log`: appended stdout/stderr logs for the managed process

The directory is gitignored because it is machine-local runtime state, not source-controlled config.

## Fixture apps and smoke verification

The `fixtures/runtime-smoke-app/` app exists only to verify Lifeline's runtime slice end to end. The `fixtures/playbook-export/` tree mirrors the expected Playbook export layout so CI can verify Playbook-backed resolution without depending on the real external Playbook repo.

Run the smoke paths with:

```bash
node scripts/lib/ensure-built.mjs
pnpm smoke:runtime
pnpm smoke:playbook
pnpm test:startup-deterministic
pnpm test:startup-roundtrip
```

`node scripts/lib/ensure-built.mjs` is the canonical smoke preflight. It fails early with explicit setup errors (missing/stale `dist/cli.js`) so smoke failures that follow are runtime/regression signals.

CI uses the same canonical Playbook verification path: `pnpm smoke:playbook`.

### Smoke execution modes

For complete testing execution patterns (targeted vs grouped deterministic and smoke runs), see [docs/testing.md](docs/testing.md).

Use the smoke runners with distinct intent:

- **Single-scenario runs (`scripts/smoke-runner.mjs`)** are for debugging and targeted repro.
- **Suite runs (`scripts/smoke-suite-runner.mjs`)** are for grouped verification before merge/CI parity.

For targeted runtime smoke scenarios, prefer the deterministic single-scenario runner instead of adding new `package.json` script keys:

```bash
pnpm smoke:run runtime restore-invalid-manifest-shape
pnpm smoke:run runtime restart-invalid-playbook-export
```

The single-scenario runner resolves files by `scripts/smoke-<mode>-<scenario>.mjs` naming convention. New runtime smoke coverage should usually be added as a new `scripts/smoke-runtime-<scenario>.mjs` file only.

For grouped smoke verification, use the suite runner:

```bash
node scripts/smoke-suite-runner.mjs list
node scripts/smoke-suite-runner.mjs playbook
node scripts/smoke-suite-runner.mjs runtime
node scripts/smoke-suite-runner.mjs all
```

Available smoke suites are sourced from `scripts/smoke-suites.json`:

- `playbook`: Playbook-backed resolution verification suite.
- `runtime`: Runtime lifecycle and failure-path verification suite.

All smoke scripts invoke the canonical local Lifeline CLI entrypoint (`node dist/cli.js`) and therefore require `pnpm build` beforehand so `dist/cli.js` exists.

## Deterministic suite structure

Testing structure is documented in [`docs/testing.md`](docs/testing.md), with deterministic suites sourced from `scripts/test-suites.json` and executed via `scripts/test-runner.mjs`.

Smoke suites complement (not replace) deterministic test suites:

- Smoke suites (`scripts/smoke-suites.json` + `scripts/smoke-suite-runner.mjs`) group end-to-end CLI behavior checks.
- Deterministic test suites (`scripts/test-suites.json` + `scripts/test-runner.mjs`) group repeatable contract/test coverage.

### Smoke suite docs summary

- **Rule:** Grouped smoke execution should be discoverable from the repository, not tribal knowledge.
- **Pattern:** Use the single-scenario runner for debugging and the suite runner for grouped verification.
- **Failure Mode:** Without docs parity, suites exist but contributors keep relying on brittle one-off smoke commands.

### Directly-invoked helper script contract

- **Rule:** Any new directly-invokable helper script must be added to the deterministic invocation contract in the same PR.
- **Pattern:** Helper-script surface is explicit and fail-closed, not inferred loosely.
- **Failure Mode:** Adding helper scripts without updating invocation-boundary tests causes deterministic CI drift.

## CI toolchain install hardening

- **Rule:** CI test environments must install native optional toolchain packages required by transform-based test runners.
- **Pattern:** If TypeScript build passes but Vitest fails on `@esbuild/linux-x64`, treat it as install/bootstrap drift first.
- **Failure Mode:** Cross-platform cache reuse or optional-dependency suppression can produce false regressions across repos.

CI workflows in this repository enforce `NPM_CONFIG_OPTIONAL=true` and `PNPM_CONFIG_OPTIONAL=true`, run a frozen-lockfile install, and execute `pnpm ci:verify:esbuild` before test-like smoke/deterministic suites.

## Early target manifests

The fitness app and Playbook UI remain early Lifeline targets. Their manifests continue to document the shared contract shape, but actual runtime execution requires a valid local `deploy.workingDirectory` on the machine where Lifeline runs. Their application code does not live in this repository.

`examples/fitness-app.lifeline.yml` is a Lifeline-local mirror of the Fitness-owned manifest contract boundary. Keep its shape aligned to the external `.lifeline/fitness.lifeline.yml` fields Lifeline consumes, and do not independently evolve this mirror as a separate contract.

Rule: Mirrors must not be validated as canonical sources unless they fully satisfy the canonical contract.

Pattern: Separate canonical manifest validation from narrow local mirror validation.

Failure Mode: Partial mirrors routed through canonical validators create misleading missing-field failures.

## Minimal dependency policy

Lifeline keeps dependencies intentionally small:

- `typescript`: compile and typecheck the CLI.
- in-repo Node shims: enough type coverage to keep the standard-library operator code buildable during bootstrap.
- `@biomejs/biome`: one tool for formatting and linting.

YAML parsing and env-file parsing are implemented inside the repo because the contracts are small and stable.

## Project documents

- [Scope](docs/scope.md)
- [Architecture](docs/architecture.md)
- [Startup contract (Wave 2)](docs/startup-contract.md)
- [App manifest contract](docs/contracts/app-manifest.md)
- [ADR 0001: Lifeline v1 scope](docs/adr/0001-lifeline-v1-scope.md)



## Wave 2 startup registration operator workflow

Wave 2 adds OS startup registration as a machine-integration layer on top of the existing runtime and restore flow. Keep usage narrow and deterministic:

1. **Enable startup registration** so the OS invokes Lifeline restore on login/boot.
   ```bash
   pnpm lifeline startup enable
   ```
2. **Inspect startup status** to confirm registration target, identity, and restore entrypoint.
   ```bash
   pnpm lifeline startup status
   ```
3. **Disable startup registration** to cleanly remove machine-level wiring when you no longer want automatic restore.
   ```bash
   pnpm lifeline startup disable
   ```

Expected interaction with `restore` stays explicit: startup registration contract intent always targets the same restore entrypoint (`lifeline restore`) that operators run manually. Reboot simulation is optional; deterministic verification should focus on command planning, contract-state inspection, and restore-entrypoint wiring.

**Rule:** Machine-integration features need deterministic verification even when literal reboot simulation is impractical.

**Pattern:** Verify startup command planning, registration state inspection, and restore entrypoint wiring independently from real reboot execution.

**Failure Mode:** Startup ships with hand-wavy docs and no deterministic checks, so registration breaks silently and operators cannot trust it.

## Wave 1 notes

Wave 1 added a supervisor-backed lifecycle plus restore semantics. Wave 2 now includes a Windows Task Scheduler backend behind the startup contract seam, while additional platform installers remain deferred.
