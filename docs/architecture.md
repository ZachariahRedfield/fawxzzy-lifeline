# Architecture

Lifeline uses a simple four-part architecture.

## 1. Manifest contract

The manifest contract is the source of truth for how a Lifeline-managed app should be described. It captures repo location, branch, commands, port, healthcheck, environment expectations, deployment strategy, and runtime restart/restore policy.

Manifest validation can stay structural in manifest-only mode. When a Playbook path is provided, Lifeline resolves a final config first and validates the resolved result instead.

## 2. Optional Playbook export surface

Playbook is one repo with two roles:

- a human-facing local UI/workflow for operators
- a machine-readable Lifeline export surface at `<playbook-path>/exports/lifeline/`

Lifeline only consumes Playbook export files from disk. There are no HTTP calls, no requirement that the Playbook UI be running, and no runtime dependency on an external service.

## 3. CLI operator

The CLI is the operator-facing entrypoint. Current commands:

- `validate`
- `resolve`
- `up`
- `down`
- `status`
- `logs`
- `restart`
- `restore`
- `startup` (contract-only in Wave 2)

`up` resolves config and runs install/build, then launches a detached Lifeline supervisor process (not the app process directly).

## 4. Local runtime layer + startup contract surface (Wave 1 + merged Wave 2)

Runtime behavior:

- one supervisor process per app
- supervisor owns and monitors the child app process
- restart policy support: `runtime.restartPolicy` (`on-failure` or `never`)
- bounded restart backoff with crash-loop cutoff
- persisted runtime metadata in `.lifeline/state.json` (supervisor pid, child pid, restart counters, last exit)
- `restore` reads persisted state and re-launches restorable supervisors idempotently
- startup contract is configured via `startup`, with canonical restore wiring to `lifeline restore` (contract-only mechanism until OS installers are added)
- cross-platform stop behavior: `taskkill /T /F` on Windows, process-group termination on POSIX

Logs remain file-based at `.lifeline/logs/<app>.log` and include both app output and supervisor lifecycle events.

## Startup backend boundary

The merged Wave 2 contract provides startup intent/state and deterministic planning/status now. OS-specific installers (Task Scheduler/systemd/launchd) remain deferred and must be implemented behind this contract seam without bypassing the `lifeline restore` entrypoint.
