# The War Table · The Great Reroll

A World of Warcraft character-drafting toolkit with local play and private, persistent multiplayer rooms.

- **Turn-based draft:** Character Lottery (race/class or specialization) and Guild Roster (race/role, then class/spec), eligible character pools, D100 initiative, optional timers, and one extra spin per player.
- **Deal Everyone:** three unique cards per player, defense allocation, contested steals, and final selections.
- **Private multiplayer:** invite links/codes, guest names, individual player controls, saved unfinished games, and CSV/JSON exports. No registration or public room directory.
- **Local tools:** the existing shared-screen games and Name Forge remain available from `index.html`.

## Run locally

Use Node.js **24.21.0** (the pinned container/CI runtime). No npm packages need to be installed.

```sh
npm start
# Open http://localhost:3000/online.html for multiplayer.
# Open http://localhost:3000/ for the existing tools.
```

The server creates `.data/rooms.sqlite` on first start. `DATA_DIR` and `PORT` override the directory and default port 3000. Keep that directory between runs to preserve rooms. `index.html` still works directly from disk for local tools; multiplayer requires the server. Use separate browser profiles or private windows to test multiple players, since tabs in the same browser share a guest seat for a room.

For access from other devices, use an HTTPS reverse proxy and set `PUBLIC_ORIGIN` to the exact public origin. Production refuses to start without an HTTPS `PUBLIC_ORIGIN`. See the [Kubernetes runbook](docs/kubernetes.md) for container, persistent storage, TLS, and Helm configuration.

## Play and return later

1. Open **Private multiplayer**, choose a mode and rules, and create a room with your guest name.
2. Share its invite link/code. Guests join with distinct names; every player marks themselves ready before the host starts.
3. Save your **private recovery file** when joining. Your browser remembers your seat using an HttpOnly cookie. On a new device, enter the room code and your recovery code in **Return to your saved game**. Recovery codes control a seat: keep them private and separate from the shared invite.
4. Each accepted action is saved automatically. The host can **Pause & save** and resume on another day. Pick timers default to off; enabled timers continue while players are away unless the host pauses the game.
5. Export CSV or JSON at any time. Unfinished exports are marked as progress; finished exports contain the final roster. Exports are records, not restorable room backups.

Rooms expire after **30 days without an accepted change**, configurable with `ROOM_TTL_DAYS`. Viewing or downloading a room does not extend its lifetime. The UI shows its expiry. Browser recovery cookies are refreshed when you make an accepted change or explicitly resume with your private code; retain the recovery file even when using the same browser.

The host can remove guests **before play starts** and transfer hosting to another guest. A disconnect does not erase the room or automatically transfer hosting. The original host can return using their browser or saved recovery code. A guest who loses both their browser credential and recovery file cannot reclaim a seat by name. During an active game, seats cannot be removed/reassigned; recover the existing seat or export progress and start a new room. There is no account/password-reset service or automatic host takeover.

Deal Everyone preserves visible hands and defense allocations. Players submit and lock their own sealed defense (other players see only that it is locked); steals begin once all have submitted. Joining is limited to the lobby. Rooms allow up to 40 seats, but the selected pool/rules determine whether a game can start: Deal Everyone requires three distinct eligible combinations per player. The current faction pools therefore support at most nine players in that mode. Adjust the pool and draft choices to your group before creating the room.

## Implementation and verification

The backend uses Node's HTTP server, cryptographic randomness, and SQLite. It validates actor permissions, serializes accepted actions with room revisions, and records idempotency keys before acknowledging commands. Browsers poll the shared state and never decide rolls or other players' actions. SQLite commits use WAL with `synchronous=FULL`.

The deployment runs **one replica** with a persistent volume; upgrades have a brief outage. It is not a high-availability design. Node's built-in SQLite API is currently release candidate; the runtime is pinned and persistence/backup behavior is exercised by tests. See [Node SQLite documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).

```sh
npm run check       # JavaScript syntax, including browser data modules
npm test            # game rules, HTTP authorization/persistence, UI retries, backups
npm run check:chart # requires Helm; render and reject unsafe/invalid configurations
```

| Area | Files |
| --- | --- |
| Browser multiplayer | `online.html`, `js/online.js`, `css/online.css` |
| API, guest seats, persistence | `server/server.cjs`, `server/store.cjs` |
| Authoritative rules | `server/game.cjs`, `js/deal-engine.js` |
| Shared character data | `data/characters.js` |
| Container and Kubernetes | `Dockerfile`, `deploy/helm/war-table/` |
| Backup and operations | `scripts/backup.cjs`, [Kubernetes runbook](docs/kubernetes.md) |
| Local Deal Everyone rules | [Game guide](docs/deal-everyone.md) |

The multiplayer server replaces the former online-lobby preview. The legacy UI is not a fully modular application, but it no longer needs inline scripts. Online hard roster enforcement also checks that remaining players can receive distinct eligible characters, preventing impossible assignments that the earlier browser-only checks could miss.

## Analytics

Legacy-page analytics in `js/analytics.js` remains disabled while its website ID is `PASTE_UMAMI_WEBSITE_ID_HERE`. It only activates on `https://wowwartable.com` after a valid Umami website ID is supplied. This release does not configure that account or domain. The online multiplayer page does not load analytics; never send invite codes, recovery credentials, or room state to analytics.

The container's Content Security Policy currently blocks the external Umami script on the legacy page. Enabling it on this deployment requires an intentional policy update for the chosen provider in addition to the website ID. GitHub Pages can still serve the local tools, but it does not run this multiplayer backend.

## Release ownership

Jenkins produces signed multi-architecture images, an OCI Helm chart, SBOMs, and a verified release record. Environment changes enter `platform-state` through a reviewed pull request and are reconciled by Argo CD. See [Platform delivery](docs/platform-delivery.md).

This repository contains a deployment package, not credentials or configuration for a particular cluster. Supply your registry image, HTTPS hostname/TLS Secret, and compatible storage class through your deployment process. See the [verification record](docs/verification.md) for completed checks and environment-specific checks still required.
