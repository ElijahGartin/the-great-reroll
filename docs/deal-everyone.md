# Deal Everyone

Open **The Great Reroll → Deal Everyone** from the first setup screen. This is a
host-operated shared-screen game. It does not create a cross-device lobby.
The existing turn-based draft is unchanged.

## Setup

Choose player count and names, Horde/Alliance/Either, eligible combinations,
bonus points per player (default 50), and steal attempts per player (default 1).
Every hand contains exactly three unique race/class combinations, with no overlap
between hands. The enabled pool must contain at least `players × 3` combinations.
Either randomly selects one faction; both enabled pools must satisfy capacity.
Zero steal attempts skips defense and contests. A single player also goes directly
to final selection. Player count is bounded by the enabled pool; the input accepts
1–40 and validation prevents an impossible deal.

## Defense and contests

1. Deal all hands. All dealt cards stay reserved, including cards never selected.
2. Each player allocates whole defense points across their three slots. Total
   defense cannot exceed their budget. Unassigned points become attack reserve.
   Allocations are visible on the shared screen and lock together before contests.
3. Randomized player order repeats once per configured attempt. On each turn,
   choose another player's unprotected card, offer an unprotected card from your
   own hand, and commit whole attack points within your reserve. Passing uses that
   turn. No automatic timeout or automatic point spending occurs.
4. Both players roll an independent D100 (1–100 inclusive). Attacker total is roll
   plus committed points; defender total is roll plus target slot defense. The
   attacker must strictly exceed the defender. Ties favor the defender. Attack
   points are spent on both wins and losses.
5. A win swaps the cards. Defense stays assigned to each player's slot, protecting
   the replacement. The stolen card becomes protected and cannot be stolen or
   offered in another contest. The offered replacement remains stealable.
6. After all turns, each player locks one card, in any order. Selections are final
   for that game. The final roster can be exported as CSV.

Closing and reopening keeps the game in memory in the same tab. Reloading or
leaving the page clears it. New Game confirms before clearing the current game.

## Implementation and checks

`js/deal-engine.js` contains the pure game rules. `js/deal-everyone.js` owns the
separate dialog and setup state; `css/deal-everyone.css` is scoped to this mode.
Character pools and existing artwork come from `data/characters.js`.

Run `node --test tests/deal-engine.test.cjs`. Coverage includes variable player
counts, pool capacity, distinct hands after swaps, point limits and spending,
defender-winning ties, protected cards, repeated rounds, passing, phase guards,
and final picks. Random rolls are casual client-side randomness, not a
server-authoritative competition system.
