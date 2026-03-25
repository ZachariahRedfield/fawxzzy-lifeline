# Playbook Notes

Use this file to record meaningful code changes in a concise, reviewable format.
Link related pull requests whenever possible.

## 2026-03-25

- WHAT changed:
  - Normalized supervisor runtime ownership so `childPid` represents the managed live process (listener when available), while `wrapperPid` is tracked separately for diagnostics.
  - Added managed-exit handling when wrapper exits but listener remains alive, ensuring restart accounting increments when the real serving process later dies.
  - Tightened `status` output/state reconciliation so `running` is reported only with coherent managed child + health state.
  - Expanded runtime smoke coverage to verify crash-restart count increments and post-restart child/health coherence.
  - Added changelog entry for this runtime accounting fix.
- WHY it changed:
  - Smoke/runtime telemetry could report healthy service with `wrapper child: stopped` and `restartCount: 0` after crash recovery due to wrapper/listener PID drift.
  - Lifeline must derive supervision state, health state, and restart accounting from one coherent runtime truth source.
- Evidence (PR / issue / commit):
  - Commit in this branch after PR feedback on restart accounting drift.
