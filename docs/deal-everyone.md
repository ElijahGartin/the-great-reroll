# Deal Everyone

Open **The Great Reroll** from the home screen. This is a
host-operated shared-screen game. It does not create a cross-device lobby.
The existing turn-based draft is unchanged.

## Setup

Choose player count and names, Horde/Alliance/Either, eligible combinations,
bonus points per player (default 100), copy limits, and balanced hands.
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
The setup accepts 1–40 names and rejects deals that exceed the enabled pool.

## Guild Selection contests

After all hands are revealed, everyone rolls D100 for turn order; ties reroll.
On your turn, keep your hand or reroll selected cards once, then claim a hero.
Unresolved players can submit a sealed attack bid with an offered card, or pass.
The host collects bids privately: masking in this shared screen is not secure
multiplayer secrecy. Attack bids are revealed and spent before the owner chooses
and spends defense. Attack and defense caps are 50 and 75 points respectively,
limited by remaining points. Highest D100 plus bid wins; owners win ties and tied
leading challengers reroll. A winning challenger locks the hero and gives their
offered card to the owner, who keeps their turn. Unused cards return to the pool
when a player locks a hero. Locked players cannot challenge again. When everyone
has a hero, export the guild roster as CSV.

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

## Sequential reveal

Start the Reveals assigns all hands together, then shows them face down. Players
reveal in setup order; the randomized steal order is separate. Roll My Heroes
starts three vertical artwork reels, stopping at approximately 1.9, 2.45, and
3 seconds. Next Player is available only after that hand lands. Previously
revealed hands remain visible. No defense allocation or final choices are shown
until the last player has revealed and the host continues.

Skip Animation lands the same assigned hand immediately. Reduced-motion mode
reveals immediately without the spinning effect. Closing during a spin cancels
only the animation; reopening lets that player reveal the same assigned cards.
The reveal does not reroll, spend points, or change copy limits or hand balance.

## Online rooms and shared-screen Guild Selection

The updated Guild Selection flow (balanced hands, sequential reveals, rerolls,
sealed-bid presentation, and selection contests) is a host-operated shared-screen
game. Its illustrated guide at `how-to-play.html` describes that local flow.
Saved player groups stay in this browser. None of these features provide online
room synchronization or secure bid secrecy.

Use `online.html` for private cross-device Draft or Deal Everyone rooms. Those
rooms retain server-authoritative rules, saved unfinished games, guest seat
credentials, and JSON/CSV exports. Online Deal Everyone retains the original
defense/steal/final-choice flow; existing saved games remain compatible.
