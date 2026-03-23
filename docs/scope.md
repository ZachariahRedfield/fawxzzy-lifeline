# Lifeline v1 scope

Lifeline v1 is the smallest useful version of a self-hosted app deploy/runtime layer for Fawxzzy apps. The boundary is deliberately tight so the project can earn operational trust before it grows.

## Boundary

Lifeline v1 includes:

- manifest-driven app definitions
- CLI-based validation for those manifests
- support for the `next-web` and `node-web` archetypes
- example manifests for the fitness app and Playbook UI
- lightweight automation to keep the repo healthy

Lifeline v1 excludes:

- dashboards
- multi-node orchestration
- managed platform ambitions
- databases
- generalized platform abstractions
- runtime execution behavior beyond config validation and CLI scaffolding

## Operating rules

- **Rule:** Prefer stable contracts over feature breadth.
- **Pattern:** Support app archetypes, not one-off product hacks.
- **Failure Mode:** Turning Lifeline into a fake Vercel clone too early creates permanent maintenance drag.

## Why the boundary is strict

The fastest path to a fragile system is mixing deployment ideas, control-plane ambitions, and product-specific exceptions before the contract is stable. Lifeline should first prove that two different apps can share one boring manifest shape. If that works, later runtime behavior can stay simple.

## First deployment targets

The fitness app and Playbook UI are the initial targets because they exercise the same model in slightly different ways without forcing Lifeline to become a generalized platform.
