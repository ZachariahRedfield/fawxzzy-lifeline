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
- `startup <enable|disable|status>`

`up` resolves config and runs install/build, then launches a detached Lifeline supervisor process (not the app process directly).

## 4. Local runtime layer (Wave 1)

Wave 1 runtime behavior:

- one supervisor process per app
- supervisor owns and monitors the child app process
- restart policy support: `runtime.restartPolicy` (`on-failure` or `never`)
- bounded restart backoff with crash-loop cutoff
- persisted runtime metadata in `.lifeline/state.json` (supervisor pid, child pid, restart counters, last exit)
- `restore` reads persisted state and re-launches restorable supervisors idempotently
- `startup <enable|disable|status>` manages startup-registration contract state for machine-local auto-start of `lifeline restore`
- cross-platform stop behavior: `taskkill /T /F` on Windows, process-group termination on POSIX

Logs remain file-based at `.lifeline/logs/<app>.log` and include both app output and supervisor lifecycle events.

## Wave boundary

Wave 1 intentionally does **not** add OS startup registration installers (systemd/NSSM/Task Scheduler/etc).

Wave 2 now defines a startup registration contract (`enable`, `disable`, `status`) for machine-local auto-start of `lifeline restore`, while keeping platform installer backends behind a neutral interface. In the current slice, Lifeline persists contract metadata only and does not yet execute OS-specific registration commands.
