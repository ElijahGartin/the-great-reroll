# Managed Application Contract

Version: 1.0

This contract defines how an application repository must behave when it is
managed by the DevSecOps platform. It is written for application teams, human
reviewers, and AI agents. The intent is to keep app delivery portable across
Pi-lab, other on-prem Kubernetes clusters, and cloud Kubernetes targets.

## Platform Boundary

- Application repositories own source code, tests, production Dockerfiles, and
  deployable Helm chart source.
- Jenkins owns build, test, scan, sign, publish, and promotion automation.
- The artifact registry boundary owns immutable images, Helm charts, SBOMs,
  signatures, and attestations.
- `platform-state` owns environment values, release intent, Argo CD
  Applications, and GitOps-managed secret references.
- Argo CD is the only deployment engine after bootstrap.

Application repositories must not require cluster-local manual edits, stale
resources from an older cluster install, or Pi-lab-specific infrastructure
unless the application is explicitly Pi-lab-only.

## Application tier

Set `application.tier` in `.platform/application.yaml`:

| Tier | Meaning | Repo owns | CI emphasis |
|------|---------|-----------|-------------|
| `internal` | First-party apps you develop (ProSeAi, ReportingHub, TheGame, UTools) | Source, tests, Dockerfiles, chart | Build, test, scan, sign, publish from source |
| `external` | Vendor or upstream products you integrate (CIPP ops packaging, Flamingo/OpenFrame) | Integration chart, pinned versions, runbooks | Mirror, verify, scan, sign pinned artifacts; vendor-bump PRs |
| `public` | Customer-facing workloads with stricter exposure controls | Same as internal unless noted | Same as internal plus exposure review |
| `critical` | Production-critical workloads | Same as internal unless noted | Same as internal plus elevated change control |

`external` repositories still use the same GitOps promotion path (`platform-state`
release intent, Argo CD deploy). They differ in **supply chain**: pin upstream
versions, mirror images and charts into the internal registry, and document
exceptions (for example temporary vendor CLI bootstrap) instead of treating
upstream source as owned application code.

## Required Repository Files

Each managed app repository must include:

- `AGENTS.md`: points agents and humans at this contract before touching build,
  deploy, runtime, secret, or dependency behavior.
- `.platform/application.yaml`: machine-readable application contract metadata.
- `Jenkinsfile`: runs the platform contract validation gate before promotion.
- Production Dockerfiles for every deployable runtime image.
- A Helm chart that can be rendered by Argo CD using environment values and
  release-intent values.

## Artifact Contract

Every release must publish:

- OCI runtime images for all deployable components.
- Multi-architecture images for `linux/amd64` and `linux/arm64` unless an
  exception is approved in `.platform/application.yaml`.
- An OCI Helm chart published to the target environment's registry boundary.
- SBOMs for runtime images and chart contents.
- Signatures and provenance or attestation artifacts for released images and
  charts.

Deployed workloads must use immutable image digests. Mutable `latest` tags and
implicit-latest image references are not allowed in Kubernetes or Helm output.

Jenkins publish automation must push only immutable tags (for example
`${BUILD_NUMBER}`) or digest-pinned references. Retagging or pushing mutable
`:latest`, including `for tag in "${BUILD_NUMBER}" latest` loops, is forbidden.
Promotion records `sha256` digests in `platform-state`; registry tags are
build metadata, not deployment pins.

## Release Intent Contract

Applications do not edit generated Argo CD `Application` manifests directly.
Promotion records release metadata in `platform-state` release intent:

- DNS-label style `application` id.
- DNS-label style `environment` id.
- SemVer `chartVersion`.
- Immutable `sha256:<64 hex chars>` image digests.
- Optional `activeLane` with only `blue` or `green`.

The same chart version and image digests move upward through environments.
Environment values, secrets, and datacenter metadata may vary.

## Helm Chart Contract

The chart must:

- Accept release-intent values as a Helm values file.
- Accept environment-specific values as a Helm values file.
- Support image digest deployment instead of requiring mutable tags.
- Expose all runtime configuration through values or Secret references.
- Avoid hardcoded hostnames, IPs, storage classes, namespaces, and controller
  annotations except through environment values.
- Include liveness and readiness probes for each long-running workload.
- Include explicit resource requests and limits.
- Include pod and container security context defaults.
- Avoid `hostPath`, `hostNetwork: true`, and other node-coupled assumptions
  unless the contract metadata declares a reviewed exception.

For blue/green capable environments, the chart must use a lane value such as
`releaseIntentLane` so the same namespace can hold separate blue and green
workloads without ambiguity.

## Runtime Contract

Applications must expose:

- Liveness endpoint: `/api/health/liveness` by default.
- Readiness endpoint: `/api/health/readiness` by default.
- Metrics endpoint: `/metrics` by default.

Different paths are allowed only when declared in `.platform/application.yaml`
and wired into the chart probes and ServiceMonitor or scrape configuration.

Containers must:

- Run as non-root.
- Disable privilege escalation.
- Drop Linux capabilities by default.
- Use a read-only root filesystem where feasible.
- Handle SIGTERM cleanly within the configured termination grace period.
- Keep development reload flags, live-code volumes, `localhost`, and
  `host.docker.internal` out of Kubernetes deployments.

## Configuration Contract

Application images must be environment-neutral. Environment-specific behavior
belongs in:

- `platform-state` values files.
- Release-intent files.
- Kubernetes Secret references.
- ExternalSecret resources where the target environment supports them.

Do not bake public URLs, issuer URLs, database DSNs, bucket names, queue vhosts,
CORS origins, or credential material into images.

## Secret Contract

Plaintext deployable credentials must never be committed.

Allowed patterns:

- SOPS-encrypted Kubernetes Secret manifests for static, PR-reviewable GitOps
  material.
- External Secrets Operator resources referencing an approved backend such as
  Vault.
- Out-of-band pre-created Kubernetes Secrets only when the app is explicitly
  manual/deferred until those Secrets exist.

Each Secret reference must define:

- Kubernetes Secret name.
- Required keys.
- Owning environment or backend path.
- Rotation owner.
- Whether the app can start without the Secret.

## Dependency Contract

Every dependency must have an ownership model:

- App-owned chart dependency for that environment.
- External managed service referenced through a Kubernetes Secret contract.
- Platform shared-service profile with documented storage, backup, secret, and
  capacity requirements.

Do not assume CloudNativePG, Redis, RabbitMQ, MinIO, Keycloak, Longhorn, Harbor,
or observability services are present merely because a cluster exists.

## Environment Contract

Supported delivery modes:

- `single`: one deployed lane, normally for local development.
- `blue-green`: blue and green lanes with traffic cutover outside the app.
- `single-and-blue-green`: single lane in lower environments and blue/green in
  public or production-like environments.

Applications must support backward-compatible expand/contract database changes
before blue/green is used for schema-changing releases.

## Agent Review Contract

Before an AI agent changes build, deploy, Helm, Docker, startup, runtime config,
secret, dependency, CI, or promotion behavior, it must review:

- This contract.
- `.platform/application.yaml`.
- The app's root `AGENTS.md`.

Every final agent response for app repository changes must include:

- Contract impact.
- Validation commands run.
- Known contract gaps or exceptions.

## Exceptions

Exceptions must be explicit, small, owned, and reviewed. Record them in
`.platform/application.yaml` with:

- Contract requirement.
- Justification.
- Owner.
- Review date.
- Expiration or revalidation date.

Do not hide exceptions in code comments, chart templates, or Jenkinsfile logic.
