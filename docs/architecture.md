# Architecture

Lifeline uses a simple three-part architecture.

## 1. Manifest contract

The manifest contract is the source of truth for how a Lifeline-managed app should be described. It captures repo location, branch, commands, port, healthcheck, environment expectations, and deployment strategy.

The contract is intentionally small and explicit. Every field exists because a future runtime engine will need it.

## 2. CLI

The CLI is the operator-facing entrypoint. In v1 it only implements manifest validation:

- load YAML
- check the manifest shape
- print human-readable success or error output
- exit non-zero on invalid input

This gives contributors a reliable way to test contract changes without building runtime behavior too early.

## 3. Future runtime engine

A runtime engine will come later. It will consume the same manifest contract to run local install/build/start/status/log workflows on a single machine.

That runtime layer is intentionally deferred. Lifeline v1 stops at validation and scaffolding so the architecture stays boring, legible, and maintainable.
