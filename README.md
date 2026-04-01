# Lifeline

Lifeline is the opinionated, self-hosted local operator for manifest-defined apps. This repository is intentionally narrow: Lifeline v1 validates manifests, resolves optional Playbook defaults from disk, and runs one stable local or staging-style instance on one machine.

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

Lifeline only merges known top-level manifest fields plus the nested `env` and `deploy` sections. It does not perform arbitrary deep-merge magic.
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

Current Wave 2 slice behavior:

- `startup enable` records startup intent in `.lifeline/startup.json`.
- `startup disable` clears startup intent in `.lifeline/startup.json`.
- `startup status` reports scope, restore entrypoint, mechanism (`contract-only`), and backend readiness.
- `--dry-run` prints the planned startup action without changing state.
- OS-specific installer backends (Task Scheduler/systemd/launchd) are intentionally deferred and must plug in behind this contract.

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
pnpm smoke:runtime
pnpm smoke:playbook
pnpm test:startup-deterministic
```

CI uses the same canonical Playbook verification path: `pnpm smoke:playbook`.

All smoke scripts invoke the canonical local Lifeline CLI entrypoint (`node dist/cli.js`) and therefore require `pnpm build` beforehand so `dist/cli.js` exists.

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

Wave 1 added a supervisor-backed lifecycle plus restore semantics. Wave 2 currently adds a startup contract and CLI surface, with platform-specific installers deferred behind that seam.
