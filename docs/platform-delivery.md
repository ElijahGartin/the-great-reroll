# Platform delivery

Jenkins is the release authority. The platform-state `war-table-builder` pod template
supplies the pinned Node runtime, registry address, mTLS BuildKit endpoints, and an
app-specific encrypted signing key. This public repository contains no private
infrastructure addresses or credentials.

The job must load this Jenkinsfile exclusively from trusted `main`, never a PR or
arbitrary user-supplied revision. `ci/trusted-main.sh` rejects change-request builds,
requires an explicit main branch and valid build number, and compares the checkout
with Jenkins' source revision and the current remote main SHA. The guard runs again
immediately before release work. A newer main commit therefore supersedes an older
queued build. These guards complement the job's trusted-source configuration; they
cannot protect a signing key from an attacker allowed to rewrite the Jenkinsfile.

The platform agent supplies:

- `REGISTRY` and matching `CI_REGISTRY`, with `CI_REGISTRY_INSECURE=true` only for a
  platform-approved plain HTTP registry.
- `BUILDKIT_AMD64_ADDR`, `BUILDKIT_AMD64_NAME`, `BUILDKIT_ARM64_ADDR`, and
  `BUILDKIT_ARM64_NAME` for remote BuildKit addresses and TLS server names.
- `/certs/{ca.crt,tls.crt,tls.key}` for mTLS; `/signing/{cosign.key,cosign.pub,password}`
  for app-scoped signing. The password goes only into the cosign subprocess environment.
- Egress to public pinned tool downloads, vulnerability databases, source control,
  registry, and the two builders. Registry access currently uses the platform's
  anonymous network-restricted profile; authenticated registries require explicit
  credential integration before use.

Delivery runs syntax checks, application tests, chart checks, CI failure-gate tests,
Gitleaks, and `platformManagedAppContractValidation`. SHA256-pinned tools build
both architectures natively through mTLS remote builders without privileged DinD.
Each immutable quarantine tag includes the full commit SHA and Jenkins build number.
The pipeline refuses existing image/chart tags instead of overwriting them.

Trivy must pass HIGH/CRITICAL checks on **each child image digest**. Syft generates
one SPDX SBOM per architecture and one for the packaged chart contents. The SBOM
manifest binds these artifacts to their immutable OCI digests and the source SHA.
The final image index contains both verified architecture descriptors; Kubernetes
selects the child matching its node architecture.

Cosign signs the image index and chart OCI digest, attaches SPDX and SLSA v1
provenance attestations, and verifies them using the reviewed `ci/cosign.pub` key.
The mounted public key must match that source-controlled key. Verification
requires the released subject digest and this build's exact predicates. This is
private-key signing without public transparency-log publication; it does not claim
keyless identity, public-log inclusion, or a SLSA certification level. Preserve and
rotate the signing key through platform-state's encrypted-secret workflow.

Only after every verification succeeds does Jenkins archive `dist/release.json`,
the chart package, SBOMs, reports, and provenance. The release record includes
`chartVersion`, `imageDigest`, `chartDigest`, `sourceSHA`, and the SBOM manifest hash.
Chart versions are `1.0.0-ci.<build>.g<short-sha>`. A failed build can leave quarantine
artifacts but cannot produce a new release record. Registry retention must preserve
all released digests and their signature/attestation tags.

Promotion consumes that verified Jenkins artifact in a platform-state pull request.
This pipeline does not edit platform-state or invoke Kubernetes/Argo CD. Enable
reconciliation only after the image/chart, persistent storage, and required Secret
references exist. Rollback selects a prior verified release record and respects
SQLite schema compatibility and the single-writer deployment contract.

Local delivery checks:

```sh
python3 -m unittest discover -s tests/ci -v
bash -n ci/trusted-main.sh scripts/ci/provision-tools.sh
python3 -m py_compile ci/release.py ci/install-tools.py
python3 scripts/validate_managed_app_contract.py --repo-root . \
  --app-config .platform/application.yaml --chart-path deploy/helm/war-table
```

A live Jenkins run remains the integration proof for tool downloads, mTLS builder
access, registry artifact support, vulnerability databases, and signing key mounts.
