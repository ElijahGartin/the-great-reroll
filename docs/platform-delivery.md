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

- `REGISTRY` and matching `CI_REGISTRY`: the registry's HTTPS host (on pi-lab,
  `zot.pi-lab.thunderrock.dev`). Registry access is HTTPS-only with system trust
  (platform-state#199). The release client follows no redirect and ignores
  environment proxies. The release refuses to start if `CI_REGISTRY_INSECURE`,
  `TRIVY_INSECURE`, `TRIVY_NON_SSL`, `SYFT_REGISTRY_INSECURE_USE_HTTP` or
  `SYFT_REGISTRY_INSECURE_SKIP_TLS_VERIFY` is present with any value, even
  empty or `false`: delete them from the pod template rather than setting them.
- `BUILDKIT_AMD64_ADDR`, `BUILDKIT_AMD64_NAME`, `BUILDKIT_ARM64_ADDR`, and
  `BUILDKIT_ARM64_NAME` for remote BuildKit addresses and TLS server names.
- `/certs/{ca.crt,tls.crt,tls.key}` for mTLS; `/signing/{cosign.key,cosign.pub,password}`
  for app-scoped signing. The password goes only into the cosign subprocess environment.
- Egress to public pinned tool downloads, vulnerability databases, source control,
  registry, and the two builders. Registry **push** uses the Jenkins
  `zot-ci-push` credential (`ZOT_USER` / `ZOT_PASS`). The Jenkinsfile requires
  this binding. When the release script is invoked independently, it can also
  read credentials from the builder pod's optional `DOCKER_CONFIG` mount (`DOCKER_CONFIG=/var/zot-docker-config`,
  secret key `.dockerconfigjson` at `config.json`). The Jenkins credential ID
  is a binding name; provision it with the War Table scoped publisher identity
  under [platform-state#388](https://github.com/ThunderRockTech/platform-state/issues/388).
  The earlier shared-identity proposal (#415) was closed without merging.
  Confirm credential delivery before publishing. `ci/release.py`
  builds a private temp `DOCKER_CONFIG` from the same resolved credentials for
  cosign sign/attest/verify only; BuildKit pushes use the remote builder's mount.
  Docker config lookup matches the exact registry hostname and optional port;
  credentials are never reused across ports. Helm login and push use a private
  temporary registry config that is removed on success or failure. Cleanup
  failure aborts the release; the ambient Helm credential config is untouched.

Delivery runs syntax checks, application tests, chart checks, CI failure-gate tests,
Gitleaks, and `platformManagedAppContractValidation`. SHA256-pinned tools build
both architectures natively through mTLS remote builders without privileged DinD.
Each immutable quarantine tag includes the full commit SHA and Jenkins build number.
The pipeline refuses existing image/chart tags instead of overwriting them.

The runtime copies only the official Node 24.21.0 binary and its full license
from a digest-pinned Debian 13 source image into a digest-pinned
[distroless CC Debian 13 image](https://github.com/GoogleContainerTools/distroless).
This retains the glibc runtime for both architectures and omits unused package
managers, shells, and OS administration tools. UID/GID 1000, the writable `/data`
directory, and Debian package/license metadata remain intact. Review both base
digests when updating Node or the OS; verify the distroless publisher signature
using its [documented identity](https://github.com/GoogleContainerTools/distroless#how-do-i-verify-distroless-images).
Use the Node-native maintenance commands in the [runbook](kubernetes.md).

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

Only after every verification and temporary credential cleanup succeeds is
`dist/release.json` written. Jenkins then archives that release record,
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
