# Kubernetes deployment

The application serves the browser and multiplayer API from one Node.js 24 container. Rooms, guest-seat credentials, game state, and completed results live in `/data/rooms.sqlite`. The server commits accepted actions before acknowledging them. Browser clients poll the same origin; no WebSocket routing or sticky sessions are required. Saved games survive pod replacement when the PVC remains intact.

This is a **single-writer deployment with brief downtime during upgrades**. The chart uses one replica and `Recreate`; `maintenanceMode: true` temporarily stops that writer for restore work. Do not add an HPA, scale it above one, or run a second release against the same claim. This release does not offer high availability or cross-region replication.

Managed deployments follow **git → PR → validation → merge → Argo CD**. The application repository owns source, Dockerfile, and chart; Jenkins owns release builds, security gates, SBOMs, signatures, attestations, and immutable artifact publication. `platform-state` owns environment values, Secret references, release intent, and Argo CD Applications. See the [managed application contract](platform/managed-application-contract.md). Local build examples below do not publish or deploy a release.

## Requirements

- Kubernetes 1.29+ and Helm 3 or 4. CI uses Helm 4.3.0.
- A CSI storage class supporting `ReadWriteOncePod`, filesystem mounts, UID/GID 1000, and POSIX locking. Use block-backed persistent storage formatted with a local filesystem, such as ext4 or XFS; **do not use NFS/SMB or shared network filesystems** for SQLite WAL.
- An ingress controller or equivalent HTTPS reverse proxy, a real hostname, and a TLS certificate/Secret. Provision these through your cluster's normal processes. The chart does not install an ingress controller or certificate manager.
- Signed, immutable runtime images and OCI chart artifacts published by Jenkins and accessible to the cluster. GitHub PR checks validate changes; they do not publish releases. Missing signing or other release prerequisites block promotion.

`ReadWriteOncePod` limits access to one pod and requires CSI support. `ReadWriteOnce` only restricts mounting to one node and can still admit multiple pods on that node. Set `persistence.accessMode=ReadWriteOnce` only after confirming the storage driver cannot use RWOP and arranging operational single-writer enforcement. See [Kubernetes persistent-volume access modes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes) and [SQLite WAL filesystem requirements](https://sqlite.org/wal.html).

## Build and validate

From the repository root:

```sh
npm run check
npm test
node scripts/check-chart.cjs
helm lint deploy/helm/war-table --set publicOrigin=https://game.example.invalid
docker build -t war-table:local .
```

For an explicitly isolated local kind test cluster, load the local image with `kind load docker-image war-table:local --name YOUR_LOCAL_TEST_CLUSTER`. Local image tags are for disposable tests only. Managed deployments use the Jenkins release pipeline, which publishes multi-architecture runtime images and a versioned OCI chart after the required gates pass. Do not bypass that pipeline with a manual registry push.

## Configure and reconcile

Store environment values in the private `platform-state` repository, not in this public application repository or an untracked operational file. Keep credential material in approved SOPS/ExternalSecret delivery and reference the resulting Secrets. Replace every placeholder in this environment-values example:

```yaml
images:
  app:
    repository: registry.example.invalid/your-team/war-table
publicOrigin: https://games.example.invalid
roomTtlDays: 30
maxRooms: 1000
persistence:
  storageClass: your-block-storage-class
  size: 5Gi
  accessMode: ReadWriteOncePod
ingress:
  enabled: true
  className: your-ingress-class
  host: games.example.invalid
  tlsSecretName: your-existing-tls-secret
```

Jenkins promotion records the published chart version and image digest in `platform-state` release intent. The chart consumes `images.app.digest`; environment values supply `images.app.repository`. Validate both files together. Enable reconciliation only after image/chart artifacts, registry credentials, TLS Secrets, storage, and other declared prerequisites exist. Do not invent placeholder deployment digests or enable auto-sync while prerequisites are missing.

The chart deliberately rejects a missing or non-HTTPS `publicOrigin`, multiple replicas, invalid resource values, and an ingress missing TLS settings. Use only the origin (no path or trailing slash); it must match the browser's HTTPS origin and ingress host. Keep the backend Service private. If another proxy supplies TLS, leave chart ingress disabled and route that proxy to Service port 80. Configure the edge to redirect HTTP to HTTPS and apply per-client request rate limits appropriate for private groups. The application intentionally ignores forwarded IP headers: its `RATE_LIMIT_PER_MINUTE` limit is per direct socket peer, so an ingress can share that limit across many guests. Tune the aggregate backend limit for your proxy and enforce individual-client limits at the trusted ingress.

These commands render locally; set the paths to the intended files in your private `platform-state` checkout:

```sh
ENVIRONMENT_VALUES='/path/to/platform-state/environment-values.yaml'
RELEASE_INTENT='/path/to/platform-state/release-intent/war-table/test.json'
helm lint deploy/helm/war-table -f "$ENVIRONMENT_VALUES" -f "$RELEASE_INTENT"
helm template games deploy/helm/war-table -n war-table \
  -f "$ENVIRONMENT_VALUES" -f "$RELEASE_INTENT"
```

Run the required `platform-state` validators, review the rendered resources and release artifacts, and merge the approved change through its PR gates. Argo CD reconciles the committed desired state. Verify its sync/health status, the rollout, and the smoke checks below using the actual release name, namespace, and explicitly selected kube context. Do not run imperative Helm install/upgrade commands against a managed environment. Rendered output can contain private infrastructure details; keep it out of public logs and commits.

Additional chart limits map directly to server environment variables:

| Value | Environment variable | Default |
| --- | --- | --- |
| `roomTtlDays` | `ROOM_TTL_DAYS` | 30 |
| `maxRooms` | `MAX_ROOMS` | 1000 |
| `maxCommandsPerRoom` | `MAX_COMMANDS_PER_ROOM` | 20000 |
| `maxBodyBytes` | `MAX_BODY_BYTES` | 16384 |
| `rateLimitPerMinute` | `RATE_LIMIT_PER_MINUTE` | 3600 |
| `lobbyTtlDays` | `LOBBY_TTL_DAYS` (rooms that never started; capped at `roomTtlDays`) | 7 |
| `roomCreatesPerHour` | `ROOM_CREATES_PER_HOUR` (per client) | 20 |
| `maxDbBytes` | `MAX_DB_BYTES` (new rooms and lobby changes stop at 80%, started games at 100%; keep well below the PVC size if backups share it) | 2147483648 |
| `commandHistoryPerSeat` | `COMMAND_HISTORY_PER_SEAT` (idempotency replay records kept per seat) | 16 |
| `trustProxy` | `TRUST_PROXY` (`""` or `cloudflare`) | `""` |

`trustProxy: cloudflare` keys the API and room-creation limits on `CF-Connecting-IP`. Enable it only when NetworkPolicy admits the Cloudflare tunnel connector as the sole client of port 3000 (plus monitoring, which does not call `/api/`); otherwise any in-cluster caller could choose its own rate-limit identity. The chart refuses it unless `networkPolicy.enabled` or `networkPolicy.externallyManaged` (an environment-owned equivalent policy) is true. IPv6 clients are limited per /64. The server serves only canonical request paths, so a path-routing proxy cannot reach `/metrics`, `/healthz` or `/readyz` through dot-segments.

The pod runs as UID/GID 1000 with a read-only root filesystem, all Linux capabilities dropped, no privilege escalation, RuntimeDefault seccomp, no service-account token, and a writable PVC plus bounded `/tmp`. Requests and limits are configurable; defaults are starting points, not a measured capacity promise.

Optional `networkPolicy.enabled=true` denies all egress and permits port 3000 only from pods matching **both** `ingressNamespaceLabels` and `ingressPodLabels`. Supply your controller's actual labels; an empty selector is rejected. Confirm your CNI enforces policies and check controller/health-probe behavior before enabling. The application has no runtime network dependency. Do not expose `/data` or mount it into web-serving sidecars.

## Persistence and backups

The PVC has `helm.sh/resource-policy: keep` and `argocd.argoproj.io/sync-options: Prune=false,Delete=false`: Helm uninstall, Argo pruning, and Argo Application deletion retain the claim. If a retained claim leaves the desired manifests, Argo reports it as OutOfSync until its ownership is reconciled. Preserve the containing namespace as well; these annotations do not protect against namespace deletion or a direct Kubernetes deletion. See [Argo resource retention](https://argo-cd.readthedocs.io/en/release-3.3/user-guide/sync-options/#no-prune-resources). This is not a backup; deleting the claim may still destroy its volume under the storage class's reclaim policy. To reuse a retained/restored claim, set `persistence.existingClaim` to its name. PVC access mode and storage class generally cannot be changed in place; migrate to a separately provisioned claim instead.

The runtime image contains Node.js but no shell, tar, npm, rm, chmod, or sleep. Use explicit Node commands for maintenance; `kubectl cp` requires tar and does not work with this image.

Run the transfer commands from an operator machine with Node.js 24.21.0 or a compatible newer version for the local SQLite integrity check. Use the included backup command while the server is running. It uses [Node's SQLite online backup API](https://nodejs.org/api/sqlite.html#sqlitebackupsourcedb-path-options), then checks the copy with `PRAGMA integrity_check`. It preserves committed WAL data and refuses to overwrite an existing destination. Never copy only the active `.sqlite` file: committed data can still be in its WAL.

```sh
# Use a fresh filename; this example assumes release games in namespace war-table.
BACKUP_NAME="rooms-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
POD=$(kubectl -n war-table get pods -l app.kubernetes.io/instance=games \
  -o jsonpath='{.items[0].metadata.name}')
kubectl -n war-table exec "$POD" -- node scripts/backup.cjs "/data/$BACKUP_NAME"
# Run in bash or zsh; pipefail preserves a failed remote download status.
set -o pipefail
kubectl -n war-table exec "$POD" -- node -e '
  const {pipeline}=require("node:stream/promises");
  pipeline(require("node:fs").createReadStream(process.argv[1]),process.stdout)
    .catch(e=>{console.error(e.message);process.exitCode=1});
' "/data/$BACKUP_NAME" | node -e '
  const fs=require("node:fs"); const {pipeline}=require("node:stream/promises");
  const {DatabaseSync}=require("node:sqlite"); const p=process.argv[1];
  (async()=>{
    const fd=fs.openSync(p,"wx",0o600);
    try {
      await pipeline(process.stdin,fs.createWriteStream(p,{fd}));
      if(fs.statSync(p).size===0)throw Error("Empty backup");
      const d=new DatabaseSync(p,{readOnly:true});
      let r; try {r=d.prepare("PRAGMA integrity_check").all()} finally {d.close()}
      if(r.length!==1||r[0].integrity_check!=="ok")throw Error("Invalid backup");
    } catch(e) {fs.unlinkSync(p);throw e}
  })().catch(e=>{console.error(e.message);process.exitCode=1});
' "./$BACKUP_NAME"
# Continue only after the pipeline succeeds and the backup is securely copied
# to off-cluster storage. The receiver refuses to replace an existing file.
kubectl -n war-table exec "$POD" -- node -e \
  'require("node:fs").unlinkSync(process.argv[1])' "/data/$BACKUP_NAME"
```

Keep backup files private and encrypt off-cluster copies. They contain room metadata, game state, and credential hashes. Schedule and monitor backups through your existing backup platform; alert on failure and test restores. Reserve enough PVC space for a temporary second database. Results CSV/JSON exports are useful records, but are **not** database backups and cannot restore guest seats or unfinished rooms.

## Restore drill

Restore into a **new, empty PVC**, keeping the original volume for rollback. Use the same application version that created the backup first. Verify the backup locally with Node 24:

```sh
node -e 'const {DatabaseSync}=require("node:sqlite"); const d=new DatabaseSync(process.argv[1],{readOnly:true}); const r=d.prepare("PRAGMA integrity_check").all(); d.close(); if(r.length!==1||r[0].integrity_check!=="ok")process.exit(1); console.log("integrity ok")' ./rooms-backup.sqlite
```

1. Provision a new filesystem PVC through your storage workflow with the required size and access mode. Do not reuse a directory containing old `rooms.sqlite-wal` or `rooms.sqlite-shm` files.
2. Commit `maintenanceMode: true` in the application's environment values and wait for Argo CD to reconcile zero replicas and terminate its pod before switching storage. This intentionally pauses all games. On platform-managed clusters, commit and reconcile the temporary maintenance state through Git → PR → validation → merge → Argo CD. Do not patch or scale live resources outside that workflow.

   ```sh
   kubectl -n war-table wait --for=delete pod \
     -l app.kubernetes.io/instance=games --timeout=120s
   ```

3. Save the maintenance pod below as `restore-pod.yaml`, substituting the immutable digest of the matching application image and **new PVC** name. Create it through the same approved deployment workflow. Then stream and verify the snapshot (do not allocate a TTY):

   ```sh
   kubectl -n war-table wait --for=condition=Ready pod/war-table-restore --timeout=120s
   kubectl -n war-table exec -i war-table-restore -- node -e '
     const fs=require("node:fs"); const {pipeline}=require("node:stream/promises");
     const {DatabaseSync}=require("node:sqlite"); const p="/data/rooms.sqlite";
     (async()=>{
       for(const suffix of ["-wal","-shm"])
         if(fs.existsSync(p+suffix))throw Error("Restore requires a clean directory");
       const fd=fs.openSync(p,"wx",0o600);
       try {
         await pipeline(process.stdin,fs.createWriteStream(p,{fd}));
         const stat=fs.statSync(p);
         if(!stat.size||stat.uid!==1000||(stat.mode&0o777)!==0o600)
           throw Error("Invalid restored file size, owner, or permissions");
         const d=new DatabaseSync(p,{readOnly:true});
         let r; try {r=d.prepare("PRAGMA integrity_check").all()} finally {d.close()}
         if(r.length!==1||r[0].integrity_check!=="ok")throw Error("Invalid backup");
         console.log("restore verified");
       } catch(e) {fs.unlinkSync(p);throw e}
     })().catch(e=>{console.error(e.message);process.exitCode=1});
   ' < ./rooms-backup.sqlite
   ```

   A failed transfer or integrity check removes the newly created file; an existing database is never overwritten. If the exec session is forcibly interrupted before cleanup completes, discard the new restore PVC and restart with another empty claim.

   ```yaml
   apiVersion: v1
   kind: Pod
   metadata:
     name: war-table-restore
   spec:
     restartPolicy: Never
     automountServiceAccountToken: false
     securityContext:
       runAsNonRoot: true
       runAsUser: 1000
       runAsGroup: 1000
       fsGroup: 1000
       seccompProfile: {type: RuntimeDefault}
     containers:
       - name: restore
         image: registry.example.invalid/your-team/war-table@sha256:REPLACE_WITH_MATCHING_IMAGE_DIGEST
         command: ["/usr/local/bin/node", "-e", "setInterval(()=>{},60000)"]
         securityContext:
           allowPrivilegeEscalation: false
           readOnlyRootFilesystem: true
           capabilities: {drop: [ALL]}
         resources:
           requests: {cpu: 100m, memory: 128Mi}
           limits: {cpu: "1", memory: 512Mi}
         volumeMounts:
           - {name: data, mountPath: /data}
     volumes:
       - name: data
         persistentVolumeClaim:
           claimName: your-new-empty-pvc
   ```

   Remove the maintenance pod through the approved deployment workflow, then wait for termination so RWOP can attach to the application:

   ```sh
   kubectl -n war-table wait --for=delete pod/war-table-restore --timeout=120s
   ```

4. After the maintenance pod is gone, commit `persistence.existingClaim` with the new claim name and `maintenanceMode: false` together in your environment values. For platform-managed clusters, commit, validate, merge, and let Argo CD reconcile the change. The Deployment returns to one replica.
5. Verify `/readyz`, reopen a saved room with a retained guest recovery credential, and export its results. Confirm the room's state matches the backup timestamp. Record the measured restore duration and data-loss window. Retain the old claim until the restore has been accepted.

The backup tests exercise WAL consistency and preservation of existing backups. A real CSI restore, certificate issuance, and cluster-specific routing still require a staging drill in your environment.

For a repeatable end-to-end drill on an explicitly chosen test deployment, use the following commands. They create a two-player test room; the private state file contains its guest credentials and must remain outside source control. Use a new filename on each run. When forwarding a Service locally, reopen the port-forward after pod replacement.

```sh
node scripts/smoke-deployment.cjs seed http://127.0.0.1:3000 /private/tmp/war-table-qa-seats.json
# Replace the test pod or restore its backup using the procedure above.
node scripts/smoke-deployment.cjs verify http://127.0.0.1:3000 /private/tmp/war-table-qa-seats.json
node scripts/smoke-deployment.cjs finish http://127.0.0.1:3000 /private/tmp/war-table-qa-seats.json
rm /private/tmp/war-table-qa-seats.json
```

On Linux use a private path such as `/tmp/war-table-qa-seats.json` instead. The seed command refuses to overwrite an existing file and creates it with mode 0600. The verify phase checks committed game state, both guest credentials, and progress export; finish resumes play and checks final CSV/JSON results. CI uses this same drill across a container restart. See the [verification record](verification.md) for the isolated Kubernetes restore that was exercised.

## Upgrades, rollback, and operations

Back up before each upgrade and record the image digest, chart version, values, and database schema version. `Recreate` stops the old pod before starting the new one; clients reconnect by polling. Allow up to 30 seconds for graceful shutdown. Storage detach/attach can extend downtime.

Roll back through a `platform-state` PR that restores the previously verified chart version, immutable image digest, and compatible values, then let Argo CD reconcile after validation and merge. Do this **only if the earlier application supports the current database schema**. Otherwise restore the pre-upgrade backup into a new PVC and commit the matching old release plus the restored claim reference. Do not use imperative Helm rollback against a managed environment. Never assume an application rollback reverses a schema migration. Future schema changes must document backward compatibility and restore requirements.

`/healthz` checks process health; `/readyz` checks readiness to serve rooms. `/metrics` exposes fixed operational gauges without room or guest labels; configure scraping and any required NetworkPolicy access through environment-owned GitOps configuration. Monitor pod restarts/OOM kills, readiness, response failures/latency, PVC free space, backup age, and room-capacity limits. Logs go to stdout/stderr. Avoid logging guest recovery credentials, authorization headers, or private invite URLs at the proxy. Expired rooms follow `ROOM_TTL_DAYS`; communicate the retention window to players and keep exports before it expires.

Before opening access, test both modes from separate devices over the final HTTPS hostname, guest reconnect after refresh/server restart, saved-room resume, CSV/JSON export, the backup/restore drill, and upgrade downtime. Kubernetes readiness alone does not prove gameplay or backup recovery.
