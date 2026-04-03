# Startup contract (merged Wave 2)

Merged Wave 2 defines Lifeline's startup-registration seam and deterministic CLI/state behavior before any platform installers are implemented.

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

- `enable`: set startup intent to enabled.
- `disable`: set startup intent to disabled.
- `status`: report current contract state and backend readiness.
- `--dry-run`: print the plan without writing state.

The contract's canonical startup target is always `lifeline restore`; startup backends must reuse this entrypoint and must not introduce duplicate lifecycle logic.

## Persisted metadata

Lifeline persists only minimal Wave 2 metadata in `.lifeline/startup.json`:

- contract `version`
- startup `scope` (`machine-local`)
- `restoreEntrypoint` (`lifeline restore`)
- desired `intent` (`enabled` or `disabled`)
- `backendStatus` readiness marker (`not-installed`)
- `updatedAt` timestamp

No platform-specific registration identifiers are persisted in this slice.

## Backend contract expectation

Future platform installers must plug into this contract, not bypass it. Backends should read the contract intent and apply OS-specific wiring while preserving the contract's machine-local scope and restore-entrypoint target.
