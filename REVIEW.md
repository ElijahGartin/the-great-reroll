# Code review guide (War Table)

Short, repo-specific context for automated and human reviewers. Update this when the same finding keeps appearing on PRs.

## What must not break

| Area | Paths | Failure looks like |
| --- | --- | --- |
| Authoritative multiplayer rules | `server/game.cjs`, `js/deal-engine.js` | Clients accept illegal moves; Deal Everyone hands or steals disagree between server and UI |
| HTTP API, auth, and redaction | `server/server.cjs` | Wrong guest sees sealed Deal Everyone defenses (`view()` in `server/server.cjs`); seat tokens or recovery codes leak in logs or responses |
| Persistence and replay | `server/store.cjs`, `scripts/backup.cjs` | Lost rooms, duplicate commands applied twice, or SQLite growth past `MAX_DB_BYTES` without a clear 507 |
| Browser multiplayer client | `js/online.js`, `online.html` | UI rolls or resolves turns locally instead of polling server state; credentials stored outside HttpOnly cookies / recovery files |
| Character data, pool validation, art keys | `data/characters.js`; `server/game.cjs` (`normalizeConfig`, `validatePool`, `pool`); `js/deal-everyone.js` (`pool`, `validateSetup`, pre-deal capacity checks) | Pool passes UI but cannot deal or start: undealable three-class hands (`buildHands` in `js/deal-engine.js`); draft pools that fail `validatePool` at room start |
| Local-only tools | `js/app.js`, `js/deal-everyone.js`, `js/selection-engine.js`, `index.html` | Shared-screen play diverges from documented rules in `docs/deal-everyone.md`; selection round state diverges from `js/selection-engine.js` |

## High scrutiny

- **Dual rule engines:** `server/game.cjs` requires `js/deal-engine.js` and `data/characters.js`. A browser-only change to deal logic without matching server behavior is a regression unless intentionally local-only.
- **Production startup:** `NODE_ENV=production` requires HTTPS `PUBLIC_ORIGIN` (`server/server.cjs`). Do not weaken origin checks or `TRUST_PROXY` without reading `docs/kubernetes.md`.
- **Guest identity:** `name()` in `server/server.cjs` (lines 67–72) rejects control/invisible/bidi characters and blocks duplicate names via NFKC normalization plus JavaScript `toLowerCase()`; it does **not** use full Unicode case folding or detect cross-script confusables (e.g. Latin vs Cyrillic look-alikes). Rate limits and room caps (`MAX_ROOMS`, `ROOM_CREATES_PER_HOUR`) are abuse controls, not product knobs.
- **Managed delivery:** Changes under `deploy/helm/war-table/`, `Dockerfile`, or `.platform/` must follow `AGENTS.md` and pass `scripts/validate_managed_app_contract.py`.

## Tests and evidence

- Add or extend tests in `tests/*.test.cjs` for any rule, authorization, or persistence change (`npm test`).
- Syntax sweep: `npm run check` (includes browser modules under `js/` and `data/`).
- Helm or values changes: `npm run check:chart` when Helm is installed.

## Skip / low value nits

- Binary or path swaps under `assets/` when **only** the file bytes change and every reference path stays the same (still spot-check `data/characters.js`, `css/*.css`, `*.html`, and hard-coded paths in `js/app.js`).
- Asset **renames, moves, or deletions** always need a repo-wide reference check (`url(`, `src=`, `content=` in CSS/HTML and string paths in `js/` / `data/`), not only `data/characters.js`.
- Copy-only CSS tweaks with no behavior change, unless they affect multiplayer layout in `css/online.css`.
- `js/character-pool.js` when the change is presentation-only (eligibility rules live in `js/app.js` per that file’s header).

## Reviewer output

- Start with a **count** of actionable findings; say plainly when there is nothing to fix.
- Cite **file and line** for each important finding; prefer fixing the class of issue over repeated one-off comments.
