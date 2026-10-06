# Production qualification evidence

Run the isolated qualification before a production-readiness review:

```sh
npm run qualify:production
# For a JSON artifact without npm's banner:
node scripts/qualify-production.cjs --rooms 16 --rounds 25 > qualification.json
```

Requires the supported Node runtime from `package.json`. The defaults are four
concurrent rooms and ten polling/action rounds per room. Bounds are 1–16 rooms
and 1–25 rounds. Unknown options, including target URLs and database paths, are
rejected. This command never targets an existing deployment. It boots the actual
application and game implementation on an ephemeral loopback port, using a
private temporary database. The caller must permit loopback listening. It needs
no npm dependencies and removes the temporary database, backup, and private
seat file after success or failure.

Each room has two independently authenticated participants. Workers run in
parallel across rooms; writes within a room are serialized so version conflicts
are unexpected failures. Each round toggles both participants' readiness and
polls with both credentials, comparing authoritative state and versions. Each
room then starts and completes a draft and validates its JSON export. Normal
per-client request and creation limits remain enabled, with explicit fixture
settings independent of inherited deployment configuration. All workers share
one loopback client address; this is not a distributed abuse simulation.

The recovery phase uses `smoke-deployment.cjs` to seed a paused game with a saved
selection, then `backup.cjs` to capture an online SQLite backup while the source
application is running. It stops that application, copies the verified backup
exclusively into a new empty database directory, and boots a new application.
The existing smoke verifier checks committed game state/version, both saved
seat credentials, and progress export; its finish phase resumes the game and
checks complete JSON/CSV exports. Original data is never overwritten.

The JSON report includes configuration, Node version, success/failure stage,
load request/error/status counts, p50/p95/max end-to-end request latency, and
local recovery duration. Latency includes reading/parsing the response. HTTP
errors, malformed responses, lost versions/state, failed recovery, and cleanup
failures result in a nonzero exit. Detailed assertions, child-process output,
room identifiers, credentials, URLs, and temporary paths are deliberately absent
from the report. Recovery requests are not counted in load latency statistics.
Keep the report with the exact tested source SHA and runner specifications; local
latencies and recovery duration are **not production capacity, RTO, or RPO claims**.
The full `npm test` suite exercises this same default qualification.

## Remaining launch evidence

This harness supplies repeatable application-level evidence. Production sign-off
still requires the following environment-specific acceptance:

- **CSI recovery:** follow the fresh-PVC procedure in [the deployment runbook](kubernetes.md#persistence-and-backups).
  Use an approved disposable staging namespace and separate claim on the actual
  target StorageClass. Seed test data and retain its private seat file outside
  source control. Record the backup timestamp, restore into the new claim, run
  smoke `verify` and `finish`, and measure downtime and data loss. Retain the old
  claim until acceptance; promote claim references only through reviewed GitOps.
- **Capacity and abuse:** agree on expected player concurrency, polling cadence,
  latency/error targets, resource limits, and abort thresholds before a separately
  authorized staging load drill. Test distinct client identities, overload,
  creation quotas, room exhaustion, reconnects, and storage pressure. Capture
  CPU/memory/storage and ingress metrics. Do not point this isolated command at a
  live URL or treat its bounded local run as a capacity certification.
- **Physical devices:** validate both game modes, invite/recovery handling,
  reconnect after restart, paused games, and CSV/JSON export using separate
  physical devices over the final HTTPS hostname.
- **Notification delivery:** exercise alert conditions in staging and verify the
  intended receiver actually receives and clears each notification, including
  readiness loss, storage pressure, backup age, and restart/OOM conditions.
- **Release operations:** validate single-replica upgrade downtime, schema-aware
  rollback and restored-claim rollback; finish registry/signing isolation and
  deployment artifact-verification gates before production activation.

No live restore, cluster mutation, production provisioning, or alert-delivery
test is performed by this command. Share only credential-free report artifacts;
keep environment coordinates and private recovery material out of public PRs.
