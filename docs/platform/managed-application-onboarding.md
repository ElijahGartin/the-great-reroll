# Managed Application Onboarding

Use this guide when creating a new application repository or bringing an
existing application under the DevSecOps platform contract.

## What To Drop Into An App Repository

Start from the platform template:

```text
platform-core/templates/managed-app
```

The preferred path is to run the installer from the application repository root:

```bash
python3 /path/to/platform-core/scripts/install_managed_app_contract.py \
  --profile contract \
  --app-id my-app \
  --app-name "My App" \
  --owner my-team \
  --tier internal
```

Use `--tier external` for vendor or upstream integrations (for example Flamingo,
CIPP packaging) that mirror and pin artifacts instead of building product
source in the repository.

Use `--profile contract` for existing apps. It installs only the platform
instructions, metadata, docs, and validator. Use `--profile starter` for a new
app that should also receive the starter Dockerfile, Jenkinsfile, and Helm
chart skeleton.

Preview actions before writing files:

```bash
python3 /path/to/platform-core/scripts/install_managed_app_contract.py \
  --profile contract \
  --app-id my-app \
  --dry-run
```

Existing files are skipped by default. To refresh contract-managed files, use
`--overwrite --backup-existing` so the previous local copy is retained.
`AGENTS.md` is the exception: if it already exists, the installer appends a
marked managed-application contract section instead of replacing the file. A
later run will not append a duplicate section. If that marked section already
exists and you pass `--overwrite`, only the marked section is refreshed.

For a new app, copy the template contents into the app repository, then replace
placeholder values with real application values.

Required files:

```text
AGENTS.md
.platform/application.yaml
docs/platform/managed-application-contract.md
docs/platform/agent-review-checklist.md
scripts/validate_managed_app_contract.py
Jenkinsfile
chart/
Dockerfile
```

For an existing app, merge these files instead of replacing working app files:

- Add `AGENTS.md` if missing.
- Add `.platform/application.yaml` and fill in the real app id, chart name,
  images, ports, health paths, secrets, dependencies, and delivery mode.
- Add `docs/platform/managed-application-contract.md`.
- Add `docs/platform/agent-review-checklist.md`.
- Add `scripts/validate_managed_app_contract.py`.
- Add the Jenkins validation stage or call
  `platformManagedAppContractValidation`.
- Adapt the existing Helm chart and Dockerfiles until the validator passes.

## Required Local Validation

Run this from the app repository root:

```bash
python3 scripts/validate_managed_app_contract.py \
  --repo-root . \
  --app-config .platform/application.yaml \
  --chart-path chart
```

The app is not platform-ready until this command passes and any app-specific
tests needed by the change also pass.

## Optional: Cursor SDK pack

After the contract pack is installed and validating, applications may install
the Cursor SDK runner for batch coding-agent tasks (tests, contract fixes,
features):

```bash
python3 /path/to/platform-core/scripts/install_managed_app_contract.py \
  --profile cursor-sdk \
  --chart-path charts/my-app
```

See `docs/contracts/cursor-sdk-onboarding.md` and, in each app repo after
install, `docs/platform/cursor-sdk-onboarding.md`.

## Prompt For A New App Repository

Use this prompt when asking an AI agent to prepare a new app repository:

```text
This repository must comply with the DevSecOps managed application contract.

First read:
- AGENTS.md
- .platform/application.yaml
- docs/platform/managed-application-contract.md
- docs/platform/agent-review-checklist.md

Then inspect the app structure, Dockerfiles, Helm chart, Jenkinsfile, runtime config, secrets, and dependency assumptions.

Make the repository compliant with the contract. Preserve the app's existing architecture where reasonable. Do not introduce plaintext secrets. Do not use mutable deployed image tags. Make Kubernetes deployment environment-driven and portable across Pi-lab, on-prem Kubernetes, and cloud Kubernetes.

Run:
python3 scripts/validate_managed_app_contract.py --repo-root . --app-config .platform/application.yaml --chart-path chart

Fix contract violations until validation passes. Final response must include:
Contract impact:
Validation:
Known gaps:
```

## Prompt For An Existing App

Use this prompt when asking an AI agent to retrofit an existing app:

```text
Review this app for DevSecOps platform compliance.

Read the platform files first:
- AGENTS.md
- .platform/application.yaml
- docs/platform/managed-application-contract.md
- docs/platform/agent-review-checklist.md

Then identify gaps in:
- Dockerfiles
- Helm chart
- image digest support
- health probes
- metrics
- resource requests and limits
- security contexts
- secret references
- environment-specific config
- dependency ownership
- Jenkins promotion readiness
- blue/green readiness if applicable

Implement the smallest safe changes needed to pass the managed app contract validator. Do not rewrite unrelated application code.

Run the validator and any relevant existing tests. Final response must include:
Contract impact:
Validation:
Known gaps:
```

## How To Review AI Agent Output

The final agent response must include:

```text
Contract impact: <what changed or "none">
Validation: <commands run and result>
Known gaps: <none, or explicit exceptions/follow-up>
```

Reject or send back any change that:

- Omits the validator result.
- Introduces plaintext deployable credentials.
- Uses mutable deployed image tags such as `latest`, or publishes `:latest` from
  Jenkins/`ci/publish.sh` instead of immutable build tags or digests.
- Requires `localhost`, `host.docker.internal`, or live-code volumes in
  Kubernetes.
- Hardcodes Pi-lab-only infrastructure outside environment values.
- Enables auto-sync before chart artifacts, image digests, runtime Secrets,
  storage classes, and dependency endpoints exist for the target environment.

## Ongoing Maintenance

Keep these files aligned whenever the platform contract changes:

- `docs/platform/managed-application-contract.md`
- `docs/platform/agent-review-checklist.md`
- `.platform/application.yaml`
- `scripts/validate_managed_app_contract.py`
- Jenkins validation stage

The platform contract is useful only if app repositories carry the local agent
instructions and CI continues to enforce the validator.

## Distribution Model

Keep the contract pack in `platform-core` while the platform and first managed
applications are still changing together. This keeps one owner for the contract,
validator, Jenkins wrapper, and app template.

Create a separate contract-pack repository later when app teams need independent
versioning or when application repositories should consume the contract without
having access to the full platform bootstrap repository. Prefer a release
archive or installer script over a Git submodule for most app repos:

- Release archive: simple for app teams, easy to pin by version, no submodule
  workflow burden.
- Git submodule: useful only when strict source pinning is worth the extra Git
  complexity.
- Vendored copy: best for AI agents because `AGENTS.md`, docs, and validator are
  present locally every time the repository is opened.
