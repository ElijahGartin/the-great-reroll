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
