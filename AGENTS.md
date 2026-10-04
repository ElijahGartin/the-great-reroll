<!-- BEGIN MANAGED APPLICATION CONTRACT -->
# Managed Application Instructions

This repository is managed by the DevSecOps platform.

Before changing build, deploy, Helm, Docker, runtime config, secrets,
dependency wiring, health checks, CI, startup behavior, or promotion behavior,
review:

- `docs/platform/managed-application-contract.md`
- `docs/platform/agent-review-checklist.md`
- `docs/platform/managed-application-onboarding.md`
- `.platform/application.yaml`

Every final AI agent response after contract-relevant changes must include:

```text
Contract impact: <what changed or "none">
Validation: <commands run and result>
Known gaps: <none, or explicit exceptions/follow-up>
```

Run the local contract gate before finalizing changes:

```bash
python3 scripts/validate_managed_app_contract.py \
  --repo-root . \
  --app-config .platform/application.yaml \
  --chart-path deploy/helm/war-table
```

Do not commit plaintext deployable credentials, mutable deployed image tags,
Pi-lab-only runtime assumptions, or auto-sync changes for environments whose
chart artifacts, image digests, runtime Secrets, storage classes, or dependency
endpoints do not exist.
<!-- END MANAGED APPLICATION CONTRACT -->
