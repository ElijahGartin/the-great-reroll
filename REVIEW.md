# Code review guide (War Table)

Short, repo-specific context for automated and human reviewers. Update this when the same finding keeps appearing on PRs.

## What must not break

| Area | Paths | Failure looks like |
| --- | --- | --- |
| Authoritative multiplayer rules | `server/game.cjs`, `js/deal-engine.js`, `js/selection-engine.js` | Clients accept illegal moves; Deal Everyone hands or steals disagree between server and UI |
| HTTP API, auth, and redaction | `server/server.cjs` | Wrong guest sees sealed Deal Everyone defenses (`view()` in `server/server.cjs`); seat tokens or recovery codes leak in logs or responses |
| Persistence and replay | `server/store.cjs`, `scripts/backup.cjs` | Lost rooms, duplicate commands applied twice, or SQLite growth past `MAX_DB_BYTES` without a clear 507 |
| Browser multiplayer client | `js/online.js`, `online.html` | UI rolls or resolves turns locally instead of polling server state; credentials stored outside HttpOnly cookies / recovery files |
| Character pools and art keys | `data/characters.js`, `js/character-pool.js` | Pool config passes validation but cannot deal three distinct classes per player (see `buildHands` errors in `js/deal-engine.js`) |
| Local-only tools | `js/app.js`, `js/deal-everyone.js`, `index.html` | Shared-screen play diverges from documented rules in `docs/deal-everyone.md` |

## High scrutiny

- **Dual rule engines:** `server/game.cjs` requires `js/deal-engine.js` and `data/characters.js`. A browser-only change to deal logic without matching server behavior is a regression unless intentionally local-only.
- **Production startup:** `NODE_ENV=production` requires HTTPS `PUBLIC_ORIGIN` (`server/server.cjs`). Do not weaken origin checks or `TRUST_PROXY` without reading `docs/kubernetes.md`.
- **Guest identity:** Guest names reject controls and homoglyphs (`name()` in `server/server.cjs`). Rate limits and room caps (`MAX_ROOMS`, `ROOM_CREATES_PER_HOUR`) are abuse controls, not product knobs.
- **Managed delivery:** Changes under `deploy/helm/war-table/`, `Dockerfile`, or `.platform/` must follow `AGENTS.md` and pass `scripts/validate_managed_app_contract.py`.

## Tests and evidence

- Add or extend tests in `tests/*.test.cjs` for any rule, authorization, or persistence change (`npm test`).
- Syntax sweep: `npm run check` (includes browser modules under `js/` and `data/`).
- Helm or values changes: `npm run check:chart` when Helm is installed.

## Skip / low value nits

- Asset-only changes under `assets/` unless paths referenced from `data/characters.js` change.
- Copy-only CSS tweaks with no behavior change, unless they affect multiplayer layout in `css/online.css`.

## Reviewer output

- Start with a **count** of actionable findings; say plainly when there is nothing to fix.
- Cite **file and line** for each important finding; prefer fixing the class of issue over repeated one-off comments.
