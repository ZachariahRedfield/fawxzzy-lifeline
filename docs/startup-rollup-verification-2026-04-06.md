# Startup rollup verification (2026-04-06)

## Repo health check
- Public repo: `ZachariahRedfield/fawxzzy-lifeline`.
- Public pull request counts on 2026-04-06: **2 open**, **234 closed**.
- Startup rollup context in public history:
  - PR #222 merged on 2026-04-04 (runtime startup hardening).
  - PR #236 merged on 2026-04-06 (docs-only startup wording updates).

## Startup rollup PR verdict
- Requested branch/PR target: `codex/startup-rollup-public-proof` against `main`.
- Public verification result: **no public PR currently indexed with head `codex/startup-rollup-public-proof`**.
- Public fallback verification used the merged startup rollup PR #236:
  - URL: <https://github.com/ZachariahRedfield/fawxzzy-lifeline/pull/236>
  - Verdict: **merged docs-only rollup**.
  - Files changed in PR #236: `README.md`, `docs/startup-contract.md`.

## Full startup reconciliation surface check (public diff truth)
Requested surface:
- `src/core/startup-backend.ts`
- `src/core/startup-backends/**`
- `README.md`
- `docs/startup-contract.md`
- `docs/architecture.md`
- startup deterministic scripts

Public diff result:
- PR #236 includes only `README.md` and `docs/startup-contract.md`.
- PR #236 does **not** include runtime backend seam files, backend implementation files, `docs/architecture.md`, or startup deterministic scripts.
- That broader runtime surface was already handled in prior merged startup runtime PR(s), including PR #222.

## README + startup contract parity with shipped behavior
- README startup coverage statement matches shipped backend registry on `main`:
  - `win32`, `linux`, `darwin`, `freebsd`, `openbsd`, `netbsd`, `aix`.
- `docs/startup-contract.md` also lists the same shipped backend coverage and keeps `lifeline restore` as canonical startup target.
- Minor doc polish remains possible (final sentence grammar in `docs/startup-contract.md`) but behavioral parity is intact.

## Unsupported fallback explicitness
- Unsupported platforms remain explicit through startup backend seam:
  - status `unsupported`
  - mechanism `contract-only`
  - detail includes concrete platform name
  - contract intent can still persist for future backend availability

## Exact highest-leverage next initiative (public-truth ranking)
**Implement one additional real OS startup installer backend for currently unsupported platforms (starting with one highest-demand target), including deterministic seam + backend coverage.**

Why this is now the top gap:
- Public startup docs and core merged backend seam are already aligned.
- Remaining startup product gap is not test-only; it is missing concrete installer support for still-unregistered platforms that currently fall back to contract-only unsupported status.
- Shipping even one new backend materially expands real operator value on `main`.

## Parallelization plan with file ownership boundaries
### Decision
- **One PR for the first new backend slice** (recommended), because runtime seam, backend behavior, command output detail, and docs/test updates all overlap the same startup flow and review context.

### Ownership boundaries
- Runtime/backend implementation owner:
  - `src/core/startup-backend.ts` (registry wiring only)
  - `src/core/startup-backends/<new-platform-backend>.ts`
- Contract/CLI output owner:
  - `src/core/startup-contract.ts` (detail/status coherence if needed)
  - `src/commands/startup.ts` (operator-facing status/mutation messaging)
- Verification/docs owner:
  - `scripts/test-startup-<new-platform>-deterministic.mjs`
  - `scripts/test-suites.json`
  - `README.md`
  - `docs/startup-contract.md`
  - `docs/architecture.md`

### If you must parallelize anyway
- Bundle A (runtime): backend implementation + registry + command/contract plumbing.
- Bundle B (non-blocking): docs/tests only after Bundle A API shape is finalized.
- Keep Bundle B strictly downstream to avoid merge churn.

## Copy-paste-ready next Codex prompt(s)
### Prompt 1 — single highest-leverage backend expansion PR (recommended)
```text
Work only in fawxzzy-lifeline.

Objective
Ship the highest-leverage remaining startup product gap by adding one real installer backend for a currently unsupported platform on main.

Scope
- Add one new startup backend implementation under src/core/startup-backends/.
- Register it in src/core/startup-backend.ts.
- Keep canonical restore entrypoint wiring to `lifeline restore`.
- Preserve dry-run non-mutation semantics and explicit unsupported fallback for still-unregistered platforms.
- Update startup status/detail coherence only where required in:
  - src/core/startup-contract.ts
  - src/commands/startup.ts
- Add deterministic tests and suite registration:
  - scripts/test-startup-<platform>-deterministic.mjs
  - scripts/test-suites.json
- Update docs parity:
  - README.md
  - docs/startup-contract.md
  - docs/architecture.md

Hard rules
- Lifeline-only.
- Prefer product behavior gap closure over test-only or wording-only work.
- Do not reopen the Playbook↔Fitness seam/bootstrap/esbuild issue.

Validation
- Run targeted deterministic startup tests and include exact commands/results.
- Explicitly verify unsupported fallback still returns `unsupported` + `contract-only` on at least one still-unregistered platform.

Return
- concise diff summary
- test results
- rollback risk notes
```

### Prompt 2 — optional follow-up docs polish only (after backend lands)
```text
Work only in fawxzzy-lifeline.

Objective
Polish startup docs wording only after the new startup backend is merged.

Scope
- README.md
- docs/startup-contract.md
- docs/architecture.md

Hard rules
- No runtime code changes.
- Docs must reflect shipped behavior on main exactly.
- Do not reopen the Playbook↔Fitness seam/bootstrap/esbuild issue.

Validation
- Run docs parity checks and report exact commands/results.

Return
- wording-only diff summary
- validation outputs
```
