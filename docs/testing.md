# Testing model

Lifeline keeps test structure discoverable from the repo via two explicit layers:

- **Smoke tests**: fixture-backed runtime flow checks.
- **Deterministic suites**: contract/helper/command coverage registered in `scripts/test-suites.json`.

## Deterministic suite registry

Source of truth: `scripts/test-suites.json`.

Current suites:

- `commands`
- `contracts`
- `core`
- `examples`
- `utilities`

## Run deterministic suites

Use the deterministic test runner (`scripts/test-runner.mjs`):

```bash
# list available deterministic suites
node scripts/test-runner.mjs list

# run one deterministic suite
node scripts/test-runner.mjs run core

# run all deterministic suites
node scripts/test-runner.mjs run all
```

## Suite role vs smoke role

- Smoke tests prove runtime flows and fixture-backed end-to-end behavior.
- Deterministic suites prove contracts, command behavior, and helper/runtime primitives.

## Docs summary

- **Rule:** Test structure should be discoverable from the repo, not tribal knowledge.
- **Pattern:** Smoke tests prove runtime flows; deterministic suites prove contracts and helpers.
- **Failure Mode:** Without docs parity, new coverage lands but nobody knows how to run or extend it consistently.
