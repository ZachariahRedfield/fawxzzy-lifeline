# Changelog

## 2026-03-25

- Fixed runtime smoke restart verification to poll canonical `.lifeline/state.json` restart telemetry instead of relying on formatted status text parsing.
- Added deterministic managed-child failure checks in smoke (`/crash`) so `restartCount` progression is observed from the same source the supervisor mutates.
- WHY: smoke could miss real restart bookkeeping when status output lagged or represented non-canonical process metadata.
