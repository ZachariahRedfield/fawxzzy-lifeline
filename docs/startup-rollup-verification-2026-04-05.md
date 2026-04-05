# Startup rollup verification — 2026-04-05

## GitHub-visible startup branch/PR truth (from merged history)

Current `work` HEAD is a GitHub merge commit:

- `7d75631` — `Merge pull request #232 from ZachariahRedfield/codex/integrate-startup-backends-into-main`
- merge summary: `Roll up startup backend coverage into one main catch-up slice`

Recent startup-domain merges visible in commit history:

- `#225` macOS launchd startup support
- `#226` FreeBSD rc.d startup support
- `#227` OpenBSD rcctl startup support
- `#228` NetBSD rc.d startup support
- `#230` AIX inittab startup support
- `#231` AIX assumptions/docs clarification
- `#232` startup rollup integration into main

This indicates the startup rollup is landed on the current branch tip and recorded as GitHub-created merge commits.

## Startup rollout parity check

Verified parity across the four required surfaces:

1. `src/core/startup-backend.ts`
   - registry includes: `aix`, `darwin`, `freebsd`, `linux`, `netbsd`, `openbsd`, `win32`
2. `src/core/startup-backends/`
   - files present: `aix-inittab.ts`, `launchd.ts`, `freebsd-rcd.ts`, `openbsd-rcctl.ts`, `netbsd-rcd.ts`, `systemd.ts`, `windows-task-scheduler.ts`
3. `README.md`
   - startup section lists matching platform/backend coverage and fallback behavior
4. `docs/startup-contract.md`
   - platform/backend matrix and per-platform behavior match the registry and backend files

Result: these surfaces are aligned with the landed startup rollout.

## Canonical validation run on landed branch

Executed locally:

- `pnpm install`
- `pnpm build`
- `node scripts/lib/ensure-built.mjs`
- `pnpm smoke:playbook`
- `pnpm smoke:runtime`
- `pnpm test:startup-deterministic`
- `pnpm test:startup-roundtrip`

Outcome:

- build/test/smoke commands passed
- environment warning observed: repo expects Node `>=22.14.0 <23`, container has Node `20.19.6`

## Re-ranked highest-leverage next initiative

### Initiative
**Unify outdated architecture docs with landed startup reality and add a regression guard so docs cannot drift behind platform coverage again.**

### Why this is highest-leverage now

- It addresses an active product-discoverability gap after rollout: at least one architecture statement still says platform installers are deferred.
- It reduces operator confusion immediately on public/main, unlike test-only work.
- It is low risk and directly tied to the now-landed startup capability.

## One PR vs parallel bundles

Recommendation: **one PR**.

Reasoning: file overlap is high and coupled:

- `docs/architecture.md` (outdated startup statement)
- `README.md` (public capability summary)
- `docs/startup-contract.md` (canonical startup contract narrative)
- `scripts/test-doc-startup-contract-parity-deterministic.mjs` (or equivalent docs parity check)

Parallel execution would cause repeated edits in shared startup narrative files and likely merge conflicts. Keep this as one coherent “public truth alignment + guardrail” PR.

## Copy-paste-ready next Codex prompt

```text
Work only in fawxzzy-lifeline.

Objective
Ship one docs-first PR that aligns architecture/public docs with the already-landed startup backend rollout and adds a deterministic guardrail against future doc drift.

Constraints
- Do not reopen Playbook↔Fitness seam/bootstrap/esbuild work.
- Prefer product truth/clarity over adding net-new tests unrelated to startup docs parity.
- Keep changes tightly scoped to startup coverage statements.

Tasks
1) Find startup capability statements that still claim platform installers are deferred or otherwise contradict current shipped coverage.
2) Update docs/architecture.md, README.md, and docs/startup-contract.md so they present one consistent startup truth (aix/darwin/freebsd/linux/netbsd/openbsd/win32 + unsupported fallback).
3) Add or update one deterministic docs-parity check script to fail when README/startup-contract drift from registry coverage in src/core/startup-backend.ts.
4) Run the smallest canonical command set proving the update:
   - pnpm build
   - node scripts/lib/ensure-built.mjs
   - pnpm test:startup-deterministic
   - pnpm test:startup-roundtrip
   - the docs parity test you touched
5) Return a concise changelog, exact commands run, and any remaining known startup gaps from public truth.

Deliverable
- Single PR (no parallel bundles).
```
