# Changelog

## 2026-04-01

- Added deterministic Wave 2 startup verification (`pnpm test:startup-deterministic`) that checks restore entrypoint wiring, startup command planning, and startup registration-state inspection without requiring reboot simulation.
- Added Wave 2 startup operator guidance in README for enable/status/disable workflow and explicit restore interaction boundaries.
- Documented Wave 2 startup Rule/Pattern/Failure Mode in scope docs to keep machine-integration verification deterministic and trustable.

## 2026-03-25

- Fixed runtime smoke restart verification to poll canonical `.lifeline/state.json` restart telemetry instead of relying on formatted status text parsing.
- Added deterministic managed-child failure checks in smoke (`/crash`) so `restartCount` progression is observed from the same source the supervisor mutates.
- WHY: smoke could miss real restart bookkeeping when status output lagged or represented non-canonical process metadata.
