# Architecture

Lifeline uses a simple three-part architecture.

## 1. Manifest contract

The manifest contract is the source of truth for how a Lifeline-managed app should be described. It captures repo location, branch, commands, port, healthcheck, environment expectations, and deployment strategy.

Validation remains structural on purpose. Runtime commands enforce additional local requirements only when execution is requested.

## 2. CLI operator

The CLI is the operator-facing entrypoint. In the current v1 slice it implements:

- `validate`: parse YAML and validate the manifest shape
- `up`: prepare env, run install/build, start the app, persist state, and perform a health check
- `status`: recompute process liveness and health instead of trusting stale state blindly
- `logs`: print a boring tail of the stored app log file
- `down`: stop the process cleanly and remove runtime state
- `restart`: stop the app and rerun the full lifecycle from the stored manifest path

The CLI remains intentionally human-readable and narrow.

## 3. Local runtime layer

The runtime layer is still intentionally small:

- `deploy.workingDirectory` identifies the local app checkout to operate on
- env-file parsing is in-repo and minimal (`KEY=VALUE`, comments, blank lines)
- `child_process.spawn` runs install/build as foreground steps and start as a detached background process
- `.lifeline/state.json` stores explicit runtime state keyed by app name
- `.lifeline/logs/<app-name>.log` stores appended stdout/stderr logs
- health checks poll `http://127.0.0.1:<port><healthcheckPath>` for up to about 30 seconds
- stop behavior is cross-platform: `taskkill` on Windows, process-group termination on POSIX where available

## Fixture-driven verification

Lifeline verifies runtime behavior with an in-repo smoke fixture instead of using real external apps. That keeps CI deterministic, avoids maintenance drag, and ensures the operator stays grounded in the shared contract rather than app-specific logic.
