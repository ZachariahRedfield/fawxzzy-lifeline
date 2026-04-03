# Playbook Notes

Use this file to record meaningful code changes in a concise, reviewable format.
Link related pull requests whenever possible.

## 2026-03-25

- WHAT changed:
  - Updated runtime smoke polling to read canonical restart telemetry from `.lifeline/state.json`.
  - Added deterministic crash checks for the HTTP crash path, expecting persisted `restartCount` to increment through supervised recovery.
  - Kept status assertions focused on coherence (`supervisor` and `child` alive + healthy endpoint), while restart-count waiting now uses state persistence directly.
  - Updated changelog with the smoke-accounting fix and rationale.
- WHY it changed:
  - RestartCount mutations happen in supervisor state persistence; parsing human-readable status output could miss or mis-time those updates and cause false smoke timeouts.
  - Governance rule requires runtime changes to be documented with WHAT/WHY.
- Evidence (PR / issue / commit):
  - Follow-up commit on this branch addressing smoke timeout waiting for `restartCount >= 1`.

## 2026-04-03

- WHAT changed:
  - Refactored status proof-mode control flow so proof payload serialization is invariant and always emitted before any proof-gate exit enforcement is applied.
  - Added proof output modes for `status` (`--proof` JSON and `--proof-text` operator brief) and explicit gate enforcement (`--proof-gate` / `--enforce-proof-gate`).
  - Extended deterministic status verification to assert additive-safe proof payload emission on both success and enforced-failure paths.
- Pattern:
  - Serialize proof state first, apply enforcement exit policy second.
- Rule:
  - Proof-mode rendering is invariant; enforcement changes exit code only and never mutates or suppresses payload/brief shape.
- Failure mode addressed:
  - Short-circuiting unhealthy proof states into generic CLI failure output can drop the proof contract and incorrectly force non-zero exits for operator-facing proof status.
- WHY it changed:
  - Keeps operator status reporting readable and stable while preserving fail-closed behavior for explicit proof-gate use cases.
