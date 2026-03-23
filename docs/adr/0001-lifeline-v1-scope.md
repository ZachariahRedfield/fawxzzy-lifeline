# ADR 0001: Lifeline v1 scope

- Status: Accepted
- Date: 2026-03-23

## Context

Lifeline needs to become a reliable self-hosted deploy/runtime layer without turning into an expensive platform project before the basics are proven.

## Decision

For Lifeline v1 we will keep the project:

- single machine first
- CLI first
- single package
- without a dashboard
- without a database
- without generalized platform abstractions yet

We will only build:

- a manifest contract
- manifest validation
- repo automation that keeps the tool healthy

## Consequences

### Positive

- lower maintenance burden
- faster iteration on the contract
- fewer speculative abstractions
- easier onboarding for future contributors

### Negative

- no deploy/runtime behavior yet
- no centralized operator experience
- intentionally limited feature surface

## Follow-up

If the manifest contract remains stable across the fitness app and Playbook UI, the next milestone is adding single-machine runtime workflows on top of the same contract.
