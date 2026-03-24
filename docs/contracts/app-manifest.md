# Lifeline app manifest contract

Lifeline manifests are YAML files that describe a deployable application using one shared model.

## Supported archetypes

- `next-web`
- `node-web`

## Full YAML shape

```yaml
name: fitness-app
archetype: next-web
repo: git@github.com:fawxzzy/fitness-app.git
branch: main
projectPath: apps/web
installCommand: pnpm install --frozen-lockfile
buildCommand: pnpm build
startCommand: pnpm start
port: 3000
healthcheckPath: /api/health
env:
  mode: file
  file: .env.production
  requiredKeys:
    - DATABASE_URL
    - SESSION_SECRET
deploy:
  strategy: rebuild
  workingDirectory: /srv/fitness-app
```

## Slimmer manifest shape with Playbook defaults

When `--playbook-path` or `LIFELINE_PLAYBOOK_PATH` is supplied, Lifeline may source runtime defaults for the manifest archetype from `<playbook-path>/exports/lifeline/` and then apply explicit manifest values on top.

That allows a smaller manifest such as:

```yaml
name: runtime-smoke-app
archetype: node-web
repo: local-fixture
branch: main
```

This manifest is not valid on its own for manifest-only runtime execution. It becomes valid only after Playbook defaults are applied.

## Field intent

- `name`: stable app identifier used by operators.
- `archetype`: shared app model. v1 supports `next-web` and `node-web`.
- `repo`: source repository URL or clone target metadata.
- `branch`: default branch metadata.
- `projectPath`: optional subdirectory containing the runnable project.
- `installCommand`: command used to install dependencies.
- `buildCommand`: command used to build the app.
- `startCommand`: command used to start the app.
- `port`: expected listening port.
- `healthcheckPath`: HTTP path used for runtime health checks.
- `env.mode`: how environment variables are supplied. v1 supports `inline` and `file`.
- `env.file`: optional env file path when `mode` is `file`.
- `env.requiredKeys`: list of required environment variable keys after env-file values and shell env are merged.
- `deploy.strategy`: deployment strategy label. v1 supports `rebuild` and `restart`.
- `deploy.workingDirectory`: machine-local directory used by runtime flows. Relative paths resolve from the manifest file location.

## Resolution behavior

Playbook integration is optional and explicit.

Path precedence:

1. `--playbook-path <path>`
2. `LIFELINE_PLAYBOOK_PATH`
3. no Playbook path, which means manifest-only mode

Playbook export metadata contract:

- preferred/current: `{ "schemaVersion": <number|string>, "exportFamily": "lifeline-archetypes" }`
- legacy compatibility: `{ "version": <number> }`
- when both are present, `schemaVersion` is used
- when `exportFamily` is present, Lifeline accepts `lifeline-archetypes` (canonical) and `lifeline` (legacy compatibility), then normalizes to `lifeline-archetypes` internally

Merge precedence:

1. Playbook archetype defaults
2. overridden by explicit manifest values

The merge is intentionally small and predictable. Lifeline merges known manifest fields plus the nested `env` and `deploy` sections only.
Playbook archetype exports may omit `env` and `deploy` defaults; those requirements can come from either Playbook defaults or explicit manifest values.

## Validation vs runtime requirements

- `lifeline validate <manifest>` checks raw manifest structure only.
- `lifeline validate <manifest> --playbook-path <path>` validates the final resolved config.
- Lifeline validates the merged result, so optional producer sections (like Playbook `env` or `deploy` defaults) are not required in isolation.
- `lifeline resolve <manifest>` prints the fully resolved config Lifeline would execute.

Runtime commands are stricter and may additionally require:

- `deploy.workingDirectory` to exist on the current machine after resolution
- `env.file` to exist if declared after resolution
- every `env.requiredKeys` entry to be present after env merging
- runtime commands to succeed from the resolved working directory

This split keeps the shared contract stable while still allowing local execution to fail early and clearly when machine-local prerequisites are missing.

## Shared model for early targets

The fitness app and Playbook UI fit the same contract because Lifeline models operational needs, not product identity. Both apps need:

- a source repo
- a branch
- install/build/start commands
- a port
- a healthcheck path
- explicit environment expectations
- a deployment strategy
- a local working directory when run through the operator

Their manifests are examples and early targets. Their code is not embedded in this repository.

## Example manifests and fixtures

- [`examples/fitness-app.lifeline.yml`](../../examples/fitness-app.lifeline.yml)
- [`examples/playbook-ui.lifeline.yml`](../../examples/playbook-ui.lifeline.yml)
- [`fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml`](../../fixtures/runtime-smoke-app/runtime-smoke-app.lifeline.yml)
- [`fixtures/runtime-smoke-app/runtime-smoke-app.playbook.lifeline.yml`](../../fixtures/runtime-smoke-app/runtime-smoke-app.playbook.lifeline.yml)
- [`fixtures/playbook-export/exports/lifeline/archetypes/node-web.yml`](../../fixtures/playbook-export/exports/lifeline/archetypes/node-web.yml)
