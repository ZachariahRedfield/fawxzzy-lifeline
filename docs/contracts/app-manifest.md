# Lifeline app manifest contract

Lifeline manifests are YAML files that describe a deployable application using one shared model.

## Supported archetypes

- `next-web`
- `node-web`

## YAML shape

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
  required:
    - DATABASE_URL
    - SESSION_SECRET
deploy:
  strategy: rebuild
  workingDirectory: /srv/fitness-app
```

## Field intent

- `name`: stable app identifier used by operators.
- `archetype`: shared app model. v1 supports `next-web` and `node-web`.
- `repo`: source repository URL or clone target.
- `branch`: default branch to deploy from.
- `projectPath`: optional subdirectory containing the runnable project.
- `installCommand`: command used to install dependencies.
- `buildCommand`: command used to build the app.
- `startCommand`: command used to start the app.
- `port`: expected listening port.
- `healthcheckPath`: HTTP path used for runtime health checks later.
- `env.mode`: how environment variables are supplied. v1 supports `inline` and `file`.
- `env.file`: optional env file path when `mode` is `file`.
- `env.required`: list of required environment variable keys.
- `deploy.strategy`: deployment strategy label. v1 supports `rebuild` and `restart`.
- `deploy.workingDirectory`: optional machine-local directory used by future runtime flows.

## Shared model for Fitness and Playbook UI

The fitness app and Playbook UI fit the same contract because Lifeline models operational needs, not product identity. Both apps need:

- a source repo
- a branch
- install/build/start commands
- a port
- a healthcheck path
- explicit environment expectations
- a deployment strategy

That shared shape is the point of Lifeline v1.

## Example manifests

- [`examples/fitness-app.lifeline.yml`](../../examples/fitness-app.lifeline.yml)
- [`examples/playbook-ui.lifeline.yml`](../../examples/playbook-ui.lifeline.yml)
