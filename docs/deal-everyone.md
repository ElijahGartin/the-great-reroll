# Deal Everyone

Open **The Great Reroll → Deal Everyone** from the first setup screen. This is a
host-operated shared-screen game. It does not create a cross-device lobby.
The existing turn-based draft is unchanged.

## Setup

Choose player count and names, Horde/Alliance/Either, eligible combinations,
bonus points per player (default 50), and steal attempts per player (default 1).
Every hand contains exactly three different classes. Copies per combination can
be set to one (unique across the table) or two (the new default). Two copies
permits up to two players to finish with the same race/class. Capacity requires
at least `ceil(players × 3 / copies)` enabled combinations, plus sufficient
class variety to give every hand three classes. Fourteen players need 42 cards,
so at two copies at least 21 combinations are necessary; class composition also
matters. Physical copies have separate IDs and protection states.

Balanced hands (default on) build the entire table with a minimum-cost allocation:
three distinct classes per hand is required, one tank/healer-capable class plus
two DPS-focused classes is preferred, three DPS-focused classes are allowed, and
other role mixes are accepted if needed by the selected pool. Role classification
uses the existing CLASS_SPECS data, not live game rules. Race variety is preferred
when assigning combinations. Hands are shuffled among players after allocation.
Turning balance off removes role preference, but retains three different classes.
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
   Both resulting hands must keep three different classes. Only valid swaps are
   shown; invalid swaps are rejected before rolling or spending points.
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

Run `node --test tests/*.test.cjs`. Coverage includes variable player
counts, pool capacity, distinct hands after swaps, point limits and spending,
defender-winning ties, protected cards, repeated rounds, passing, phase guards,
and final picks. Random rolls are casual client-side randomness, not a
server-authoritative competition system.

## Saved player groups

Saved groups are shared between regular draft setup (Players step) and Deal
Everyone setup. Save as new, load, update, rename, and delete affect only browser
local storage (`war-table-player-groups-v1`). Loading copies names into the current
setup; changes do not rewrite the saved group until Update group is clicked.
An update or deletion asks for confirmation. Groups survive refresh and browser
restart, but do not sync across devices and can be lost if site data is cleared.
Export creates a versioned JSON backup. Import validates all entries, keeps existing
groups, and creates renamed copies when names collide. No player names are sent
to a server. Groups contain names only, not hand allocations or active game state.
