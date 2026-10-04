# Agent Review Checklist

Use this checklist whenever an AI agent or human reviewer changes a managed
application repository, `platform-core`, or `platform-state` in a way that can
affect the application contract.

## Before Editing

- Read `AGENTS.md` in the target repository.
- Read `.platform/application.yaml` for the target application, if present.
- Read `docs/contracts/managed-application-contract.md` or the app-local synced
  copy under `docs/platform/`.
- Identify whether the change affects build, image publication, Helm, runtime
  startup, health checks, secrets, dependencies, promotion, or rollback.

## Required Review Questions

- Does the change preserve immutable image digest deployment?
- Does the chart still render without Pi-lab-specific hardcoding?
- Are liveness, readiness, and metrics endpoints still accurate?
- Are runtime credentials represented only as Secret references or approved
  ExternalSecret/SOPS resources?
- Are resource requests, limits, and security contexts still present?
- Is the dependency ownership model still explicit?
- If blue/green is supported, are database and queue changes backward
  compatible during lane overlap?
- Does promotion still move the same chart version and image digests upward?

## Required Validation

Run the managed app contract validator before opening or finalizing a PR:

```bash
python3 scripts/validate_managed_app_contract.py \
  --repo-root . \
  --app-config .platform/application.yaml \
  --chart-path chart
```

App repositories may call the same validation through Jenkins using the
`platformManagedAppContractValidation` shared-library step.

## Final Response Format For Agents

Every final response after contract-relevant app changes should include:

```text
Contract impact: <what changed or "none">
Validation: <commands run and result>
Known gaps: <none, or explicit exceptions/follow-up>
```

## Red Flags

Stop and fix or escalate if the change introduces:

- Plaintext deployable credentials.
- `latest` or implicit-latest runtime image references.
- Jenkins or `ci/publish.sh` steps that push, retag, or loop over mutable
  `:latest` instead of immutable build tags or digests.
- `localhost`, `host.docker.internal`, or live-code volume requirements in
  Kubernetes deployments.
- Chart templates that depend on stale namespaces, node-local paths, or
  Pi-lab-only services.
- Auto-sync for an app whose chart, image digests, Secrets, storage classes, or
  dependency endpoints do not exist in the target environment.
