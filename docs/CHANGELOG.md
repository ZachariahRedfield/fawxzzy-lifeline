# Changelog

## 2026-03-25

- Fixed supervisor restart accounting to track the managed live child process consistently (including wrapper/listener divergence), so crash recovery increments `restartCount` deterministically.
- Updated runtime status rendering and smoke coverage to assert coherent state: running status now requires a live managed child and healthy endpoint after restart.
