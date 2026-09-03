# NOKTA — migration brief (single file → modules)

Read `CLAUDE.md` first. It holds the architecture, invariants and conventions.
This document is the plan of work.

## Goal

Split the ~2,000-line `index.html` into ES modules so features can be added
without risking unrelated breakage, **without introducing a build step**.

## Why no bundler

Browsers load `<script type="module">` with relative imports natively, and
GitHub Pages serves them fine. Keeping the zero-build deploy means `git push`
stays the entire release process — no `dist/`, no CI, nothing to forget.

**Only caveat:** ES modules do not run from `file://`. Local testing needs a
server: `python3 -m http.server 8000`, then open `http://localhost:8000`.
Note this in the README so it isn't rediscovered painfully.

Revisit bundling only if the module count makes request waterfalls slow — not
before.

## Target layout

```
index.html            thin shell: canvas, HUD markup, <script type="module">
src/
  engine/
    constants.js      COL_PER_SWITCH, COL_PER_MOVE, BOMB_COST, BOMB_SIZE, LASER_LEN…
    geometry.js       index maths, incidentCells, incidentEdges, blastBounds
    game.js           Game class: place, flood, commitCapture, clearInteriorEdges,
                      resealBorders, switchDot, bombAt, laserAt…
    ai.js             chooseAIMove and difficulty tiers
  render/
    board.js          territory fills, lines, dots
    ghosts.js         hover previews: dot, switch ring, bomb square, laser line
    minimap.js
  net/
    protocol.js       message shapes + validation in one place
    peer.js           PeerJS host/guest wiring, star relay
  ui/
    hud.js            scores, names, meta lines
    abilities.js      the ability picker modal
    controls.js       mode/difficulty/size/log/auto-centre
  main.js             wiring, turn flow, input handling
test/
  *.test.js           node tests, no DOM
```

`engine/` must stay **DOM-free and import nothing outside `engine/`**. That is
what makes it testable in node and is the property every test in this project
has relied on.

## Migration steps

Do these in order, committing and confirming the game still plays after each.
Do not start step 2 until step 1 is verified in the browser.

1. Create the repo structure. Move the current `/*==LOGIC==*/` block verbatim
   into `src/engine/` split across `constants.js`, `geometry.js`, `game.js`,
   `ai.js`. Add exports/imports, change **no logic**. Verify: game plays
   identically.
2. Port the existing throwaway checks into `test/` as a real suite (see below).
   Verify: all pass.
3. Extract rendering into `render/`. Verify visually, and diff `engine/` to prove
   it is untouched.
4. Extract netcode into `net/`, UI into `ui/`. Verify 2-player and 3-player
   online still work.
5. Only now start new features.

## Test suite to establish in step 2

These all correspond to bugs that actually occurred, or to invariants that
silently broke. Each should be a named test:

- `colQ` matches live colonized truth after every move of a full simulated game,
  at every AI difficulty, and never goes negative.
- A player who colonizes ground, loses it, and retakes it does not gain extra
  tokens (`colEarnedQ` monotonic, no double credit).
- A move that encloses nothing, played far from any territory, captures nothing.
  *(This is the stale-buried-edge regression. It is subtle and will come back if
  `clearInteriorEdges` is ever dropped.)*
- After a blast: no orphan lines, no open sides, victims keep ground outside the
  damaged ring.
- `resealBorders()` is a byte-for-byte no-op on a normally-played board.
- Replaying an identical action stream on three fresh engines yields identical
  `owner`, `dots`, `hE`, `scoreQ`, `colQ`, `colEarnedQ`, `switchSpent`.
- Bonus move triggers at exactly `COL_PER_MOVE`, not before.
- Win triggers above `totalArea()/np`, not at it.

## The ability system

Replace the current per-ability buttons with **one picker**. A modal listing
every ability with its token cost, affordable ones enabled and the rest greyed
out with the cost visible. Selecting one arms it; the board then shows that
ability's ghost until the player clicks or cancels with Esc.

Suggested starting costs (`switch = 1`, `laser = 5`, `bomb = 5`). Tune later —
they belong in `constants.js`.

Every ability spends **one of the turn's moves**, exactly like placing a dot, so
turn structure stays "N actions per turn" and the netcode treats them all as one
ordered action stream.

### Already built

- **Switch** (1 token) — flip one opponent dot to your colour. Rewires edges
  through that point and runs the capture check, so it can close a loop.
- **Bomb** (5 tokens) — `BOMB_SIZE` square, centre chosen by the player, ghost
  preview with a crosshair. Inside the blast: enemy ground colonized, neutral
  ground claimed. The one-square **ring around the blast**: enemy ground is
  destroyed to neutral and its lines stripped. Anything further keeps its owner.
  The blast draws its own perimeter of dots and edges, so the new territory has
  a real border that blocks placement. Dots inside are untouched.

### To build: Laser (5 tokens)

Draws a line of up to `LASER_LEN = 10` dots in one action.

- Player clicks the **start** point; the line extends in the aimed direction.
- **R** rotates through 4 orientations: horizontal, vertical, and both 45°
  diagonals (a line is symmetric at 180°, so 4 is all of them).
- Ghost shows exactly which points will receive dots, before committing.
- **Blocked points are skipped and the line continues past them.** The ray is
  `LASER_LEN` positions long from the anchor; blocked positions get no dot and
  the line does **not** extend further to compensate. So you may place fewer
  than 10 dots.
- Consequences worth surfacing in the ghost, because they are strategic:
  - Skipping an **opponent's** dot leaves a genuine gap — the two dots either
    side are 2 apart, no edge forms, and the laser will not seal there. Blocking
    a laser path is therefore a real defensive move.
  - Skipping **your own** dot does *not* break the line — edges form to it and
    the run stays continuous.
  - A 45° laser can be blocked mid-run by the diagonal-crossing rule (see
    `CLAUDE.md` geometry). The ghost must reflect this, not just occupancy.
- Run the normal capture check once at the end, after all dots are placed.

### To build: Bridge

Connect two of **your own existing dots** with a straight line. Same line
machinery as the laser, but the player picks both ends, so it is aimed rather
than sprayed. Only legal if the two dots are exactly aligned (same row, column,
or 45° diagonal). Cheaper than the laser — it needs an existing position.

### To build: Freeze

The chosen opponent loses one move on their next turn. Cheap, simple, and
sharper than it sounds in a 3-player game, where it can decide who gets to close
a loop first. Needs a per-player `pendingPenalty` consumed in `movesFor`.

### To build: City (largest, do last)

Buildable on **colonized** land only, generating tokens per turn. This turns
colonies into an economy rather than just a score, and is the intended direction
for the game.

Design notes:
- Store cities in a sparse map keyed by **square** index, not quarter-cell:
  `Map<squareIndex, {owner, level}>`. Placement rule: all 4 quarters of the
  square owned *and* colonized.
- Decide up front what happens when a city's square changes hands or is
  destroyed by a blast — that rule is the whole balance of the feature.
- Cities generating tokens which buy bombs which create more colonies is a
  feedback loop. Cap output per turn, or make cities destructible, before
  playtesting on a small board.

## Balance warning

Bombs already feed the token economy: bombing colonizes, colonizing earns
tokens, tokens buy bombs. Adding cities adds a second loop into the same
currency. On a small board this can snowball fast. The cheapest dials are
`BOMB_COST` first, then `BOMB_SIZE`.

## Deployment

Unchanged: commit to `main`, GitHub Pages serves the repo root, `index.html` is
the entry point. Keep the entry file at the root — moving it breaks the URL
already shared with other players.
