# Lifeline

Lifeline is the opinionated, self-hosted deploy/runtime layer for Fawxzzy apps. This repository is intentionally narrow: Lifeline v1 starts with stable app definitions and a CLI that validates them before any deploy automation exists.

## Why Lifeline exists

Fawxzzy needs a boring, low-maintenance path to describe how apps should be installed, built, started, and checked on a self-hosted machine. Lifeline exists to replace small pieces of Vercel-style functionality over time, one careful step at a time, without inheriting the operational surface area of a hosted platform.

The first milestone is not deployment. The first milestone is a stable manifest contract plus tooling that proves app definitions are explicit and valid.

## What Lifeline is

- A single-package TypeScript CLI for Lifeline v1.
- A home for a small, explicit app manifest contract.
- A validation tool for early adopter app targets.
- A foundation for future local deploy/start/status/log behavior.

## What Lifeline is not

- Not a cloud platform.
- Not a web dashboard.
- Not an auth system.
- Not a database-backed control plane.
- Not a multi-node orchestrator.
- Not a Vercel clone.

## Why this repo is intentionally narrow

This repository is **Lifeline only**. It avoids adjacent product concerns so the contract stays stable, understandable, and cheap to maintain. A narrow repo keeps the project honest: each addition must support reliable self-hosted app operation, not platform sprawl.

## V1 scope

Lifeline v1 currently covers:

- A manifest contract for `next-web` and `node-web` applications.
- A CLI entrypoint with `lifeline validate <manifest-path>`.
- Example manifests for the fitness app and Playbook UI.
- Low-noise automation for install, typecheck, build, and manifest validation.

## Non-goals

Lifeline v1 does **not** include:

- Deploy execution.
- Process supervision.
- Runtime state tracking.
- Log aggregation.
- Rollbacks.
- Secrets management.
- Managed platform features.

## Early adopter targets

The first two app targets are:

- **Fitness app**
- **Playbook UI**

Playbook UI is an early adopter by design: it should fit the same manifest model as the fitness app rather than requiring one-off infrastructure logic.

## Current CLI usage

```bash
pnpm install
pnpm build
pnpm lifeline validate examples/fitness-app.lifeline.yml
pnpm lifeline validate examples/playbook-ui.lifeline.yml
```

## Minimal dependency policy

Lifeline keeps dependencies intentionally small:

- `typescript`: compile and typecheck the CLI.
- `@biomejs/biome`: one tool for formatting and linting.

YAML parsing is implemented inside the repo because the manifest contract is intentionally small and stable. That avoids carrying extra runtime dependencies during the bootstrap phase.

## Next milestone

The next milestone is local deploy/runtime behavior for a single machine: install, start, status, and log workflows that build on the same manifest contract. That work comes **after** the contract and validation path feel stable.

## Project documents

- [Scope](docs/scope.md)
- [Architecture](docs/architecture.md)
- [App manifest contract](docs/contracts/app-manifest.md)
- [ADR 0001: Lifeline v1 scope](docs/adr/0001-lifeline-v1-scope.md)
