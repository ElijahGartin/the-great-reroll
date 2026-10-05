# Public beta exposure review

Reviewed 2026-10-04. Owner: ThunderRockTech. Scope: public access to the test
beta through a dedicated Cloudflare Tunnel, with guest names and private room
links/codes. There is no Cloudflare login gate or application account service.
Production remains inactive. This review records application behavior and the
intended exposure boundary; it is not evidence that the external route is live.

## Exposure boundary

Private environment configuration belongs to platform-core/platform-state. The
planned connector forwards to the application's private ClusterIP Service over
HTTP inside the cluster; external browser traffic uses HTTPS. Set `PUBLIC_ORIGIN`
to the exact external HTTPS origin, with no path or trailing slash. Secure cookies
and the origin checks work independently of the connector's internal transport.

The GitOps exposure configuration must restrict application ingress to the tunnel
connector through NetworkPolicy and allow only user-facing page, asset, and API
routes at the tunnel boundary. Exclude `/metrics`, `/healthz`, `/readyz`, source,
configuration, and operational paths from public routing. Local Kubernetes probes
and internal monitoring retain their service access as required. Verify the actual
CNI policy and route behavior before reporting exposure complete; these controls
are not implemented by this documentation change. Do not enable blanket API
caching or log request bodies, cookies, or Authorization headers. Invite codes in
request paths/query strings also deserve restricted access-log retention.

## Application controls reviewed

- Ten hexadecimal room-code characters provide 40 random bits. Knowing the code
  grants admission to an open lobby; it does not recover an existing player's
  identity. There is no room directory, invite approval, or invite revocation.
- Every seat gets a separate 256-bit random credential. The database stores its
  SHA256 hash. Reading room state, acting, and exporting require a valid seat;
  host actions additionally verify the host identity. Joining closes at game start.
- Cookies are host-scoped, HttpOnly, SameSite Strict, room-path scoped, and Secure
  when the configured origin is HTTPS. Cookie-authenticated changes require the
  exact origin. Requests carrying explicit bearer credentials can omit Origin;
  this supports API clients and is not anonymous seat access.
- Invite URLs and recent-room localStorage contain room codes, not seat credentials.
  Recovery credentials are shown to their holder and can be downloaded privately.
  API responses use `Cache-Control: no-store`; exports omit credentials and escape
  spreadsheet formula prefixes in CSV cells.
- Static files use an explicit allowlist and resolved-path containment. The online
  page has a same-origin Content Security Policy without inline script permission;
  guest strings are escaped before rendering. Legacy pages retain inline-script
  permission. Operational endpoints expose fixed gauges/readiness only, but are
  intentionally excluded from the planned public tunnel route.

Evidence: [server access, routing, and limits](../server/server.cjs),
[client credential handling](../js/online.js), and
[security regression tests](../tests/server.test.cjs).

## Beta limitations and operational risks

The application has **no per-client limit behind the proxy**. It deliberately uses
only the direct socket peer and ignores forwarded IP headers. The default limit
is 3,600 API requests per minute per proxy peer, shared by every guest using that
peer. Visible clients poll every 1.5 seconds (about 40 requests/minute each), so
roughly 90 clients exhaust that allowance before game actions. Set an appropriate
aggregate budget with headroom and watch errors; this is not a tested capacity
promise. Generic Cloudflare availability does not prove any configured per-client
rate limit, bot protection rule, or creation quota, and this review claims none.

Anonymous creation can consume the default global 1,000-room capacity. Rooms
expire 30 days after their last accepted change; passive reads and exports do not
extend retention. The current release has no creation-specific quota, deletion
UI, or account-based abuse controls. A malicious client can exhaust room capacity
or the shared request budget and disrupt other guests. Public beta therefore has
an explicit availability risk; private room codes protect room access, not service
capacity. Respond through the environment's exposure controls and GitOps workflow
rather than promising that the application prevents this abuse. Do not present the
beta as suitable for sensitive data or guaranteed availability.

Losing both the browser cookie and the recovery file permanently loses seat access.
There is no password reset, automatic host takeover, or active-game seat reassignment.
Hosts may remove guests only in the lobby. A new public hostname does not inherit
old host-scoped cookies; use the saved recovery code. Anyone receiving that private
recovery credential can act as its seat holder. Share invites, not recovery files.

The application remains a single SQLite writer with a persistent volume. Deployment
replacement can interrupt games briefly; backups and restore verification remain
an environment responsibility. Room exports are not restorable database backups.
Retention, backup access, and this exposure review should be revisited before
expanding the beta or activating production.

## Deployment verification

Keep the verified image/chart digests in release intent. After GitOps reconciliation,
check HTTPS and the exact public origin, two isolated guest browsers, private-seat
isolation, recovery, save/resume, and exports. Confirm blocked operational/source
paths, restrictive network ingress, and observed behavior when the aggregate rate
limit is reached. Record actual edge controls and any operational limits in private
environment documentation. This metadata/docs change neither rebuilds the runtime
nor establishes that those deployment checks have passed.
