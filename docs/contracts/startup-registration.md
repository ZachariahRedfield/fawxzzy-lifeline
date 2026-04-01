# Startup registration contract (Wave 2)

Wave 2 introduces a platform-neutral startup registration surface for Lifeline.

## Goal

Describe **what** Lifeline wants at machine boot/login without embedding **how** each OS installs that behavior.

Current scope is intentionally narrow:

- scope: `machine-local`
- target: `lifeline-restore`
- actions: `enable`, `disable`, `status`

`lifeline-restore` means Lifeline should run `lifeline restore` automatically on machine startup (or equivalent local autostart event), so previously restorable apps can be relaunched.

## CLI surface

```bash
lifeline startup enable [--dry-run]
lifeline startup disable [--dry-run]
lifeline startup status
```

Behavior in this slice:

- `enable` / `disable` updates Lifeline's contract state only.
- `status` prints the current contract state.
- `--dry-run` prints intent and does not write state.

## Persisted metadata

Lifeline stores startup contract state in `.lifeline/startup.json`.

Minimum metadata is persisted:

- `enabled`: desired startup registration state
- `scope`: `machine-local`
- `target`: `lifeline-restore`
- `backend`: installer backend identity (currently `unconfigured`)
- `updatedAt`: ISO timestamp
- `note`: explicit reminder that installer backends are not wired yet

## Backend seam (not implemented yet)

Platform-specific startup installers must plug in behind this contract, for example:

- Windows Task Scheduler backend
- Linux systemd user/global backend
- macOS launchd backend

Those implementations are intentionally deferred. This contract keeps Wave 2 testable and portable before backend wiring lands.
