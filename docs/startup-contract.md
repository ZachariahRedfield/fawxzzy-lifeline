# Startup contract (merged Wave 2)

Merged Wave 2 defines Lifeline's startup-registration seam and deterministic CLI/state behavior. This document tracks the contract boundary and current runtime behavior, including active Windows Task Scheduler backend wiring.

## Scope

- Startup registration scope is **machine-local**.
- The contract target is always the Lifeline restore entrypoint: `lifeline restore`.
- The contract is platform-neutral and does not expose Task Scheduler/systemd/launchd specifics.

## CLI surface

```bash
lifeline startup status
lifeline startup enable [--dry-run]
lifeline startup disable [--dry-run]
```

Semantics:

- `enable`: call the startup backend seam `install` operation, then persist startup intent as `enabled`.
- `disable`: call the startup backend seam `uninstall` operation, then persist startup intent as `disabled`.
- `status`: report current contract state and backend readiness from the active backend seam inspection.
- `--dry-run`: print the plan without writing state or invoking backend install/uninstall mutations.

The contract's canonical startup target is always `lifeline restore`; startup backends must reuse this entrypoint and must not introduce duplicate lifecycle logic.

Status output shape (deterministic):

```text
Startup supported: <yes|no>
Startup enabled: <yes|no>
Startup backend status: <installed|not-installed|unsupported>
- mechanism: contract-only
- scope: machine-local
- restore entrypoint: lifeline restore
- detail: <backend/status detail>
```

## Contract seam and current backend availability

The startup contract seam is stable and real: the CLI, persisted startup metadata, and backend seam calls (`install`, `uninstall`, `inspect`) are all active in current main.

Current default backend selection:

Current startup status mechanism contract wording remains `contract-only` across docs parity surfaces.

- `win32` resolves to the Windows Task Scheduler backend (`windows-task-scheduler`).
- `linux` and `darwin` resolve to the unsupported fallback backend (`contract-only`).

Contract behavior split:

- `startup enable`/`startup disable` always call backend seam install/uninstall before persisting intent.
- `startup status` always reports the active seam `inspect` view plus persisted intent.
- `enable --dry-run` / `disable --dry-run` execute planning only and remain non-mutating.

When the selected backend is unsupported, backend readiness resolves as `unsupported` and `.lifeline/startup.json` persists that seam result after non-dry-run `enable` and `disable`.

## Windows backend status (current)

As of April 4, 2026, default `win32` backend resolution targets Windows Task Scheduler. `lifeline startup enable` and `lifeline startup disable` invoke Scheduler create/delete flows through that backend.

Expected Windows detail shape includes:

- installed: `Registered task LifelineRestoreAtLogon to run lifeline restore on user logon.`
- not-installed: `Task LifelineRestoreAtLogon is not currently registered in Windows Task Scheduler.`
- unavailable tooling: `Windows Task Scheduler CLI is unavailable, so startup registration cannot be inspected.`

## Restore entrypoint wiring

The canonical startup target remains `lifeline restore`. Startup backends must route to this entrypoint and must not introduce duplicate restore/bootstrap lifecycle entrypoints.

## Persisted metadata

Lifeline persists only minimal Wave 2 metadata in `.lifeline/startup.json`:

- contract `version`
- startup `scope` (`machine-local`)
- `restoreEntrypoint` (`lifeline restore`)
- desired `intent` (`enabled` or `disabled`)
- `backendStatus` readiness marker (`not-installed`)
- `updatedAt` timestamp

No platform-specific registration identifiers are persisted in this slice yet.

## Backend contract expectation

Future platform installers must plug into this contract, not bypass it. Backends should read the contract intent and apply OS-specific wiring while preserving the contract's machine-local scope and restore-entrypoint target.

## Deferred backends

Additional platform installers (for example, systemd and launchd) remain deferred. Until those land, non-Windows platforms stay on the unsupported fallback backend and should continue to emit explicit unsupported detail in status and mutation flows.
