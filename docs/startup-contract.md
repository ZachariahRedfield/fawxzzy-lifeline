# Startup contract (merged Wave 2)

Merged Wave 2 defines Lifeline's startup-registration seam and deterministic CLI/state behavior. This document tracks the contract boundary and current runtime behavior, including current Windows Task Scheduler support, Linux user-systemd support, macOS launchd support, FreeBSD rc.d support, OpenBSD rcctl support, NetBSD rc.d support, AIX inittab support, and unsupported-platform fallback behavior.

## Scope

- Startup registration scope is **machine-local**.
- The contract target is always the Lifeline restore entrypoint: `lifeline restore`.
- The contract is platform-neutral and does not expose Task Scheduler/systemd/launchd specifics to callers.

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
- mechanism: <backend mechanism>
- scope: machine-local
- restore entrypoint: lifeline restore
- detail: <backend/status detail>
```

## Contract-only vs real backend status

Current runtime selection supports both real platform installers and contract-only fallback:

- the CLI and persisted startup metadata are real and deterministic
- backend seam calls are real (`install`, `uninstall`, `inspect`)
- the selected backend may be platform-specific (`windows-task-scheduler`) or `unsupported`

Contract behavior split:

- `startup enable`/`startup disable` always call backend seam install/uninstall before persisting intent.
- `startup status` always reports the active seam `inspect` view plus persisted intent.
- `enable --dry-run` / `disable --dry-run` execute planning only and remain non-mutating.
- dry-run planning reports the same canonical restore entrypoint (`lifeline restore`) and backend status/detail shape as mutation flows.

When the selected backend is unsupported, backend readiness resolves as `unsupported` and `.lifeline/startup.json` persists that seam result after non-dry-run `enable` and `disable`.

Once a platform backend lands, this document and deterministic startup verification must be updated in the same change set to keep behavior discoverable.

## Windows backend status (current)

As of April 4, 2026, default `win32` backend resolution selects the `windows-task-scheduler` backend in normal CLI flow.

Behavior:

- `startup enable` attempts `schtasks /Create ...` for task `LifelineRestoreAtLogon` targeting `lifeline restore`.
- `startup disable` attempts `schtasks /Delete ...` for task `LifelineRestoreAtLogon`.
- `startup status` inspects the same task via `schtasks /Query ...` and reports `windows-task-scheduler` mechanism.
- If Task Scheduler CLI is unavailable, backend detail is explicit and readiness resolves to `unsupported`.


## Linux backend status (current)

As of April 4, 2026, default `linux` backend resolution selects the `systemd-user` backend in normal CLI flow.

Behavior:

- `startup enable` writes `~/.config/systemd/user/lifeline-restore.service`, reloads the user manager, and enables/starts the unit for `lifeline restore`.
- `startup disable` disables/stops `lifeline-restore.service`, removes that unit file, and reloads the user manager.
- `startup status` inspects the same user unit via `systemctl --user cat lifeline-restore.service` and reports `systemd-user` mechanism.
- If `systemctl` is unavailable for the user session, backend detail is explicit and readiness resolves to `unsupported`.

## macOS backend status (current)

As of April 5, 2026, default `darwin` backend resolution selects the `launchd-agent` backend in normal CLI flow.

Behavior:

- `startup enable` writes `~/Library/LaunchAgents/io.lifeline.restore.plist` and bootstraps it in the current user domain (`gui/<uid>`) for `lifeline restore`.
- `startup disable` boots out `io.lifeline.restore` from the same user domain and removes that LaunchAgent plist.
- `startup status` verifies canonical `lifeline restore` ProgramArguments from that plist and inspects `launchctl print gui/<uid>/io.lifeline.restore` to report install state via `launchd-agent` mechanism.
- If `launchctl` is unavailable, backend detail is explicit and readiness resolves to `unsupported`.

## FreeBSD backend status (current)

As of April 5, 2026, default `freebsd` backend resolution selects the `freebsd-rc.d` backend in normal CLI flow.

Behavior:

- `startup enable` writes `/usr/local/etc/rc.d/lifeline_restore`, sets executable permissions, and writes `/etc/rc.conf.d/lifeline_restore` with `lifeline_restore_enable="YES"` so startup targets `lifeline restore`.
- `startup disable` removes `/usr/local/etc/rc.d/lifeline_restore` and `/etc/rc.conf.d/lifeline_restore`.
- `startup status` inspects those same files to verify canonical `lifeline restore` wiring and reports install state via `freebsd-rc.d` mechanism.
- Install/uninstall may fail without write access to system startup paths; backend detail remains explicit when that occurs.

## OpenBSD backend status (current)

As of April 5, 2026, default `openbsd` backend resolution selects the `openbsd-rcctl` backend in normal CLI flow.

Behavior:

- `startup enable` writes `/etc/rc.d/lifeline_restore`, sets executable permissions, runs `rcctl set lifeline_restore flags restore`, and enables `lifeline_restore` so startup targets `lifeline restore`.
- `startup disable` disables `lifeline_restore`, clears its rcctl startup flags, and removes `/etc/rc.d/lifeline_restore`.
- `startup status` verifies canonical `lifeline restore` script wiring and inspects `rcctl get lifeline_restore status/flags` to report install state via `openbsd-rcctl` mechanism.
- If `rcctl` is unavailable, backend detail is explicit and readiness resolves to `unsupported`.

## NetBSD backend status (current)

As of April 5, 2026, default `netbsd` backend resolution selects the `netbsd-rc.d` backend in normal CLI flow.

Behavior:

- `startup enable` writes `/etc/rc.d/lifeline_restore`, sets executable permissions, and writes `/etc/rc.conf.d/lifeline_restore` with `lifeline_restore="YES"` so startup targets `lifeline restore`.
- `startup disable` removes `/etc/rc.d/lifeline_restore` and `/etc/rc.conf.d/lifeline_restore`.
- `startup status` inspects those same files to verify canonical `lifeline restore` wiring and reports install state via `netbsd-rc.d` mechanism.
- Install/uninstall may fail without write access to system startup paths; backend detail remains explicit when that occurs.

## AIX backend status (current)

As of April 5, 2026, default `aix` backend resolution selects the `aix-inittab` backend in normal CLI flow.

Behavior:

- `startup enable` creates or updates AIX inittab entry `llrestore` using `mkitab`/`chitab` so startup targets `lifeline restore`.
- `startup disable` removes the same inittab entry with `rmitab`.
- `startup status` inspects the same entry via `lsitab llrestore` and reports install state via `aix-inittab` mechanism when canonical restore wiring is present.
- If AIX inittab tooling is unavailable, backend detail is explicit and readiness resolves to `unsupported`.

## Unsupported platform behavior (current)

Platforms without a registered installer backend currently resolve to the `unsupported` backend (for example, `sunos`):

- mechanism is `contract-only`
- status is `unsupported`
- detail includes the concrete platform name (for example, `No startup installer backend is available on sunos yet.`)
- startup intent still persists in `.lifeline/startup.json` for future backend availability

## Restore entrypoint wiring

The canonical startup target remains `lifeline restore`. Startup backends must route to this entrypoint and must not introduce duplicate restore/bootstrap lifecycle entrypoints.

## Persisted metadata

Lifeline persists only minimal Wave 2 metadata in `.lifeline/startup.json`:

- contract `version`
- startup `scope` (`machine-local`)
- `restoreEntrypoint` (`lifeline restore`)
- desired `intent` (`enabled` or `disabled`)
- `backendStatus` readiness marker (`installed` | `not-installed` | `unsupported`)
- `updatedAt` timestamp

No platform-specific registration identifiers are persisted in this slice.

## Backend contract expectation

Future platform installers must plug into this contract, not bypass it. Backends should read the contract intent and apply OS-specific wiring while preserving the contract's machine-local scope and restore-entrypoint target.

Current shipped installer coverage is `win32` via Task Scheduler, `linux` via user systemd, `darwin` via launchd, `freebsd` via rc.d, `openbsd` via rcctl, `netbsd` via rc.d, and `aix` via inittab; remaining deferred startup installers are still-unregistered platforms.
