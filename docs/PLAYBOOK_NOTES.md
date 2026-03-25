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
