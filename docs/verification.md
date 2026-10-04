# Deployment verification — 2026-10-03

This records tests of the implementation on branch `feat/persistent-multiplayer`. It does not describe a deployment to the owner's live infrastructure.

## Automated checks

- `npm run check`: browser/data/server/test/script JavaScript syntax passed.
- `npm test`: **46 tests passed**, including both game modes, roster feasibility, timers, independent guest permissions, stale/concurrent/idempotent commands, restart recovery, cookie/Origin boundaries, input limits, seat removal, export redaction/formula protection, UI retries/escaping, WAL-aware backups, and private-data-free metrics.
- The same 46 tests passed as UID 1000 under the pinned Node **24.21.0** container runtime (`NODE_ENV=test` for the test fixtures; production HTTPS startup behavior is explicitly tested).
- Helm lint, rendered security/storage checks, and invalid configuration rejection tests passed.
- Images built for **linux/amd64 and linux/arm64**. The running arm64 image reported Node 24.21.0, SQLite 3.53.4, and UID 1000. Its root filesystem was read-only and all capabilities dropped.
- An independent review found no unresolved code issues after fixes and re-review.
- GitOps delivery adds **10 passing failure-gate tests**. The exact Node 24.21.0 / Debian Python 3.11.2 agent passed pinned-tool installation, full PyYAML contract validation, and these delivery tests on both supported architectures.
- The exact CI container smoke script passed: seed a paused game, restart the hardened container with a retained volume, recover both seats/state, finish, and export results. Its temporary resources and credentials were removed.

## Browser checks

Two isolated Chromium contexts used the actual UI, with distinct cookies and guest seats:

- Created and joined a Guild Roster room, marked both guests ready, completed race/role and class/spec stages, paused, reloaded, recovered, resumed, and exported matching CSV/JSON results.
- Completed Deal Everyone with individual defense allocation, a server-resolved successful steal, passing, and final picks. Exported results matched the resulting hands.
- Inspected the mobile layout at 390 × 844. No console errors/warnings were observed in the multiplayer completion view or legacy home page.
- Confirmed legacy character data and Deal Everyone engine still load, and the home page links to the real multiplayer screen.

These were separate browser contexts on one workstation, not physical-device or final-hostname tests.

## Isolated Kubernetes exercise

A disposable **kind v0.33.0 / Kubernetes v1.37.0** cluster was created with its own kubeconfig. No existing cluster context or live workload was used.

1. Loaded the built image and installed the Helm chart with production mode, an HTTPS origin, read-only root filesystem, non-root UID, probes, and a persistent volume. Pod and PVC became ready.
2. Created a two-player specialization draft through HTTP, committed a pick, and paused the room.
3. Took an online SQLite backup and verified its integrity.
4. Replaced the application pod. Verified the exact committed game state, room revision, both guest credentials, and progress export survived.
5. Restored the backup into a **new empty PVC** using a separate non-root maintenance pod. Verified database integrity and switched the deployment to the new claim.
6. Verified saved state and guest credentials again, then resumed and finished the restored game. Final JSON and CSV exports passed their assertions.

The test used kind's non-CSI `standard` provisioner with the chart's explicit **ReadWriteOnce** compatibility setting. It therefore validates application/storage recovery and the chart lifecycle, but does not validate a production driver's **ReadWriteOncePod** exclusivity. The chart defaults to RWOP for compatible CSI storage.

The disposable cluster, containers, test volumes, private test credentials, and temporary backups were removed after verification. Local multi-architecture images remain tagged `war-table:local` and `war-table:ci`; neither was pushed to a registry.

## Production environment checks

The [deployment runbook](kubernetes.md) specifies the image, values, storage requirements, backup/restore, and rollback procedure. Before admitting users on the real environment, validate its registry pull permissions, CSI access mode and locking, HTTPS origin/certificate/ingress routing, and separate physical devices over the final hostname. Workload capacity and high availability were not tested or promised: this is a single-replica release with upgrade downtime and configurable limits.

Saved rooms default to 30 days of inactivity. Hosts explicitly pause timed games and transfer hosting when needed. There is no automatic host takeover or credential reset; the [user guide](../README.md#play-and-return-later) documents recovery and lost-credential behavior.

## Minimal runtime verification — 2026-10-04

The runtime now uses the same Node 24.21.0 binary on digest-pinned distroless
CC Debian 13. The publisher signature of the exact distroless index was verified
with its documented Google identity and transparency-log verification.

- Local AMD64 and ARM64 builds each passed all 46 tests as UID 1000, with a
  read-only root filesystem, all capabilities dropped, and no privilege escalation.
- Trivy 0.71.0 identified Debian 13.7 and 14 OS packages in each complete image;
  both passed the HIGH/CRITICAL gate without exclusions or ignoring unfixed findings.
- The full Node license and Debian package metadata remain in the runtime.
- Syft 1.18.1 identified Node 24.21.0, all 14 Debian packages, and the application
  in both SPDX SBOMs.
- The ARM64 runtime passed the paused-game seed, container restart, seat recovery,
  completion, and JSON/CSV export smoke test. It reported SQLite 3.53.4 and
  UID 1000; `/data` remained owned by UID 1000.
- The shell-free backup/restore runbook commands passed against the same runtime:
  byte-identical restore, UID 1000/mode 0600, existing-file refusal, and cleanup
  of a corrupt transfer. Disposable containers and volumes were removed.

These local checks do not replace the signed Jenkins release or verification of
its final immutable digests in the target cluster.
