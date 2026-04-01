# Lifeline v1 scope

Lifeline v1 is the smallest useful version of a self-hosted app operator for one machine. The boundary is deliberately tight so the project can earn operational trust before it grows.

## Boundary

Lifeline v1 includes:

- supervisor-backed local app lifecycle for one machine
- restart-on-failure with bounded backoff and crash-loop detection
- persisted runtime metadata for deterministic restore
- manifest-driven app definitions
- CLI validation for those manifests
- local runtime commands: `up`, `down`, `status`, `logs`, `restart`, `restore`
- support for the `next-web` and `node-web` archetypes
- example manifests for the fitness app and Playbook UI
- an in-repo fixture app used for runtime smoke verification
- lightweight automation to keep the repo healthy

Lifeline v1 excludes:

- dashboards
- multi-node orchestration
- databases
- auth
- managed platform ambitions
- git clone/pull automation
- remote deployment
- webhooks
- reverse proxies, domains, or TLS
- hot reload/file watching workflows

## Operating rules

- **Rule:** Prefer a boring local operator over a premature platform abstraction.
- **Pattern:** Validate generic app contracts, but verify runtime behavior with an in-repo fixture.
- **Failure Mode:** Tying runtime verification to real external apps too early creates fragile CI and permanent maintenance drag.

## Why the boundary is strict

The fastest path to a fragile system is mixing deployment ideas, control-plane ambitions, and product-specific exceptions before the contract is stable. Lifeline should first prove that different apps can share one boring manifest shape and one boring runtime path on a single machine.

## Early targets

The fitness app and Playbook UI remain the initial targets because they exercise the same model in slightly different ways without requiring product-specific runtime logic. Their manifests are examples and early target contracts. Actually running them requires each user to provide a valid local `deploy.workingDirectory` on their own machine.


## Wave sequencing

Wave 2 extends scope with Windows startup registration (Task Scheduler), wired to the canonical `lifeline restore` flow.
