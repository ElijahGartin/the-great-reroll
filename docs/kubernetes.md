# Kubernetes deployment

The application serves the browser and multiplayer API from one Node.js 24 container. Rooms, guest-seat credentials, game state, and completed results live in `/data/rooms.sqlite`. The server commits accepted actions before acknowledging them. Browser clients poll the same origin; no WebSocket routing or sticky sessions are required. Saved games survive pod replacement when the PVC remains intact.

This is a **single-writer deployment with brief downtime during upgrades**. The chart fixes one replica and `Recreate`. Do not add an HPA, scale it above one, or run a second release against the same claim. This release does not offer high availability or cross-region replication.

## Requirements

- Kubernetes 1.29+ and Helm 3 or 4. CI uses Helm 4.3.0.
- A CSI storage class supporting `ReadWriteOncePod`, filesystem mounts, UID/GID 1000, and POSIX locking. Use block-backed persistent storage formatted with a local filesystem, such as ext4 or XFS; **do not use NFS/SMB or shared network filesystems** for SQLite WAL.
- An ingress controller or equivalent HTTPS reverse proxy, a real hostname, and a TLS certificate/Secret. Provision these through your cluster's normal processes. The chart does not install an ingress controller or certificate manager.
- A registry image accessible to cluster nodes. No image is published by this repository's CI.

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

For an existing local kind test cluster, `kind load docker-image war-table:local` makes that image available to its nodes. Production needs a registry. Replace these placeholders with your own registry and immutable release tag; select platforms matching your nodes:

```sh
IMAGE_REPOSITORY='registry.example.invalid/your-team/war-table'
IMAGE_TAG='replace-with-git-commit'
docker buildx build --platform linux/amd64,linux/arm64 \
  -t "$IMAGE_REPOSITORY:$IMAGE_TAG" --push .
```

Prefer the registry's resulting `sha256:...` digest in `image.digest` for reproducible deployments. Image publishing and cluster changes are operator actions; the commands here are a runbook, not evidence of a deployed environment.

## Configure and install

Create a private `production-values.yaml` outside version control. Replace every placeholder:

```yaml
image:
  repository: registry.example.invalid/your-team/war-table
  tag: replace-with-git-commit
  # digest: sha256:<64 hex characters>
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

The chart deliberately rejects a missing or non-HTTPS `publicOrigin`, multiple replicas, invalid resource values, and an ingress missing TLS settings. Use only the origin (no path or trailing slash); it must match the browser's HTTPS origin and ingress host. Keep the backend Service private. If another proxy supplies TLS, leave chart ingress disabled and route that proxy to Service port 80. Configure the edge to redirect HTTP to HTTPS and apply per-client request rate limits appropriate for private groups. The application intentionally ignores forwarded IP headers: its `RATE_LIMIT_PER_MINUTE` limit is per direct socket peer, so an ingress can share that limit across many guests. Tune the aggregate backend limit for your proxy and enforce individual-client limits at the trusted ingress.

```sh
helm lint deploy/helm/war-table -f production-values.yaml
helm template games deploy/helm/war-table -n war-table \
  -f production-values.yaml > rendered-war-table.yaml
# Review rendered output and target kube context before the operator applies it.
helm upgrade --install games deploy/helm/war-table \
  --namespace war-table --create-namespace \
  -f production-values.yaml --wait --timeout 5m
kubectl -n war-table rollout status deployment/games-war-table
```

Additional chart limits map directly to server environment variables:

| Value | Environment variable | Default |
| --- | --- | --- |
| `roomTtlDays` | `ROOM_TTL_DAYS` | 30 |
| `maxRooms` | `MAX_ROOMS` | 1000 |
| `maxCommandsPerRoom` | `MAX_COMMANDS_PER_ROOM` | 20000 |
| `maxBodyBytes` | `MAX_BODY_BYTES` | 16384 |
| `rateLimitPerMinute` | `RATE_LIMIT_PER_MINUTE` | 3600 |

The pod runs as UID/GID 1000 with a read-only root filesystem, all Linux capabilities dropped, no privilege escalation, RuntimeDefault seccomp, no service-account token, and a writable PVC plus bounded `/tmp`. Requests and limits are configurable; defaults are starting points, not a measured capacity promise.

Optional `networkPolicy.enabled=true` denies all egress and permits port 3000 only from pods matching **both** `ingressNamespaceLabels` and `ingressPodLabels`. Supply your controller's actual labels; an empty selector is rejected. Confirm your CNI enforces policies and check controller/health-probe behavior before enabling. The application has no runtime network dependency. Do not expose `/data` or mount it into web-serving sidecars.

## Persistence and backups

The PVC has `helm.sh/resource-policy: keep`: uninstalling the chart retains the claim. This is not a backup; deleting the claim may still destroy its volume under the storage class's reclaim policy. To reuse a retained/restored claim, set `persistence.existingClaim` to its name. PVC access mode and storage class generally cannot be changed in place; migrate to a separately provisioned claim instead.

Use the included backup command while the server is running. It uses [Node's SQLite online backup API](https://nodejs.org/api/sqlite.html#sqlitebackupsourcedb-path-options), then checks the copy with `PRAGMA integrity_check`. It preserves committed WAL data and refuses to overwrite an existing destination. Never copy only the active `.sqlite` file: committed data can still be in its WAL.

```sh
# Use a fresh filename; this example assumes release games in namespace war-table.
BACKUP_NAME="rooms-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
POD=$(kubectl -n war-table get pods -l app.kubernetes.io/instance=games \
  -o jsonpath='{.items[0].metadata.name}')
kubectl -n war-table exec "$POD" -- node scripts/backup.cjs "/data/$BACKUP_NAME"
kubectl -n war-table cp "$POD:/data/$BACKUP_NAME" "./$BACKUP_NAME"
# After verifying and securely copying it to off-cluster backup storage:
kubectl -n war-table exec "$POD" -- rm "/data/$BACKUP_NAME"
```

Keep backup files private and encrypt off-cluster copies. They contain room metadata, game state, and credential hashes. Schedule and monitor backups through your existing backup platform; alert on failure and test restores. Reserve enough PVC space for a temporary second database. Results CSV/JSON exports are useful records, but are **not** database backups and cannot restore guest seats or unfinished rooms.

## Restore drill

Restore into a **new, empty PVC**, keeping the original volume for rollback. Use the same application version that created the backup first. Verify the backup locally with Node 24:

```sh
node -e 'const {DatabaseSync}=require("node:sqlite"); const d=new DatabaseSync(process.argv[1],{readOnly:true}); const r=d.prepare("PRAGMA integrity_check").all(); d.close(); if(r.length!==1||r[0].integrity_check!=="ok")process.exit(1); console.log("integrity ok")' ./rooms-backup.sqlite
```

1. Provision a new filesystem PVC through your storage workflow with the required size and access mode. Do not reuse a directory containing old `rooms.sqlite-wal` or `rooms.sqlite-shm` files.
2. Scale the application to zero and wait for its pod to terminate before switching storage. This intentionally pauses all games:

   ```sh
   kubectl -n war-table scale deployment/games-war-table --replicas=0
   kubectl -n war-table wait --for=delete pod \
     -l app.kubernetes.io/instance=games --timeout=120s
   ```

3. Save the maintenance pod below as `restore-pod.yaml`, substituting your matching application image and **new PVC** name. Then copy and verify the snapshot:

   ```sh
   kubectl -n war-table apply -f restore-pod.yaml
   kubectl -n war-table wait --for=condition=Ready pod/war-table-restore --timeout=120s
   kubectl -n war-table cp ./rooms-backup.sqlite war-table-restore:/data/rooms.sqlite
   kubectl -n war-table exec war-table-restore -- chmod 600 /data/rooms.sqlite
   kubectl -n war-table exec war-table-restore -- node -e 'const fs=require("node:fs"); const {DatabaseSync}=require("node:sqlite"); const p="/data/rooms.sqlite"; if(fs.statSync(p).uid!==1000)process.exit(1); const d=new DatabaseSync(p,{readOnly:true}); const r=d.prepare("PRAGMA integrity_check").all(); d.close(); if(r.length!==1||r[0].integrity_check!=="ok")process.exit(1); console.log("restore verified")'
   kubectl -n war-table delete pod war-table-restore --wait=true
   ```

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
         image: registry.example.invalid/your-team/war-table:matching-backup-version
         command: ["sleep", "3600"]
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

   Wait for the maintenance pod to terminate so RWOP can attach to the application.
4. Set `persistence.existingClaim` to the new claim in your production values, then run the Helm upgrade command above. The Deployment returns to one replica.
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

Roll back with `helm rollback games <revision> -n war-table --wait` **only if the earlier application supports the current database schema**. Otherwise restore the pre-upgrade backup into a new PVC and deploy the matching old image. Never assume an application rollback reverses a schema migration. Future schema changes must document backward compatibility and restore requirements.

`/healthz` checks process health; `/readyz` checks readiness to serve rooms. Monitor pod restarts/OOM kills, readiness, response failures/latency, PVC free space, backup age, and room-capacity limits. Logs go to stdout/stderr. Avoid logging guest recovery credentials, authorization headers, or private invite URLs at the proxy. Expired rooms follow `ROOM_TTL_DAYS`; communicate the retention window to players and keep exports before it expires.

Before opening access, test both modes from separate devices over the final HTTPS hostname, guest reconnect after refresh/server restart, saved-room resume, CSV/JSON export, the backup/restore drill, and upgrade downtime. Kubernetes readiness alone does not prove gameplay or backup recovery.
