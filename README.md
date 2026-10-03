# The Great Reroll — Phase 2 project build

This build continues the maintainability migration of The Great Reroll.

## What changed in Phase 2
- All remaining inline JavaScript was moved out of `index.html`.
- Application behavior now lives in `js/app.js`.
- Analytics setup now lives in `js/analytics.js`.
- Faction/race/class/spec, lore, icon paths, class colors, and hero-art paths now live in `data/characters.js`.
- Name Forge vocabulary and naming templates now live in `data/names.js`.
- The existing external artwork/CSS structure from Phase 1 is preserved.
- Data files use JavaScript objects instead of fetched JSON so the project can still be opened directly from disk for local testing.

## Structure
```
index.html
css/
  styles.css
js/
  analytics.js
  app.js
data/
  characters.js
  names.js
assets/
  backgrounds/
  hero-cards/
    horde/
    alliance/
    legacy/
  icons/
    classes/
    races/
```

## Why this is better
- `index.html` is now primarily page structure instead of code/data storage.
- Hero art can be replaced without touching HTML or JavaScript.
- Race/class availability and asset paths have one central source of truth.
- Name Forge pools can be expanded without editing the UI logic.
- Future animated backgrounds, effects, or 3D assets can be added under `assets/` without bloating the page source.

## Recommended next step
Test this Phase 2 build locally and on GitHub Pages. Once confirmed stable, we can split `js/app.js` into focused modules such as `draft.js`, `name-forge.js`, and `ui.js`, and then begin the animated homepage work.

## Analytics activation

Analytics is configured in `js/analytics.js`. The only remaining code activation
step is replacing `PASTE_UMAMI_WEBSITE_ID_HERE` in `config.websiteId` with the real
Umami Cloud Website ID for `wowwartable.com`. No valid ID was available when this
configuration was updated, so the placeholder intentionally disables tracking.

Copy the `data-website-id` value from that website's Umami tracking code and paste
only the ID between the existing quotes:

```js
websiteId:'PASTE_UMAMI_WEBSITE_ID_HERE',
```

Use the Website ID, not an API key, account ID, or entire script tag. Commit the
replacement and let GitHub Pages deploy it. The Umami Cloud script URL and custom
domain are already configured; `index.html` already loads the analytics module.

The loader and `grTrack` are enabled only on `https://wowwartable.com` with no
nonstandard port. They remain disabled on local `file:` pages, localhost,
loopback/LAN addresses, preview hosts, `johnnywow.github.io`, and subdomains
(including `www.wowwartable.com`). Umami's `data-domains` is also set to
`wowwartable.com`. Query-string exclusion and existing event behavior are preserved.

After deploying a real ID, visit `https://wowwartable.com` and check the browser
Network panel for `https://cloud.umami.is/script.js` and a successful Umami
collection request; confirm the visit appears in the site's Umami dashboard.
Opening the site locally must produce no Umami script or collection requests.
With the placeholder, no Umami script should load even on the public domain.
