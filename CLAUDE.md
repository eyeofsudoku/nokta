# NOKTA — grid territory game

Two or three players place dots on a lattice. Dots of the same colour auto-connect
into lines; closing a loop claims the enclosed area. Claiming ground that already
belongs to an opponent is **colonization**, which drives the whole economy
(bonus moves and ability tokens).

Deployed at `https://eyeofsudoku.github.io/nokta/` via GitHub Pages.
**The served file must be named `index.html` at the repo root.**

---

## Repo layout

```
index.html            shell + UI/renderer/netcode (not yet extracted)
src/engine/
  constants.js        COL_PER_SWITCH, COL_PER_MOVE, BOMB_COST, BOMB_SIZE,
                      LASER_LEN, LASER_COST, COL_WIN_BONUS, oppOf
  geometry.js         index maths: pi/inP/inS, incidentCells, incidentEdges,
                      blastBounds, inBlast, cellNeighbours
  game.js             the Game class — place, flood, commitCapture, switchDot,
                      bombAt, laserAt, clearInteriorEdges, resealBorders,
                      reownBorders, winScore/leader/winner/gameResult
  ai.js               chooseAIMove, findBestReply, difficulty tiers
src/render/           empty — migration step 3
src/net/              empty — migration step 4
src/ui/
  abilities.js        the ability registry (see below)
test/invariants.test.js
```

**`engine/` must stay DOM-free and import nothing outside `engine/`.** That single
property is what makes every test in this project possible — the engine loads in
node with no browser, no canvas, no stubs. Do not import from `render/`, `net/`,
`ui/` or reach for `document`/`window` inside it.

No build step. Browsers load the ES modules natively and GitHub Pages serves
them, so `git push` is the whole release process. ES modules do not run from
`file://`, so local testing needs `python3 -m http.server 8000`.

---

## Working conventions (important)

0. **Run `node test/invariants.test.js` after any engine change.** It scans the
   whole board for illegal squares, mixed outlines, open sides and ledger drift
   after every action, across full simulated games at each AI difficulty for 2
   and 3 players. It catches exactly the class of bug that reasoning misses.
1. **Invariant metrics count DISTINCT violations, never per-step sums.** A
   harness that adds the violation count after every action multiplies one
   long-lived violation by however many steps it survives. That is how a stress
   run once reported "230 mixed outlines" for what were **9** distinct ones,
   never more than 2 on the board at once — a 25x inflation that also pointed
   the blame at the wrong operation (bombs, when every one was written by
   `place`). Report distinct violations, max concurrent, and which action
   introduced each.
2. **Verify empirically, never by eye.** The engine is deterministic and pure.
   Any claim about game behaviour must be demonstrated by a test that runs in
   node — not by reasoning about a screenshot, and not by reading the render
   output. This rule exists because inspecting rendered state repeatedly led to
   wrong conclusions; game-logic reasoning and a failing/passing test are the
   only accepted evidence.
3. **Engine changes and UI changes are separate commits.** After UI work, diff
   the engine directory to prove it is untouched.
4. **One behaviour change at a time**, with the test written before or alongside.
5. When something looks like a rendering bug, check the engine invariants first
   (below). Several "render bugs" in this project were real state corruption.

## Engine invariants (assert these in tests)

- `colQ[p]` == number of cells where `owner[c] === p && colFlag[c]` — *live*
  colonized holdings, not history. Must never go negative.
- `colEarnedQ[p]` is monotonic (lifetime colonization). Drives token earning.
  Kept separate from `colQ` specifically so losing and retaking ground cannot
  farm tokens.
- `scoreQ[p]` never negative; the sum over players never exceeds `owner.length`.
- No **orphan lines**: no edge may have unowned ground on *both* sides.
- No **open sides**: wherever owned ground meets unowned ground, a line must
  exist between them.
- **Every boundary line belongs to its region's owner.** A line with territory
  on one side and empty ground on the other must be owned by the player holding
  that territory; a region fenced partly in someone else's colour is invalid.
  Measured at 0 across ordinary placement play, so this is a real always-true
  property. Two distinct mechanisms break it, and they need different answers:
    - **Theft** — an edge slot has a single owner, and `resealBorders`/`bombAt`
      create borders owned by the **ground holder** rather than derived from
      dots, so a slot can be someone's boundary while both its lattice points
      sit empty and free to build on. Prevented in **`applyEdges`**, which
      refuses to overwrite another player's slot. 6 of the 9 observed cases.
    - **Stranding** — a capture claims ground next to a line another player
      drew, leaving their line fencing the new region. Prevention cannot reach
      this structurally, so **`reownBorders()`** repairs it. 3 of the 9.
- **Every square must be fenceable.** Inside a square the four quarters meet at
  the centre, and the only separators are the two diagonals — of which a square
  may hold **at most one**, since two would cross. So a square is outlineable in
  exactly three states:
    1. all four quarters the same owner,
    2. split by `dA`: `{N,E}` one owner, `{S,W}` another,
    3. split by `dB`: `{N,W}` one owner, `{E,S}` another.
  With 3 owner values (neutral + 2 players) that is **15 of 81** combinations;
  with 4 (neutral + 3 players) it is **28 of 256**. The counts are illustrative —
  the rule is what matters, and the overwhelming majority of states cannot be
  outlined at all. A square with one, or three, quarters of a given owner is
  invalid. Any operation writing `owner[]` must leave every touched square
  legal, so a player's holdings must always equal **exactly what their own lines
  enclose** — release what is no longer fenced in *and* claim what is, or a
  re-cut square strands a lone owned quarter. A quarter-carve is not a rendering
  bug to paper over: the state itself is unrepresentable, and `dAVis()`/`dBVis()`
  document the assumption it breaks (`N==E`, `S==W`).
- Replaying the same ordered action stream on a fresh engine must reproduce a
  byte-identical board (this is what makes the netcode work — see below).

---

## `place` is no longer byte-identical to the original engine

Through the module migration and the `switchDot` rewrite, `place`/`bomb`/AI were
held byte-identical on purpose, to prove those changes were surgical. That no
longer holds, deliberately:

- `applyEdges` will not overwrite a slot owned by another player (the theft case
  above). This matters beyond cosmetics because `applyEdges` runs *before*
  `flood()`, so a stolen slot is a live barrier in the capture that immediately
  follows. (Measured: in all 9 observed cases the capture result was unchanged,
  so nothing was mis-captured in practice — but the ordering makes it possible,
  and repair-after-the-fact cannot undo a capture.)
- `applyEdges` therefore returns the edges it actually wrote, and `revertEdges`
  must be given that list — reverting the full requested list would zero a slot
  we never owned. `simPlace` relies on this, so hard-AI lookahead now evaluates
  the position that would really result.
- `place` ends with `reownBorders()` as a safety net.

Everything else about `place` is unchanged, and the five standard AI/bomb
scenarios still reproduce the pre-migration board exactly.

---

## Geometry model

- Board is `N x N` unit squares, `(N+1) x (N+1)` lattice points.
- Each square splits into 4 quarter-triangles meeting at its centre:
  `t=0 N`, `t=1 E`, `t=2 S`, `t=3 W`. Quarter-cell index is `(sy*N+sx)*4 + t`.
  Area of one quarter = 0.25, so `area(p) = scoreQ[p] / 4`.
- Edge slots, each with a single owner (so two players can never share a line):
  - `hE[y*P+x]` horizontal, `vE[y*P+x]` vertical
  - `dA[sy*N+sx]` the `\` diagonal, `dB[sy*N+sx]` the `/` diagonal
  - **A diagonal is illegal if the opposite diagonal of that square exists.**
    This is the only possible crossing in this geometry.

## Capture

`flood(pl)` floods the quarter-cell graph from **outside the board**, treating
only `pl`'s own edges as barriers. Everything not reached and not already `pl`'s
becomes `pl`'s. This is planar face detection and it handles concave shapes,
nested loops, merging, and multi-region captures for free.

Three follow-ups, all of which fix real bugs — do not remove:

- **`clearInteriorEdges()`** — after a capture, delete edges whose two adjacent
  quarter-cells share the same owner. `flood(pl)` treats *every* edge `pl` owns
  as a barrier, board-wide and forever. An old loop buried inside territory that
  later changed hands keeps its interior permanently unreachable, so
  `commitCapture` re-claimed it on **any** later move by `pl` — even one on the
  far side of the board enclosing nothing. Visually a no-op (the renderer
  already hides those lines).
- **`resealBorders()`** — called by `bombAt` and by `switchDot`, i.e. by every
  operation that strips someone's edges. Adds a line wherever owned ground meets
  empty ground and none exists, and restores the diagonal on a square that is
  legally split but lost its separator (respecting the crossing rule — never
  opposite an existing diagonal). **Only ever ADDS, and only between two real
  in-board cells** — putting a line on the board rim would stop `flood()` seeding
  from that side and make the entire outside look enclosed, causing a mass
  phantom capture. Must be a no-op on a normally-played board; there is a test
  for exactly that, and it pins the "only ever adds" contract.
- **`reownBorders()`** — called at the end of `place` and `switchDot`. Re-owns a
  line that already exists on a `territory|empty` seam but belongs to the wrong
  player (the stranding case above). It **never creates** a line, never touches
  one between two owned regions or two empty cells, and leaves free construction
  lines with whoever drew them.
  **It fires roughly once per 40 simulated games.** That rarity is recorded here
  deliberately: a safety net that almost never fires is exactly the thing a
  future session deletes as dead code. It is not dead — prevention structurally
  cannot cover stranding, and there is a test.

---

## Mechanics

### Switch — `switchDot(x, y, pl)`, costs 1 token

**A switch takes a dot, not ground.** Everything else follows from that. It took
three attempts to get right; the reasoning below is why the current shape is the
shape it is.

- **Edges are derived from dots, not accumulated state.** The engine otherwise
  only ever adds an edge when a dot is placed, which is safe while dots are
  never removed — a switch removes one from the victim's structure, so
  `rederiveEdgesAround` must re-derive the victim's connections. Removing a dot
  can make a connection *legal that never was*: closing a 1x1 square leaves both
  diagonals absent, and switching a corner away lets the two surviving corners
  finally connect across the `/` diagonal. Without re-deriving, the victim is
  left with an L-shape enclosing nothing instead of a triangle.
- **The victim keeps exactly what their remaining lines enclose**
  (`recomputeHoldings`). It must both release what is no longer fenced in *and*
  claim enclosed neutral ground. Release alone is not enough: a re-derived
  diagonal can re-cut a square so a quarter is enclosed but unowned, and a lone
  owned quarter is one of the unfenceable states.
- **Released ground goes neutral, never to the switcher.** Handing it over would
  fence the switcher's new territory with the victim's lines, breaking the
  boundary-ownership invariant.
- **The switcher captures only if their new dot genuinely closes one of their
  own loops.** A switch therefore usually earns no colonization. That is
  correct — it is a disruption tool. If it needs buffing, lower
  `COL_PER_SWITCH`. **Do not grant territory without a loop.** An earlier attempt
  did exactly that ("Option A": transfer whole incident squares to the switcher)
  and produced mixed outlines everywhere, because the transferred ground was
  fenced by whatever lines happened to be there — the victim's. Do not
  reintroduce it.

The two acceptance cases, which are regression tests:

| setup | action | result |
|---|---|---|
| triangle of 3 dots (0.5 area) | switch the apex | victim keeps **0** — two dots cannot enclose anything |
| square of 4 dots (1 area) | switch a corner | victim keeps exactly **0.5**: a triangle outlined entirely in their colour, `/` present, `dA` absent |

### Bomb — `bombAt(cx, cy, pl)`, costs `BOMB_COST` tokens

- **Inside** the `BOMB_SIZE` square: enemy ground is colonized, neutral ground is
  claimed.
- **The one-square ring** around the blast: enemy ground is destroyed to neutral
  and its lines stripped. This is what severs a region.
- **Anything further away keeps its owner.** A 3x2 clipped on one side leaves
  1x2 taken, 1x2 destroyed, 1x2 still the victim's.
- The blast **draws its own perimeter** of dots and edges, so the new territory
  has a real border that blocks placement rather than an invisible edge.
- **Dots inside the blast are untouched.**
- Bombs feed the token economy: bombing colonizes, colonizing earns tokens,
  tokens buy bombs.
- `bombAt` calls `clearInteriorEdges` + `resealBorders` but **not**
  `reownBorders`, unlike `place` and `switchDot`. This asymmetry is deliberate
  and measured, not an oversight: across 12 three-player games and **336
  detonations**, calling `reownBorders()` after each blast changed the board
  **zero** times. Because the blast draws its own perimeter, it does not strand
  anyone else's line. Do not "tidy" this into symmetry without re-measuring.

### Laser — `laserAt(x, y, dir, pl)`, costs `LASER_COST` tokens

- The ray is `LASER_LEN` **positions** long starting **at** the clicked point —
  not `LASER_LEN` dots. A blocked position gets no dot and the ray **continues
  past it**, without extending to compensate, so fewer than `LASER_LEN` dots may
  land.
- **8 directions**, index 0-7 (`LASER_DIRS`): E, SE, S, SW, W, NW, N, NE. Not 4.
  A line is symmetric at 180° only when it is *centred*; the anchor here is the
  **start**, so E and W are genuinely different shots. The index goes over the
  wire, so that order is protocol — do not reorder it.
- **One capture pass after the whole line**, not one per dot.
- A ray that would land nothing returns `null` and spends no token, so a fully
  blocked shot can never be wasted.
- Uses `applyEdges`' guard like everything else: a laser must not steal another
  player's edge slot.
- Four consequences the ghost must show, all verified against the engine:
  1. skipping any position leaves a real gap — the dots either side are 2 apart
     and no edge forms
  2. skipping **your own** dot does *not* break the run; edges form to it from
     both sides
  3. skipping an **opponent's** dot *does* break it, so blocking a laser path is
     a genuine defensive move
  4. a 45° step can be refused by the **crossing rule** even on an empty point —
     the dot lands, the connection does not
- `laserPreview(x, y, dir, pl)` returns the same walk without mutating, plus a
  per-step `links` array. **The ghost renders only from this**, so preview and
  reality cannot drift; a test compares it against a real `laserAt` on a clone
  in all 8 directions.

### Abilities are registry-driven

Every ability the player can pick lives as **one entry** in
`src/ui/abilities.js`: `{ id, mode, icon, name, cost, description, canUse }`.
The EXTRAS button, the picker modal, the affordability accent and the number-key
shortcuts all read from that table and branch on **nothing** ability-specific —
adding Bridge or Freeze to the picker is one entry, not edits scattered through
`index.html`.

- `mode` is the arming instruction: it is the value the UI puts in `armedMode`,
  which keeps `abilities.js` DOM-free and importable on its own.
- **Costs and sizes are read from `constants.js`, never restated**, so retuning
  `BOMB_COST` or `LASER_LEN` updates the picker text automatically.
- The one exception: the engine has no `SWITCH_COST` — `canSwitch()` encodes the
  price as `switchesFor(pl) > 0`, so the registry declares `SWITCH_COST = 1`
  locally. If a real constant is ever added, import it and delete that.
- A new ability still needs its own click dispatch and ghost in `index.html`;
  the registry covers everything the *picker* needs, not the action itself.

If adding an ability ever requires editing the modal, the button or the key
handling, the abstraction has failed — fix it in the registry rather than
working around it.

---

## Rules constants (single source of truth)

```js
const COL_PER_SWITCH = 40;   // quarter-cells of lifetime colonization per token (40 = 10 area)
const COL_PER_MOVE   = 400;  // quarter-cells of live colonization per bonus move (400 = 100 area)
const BOMB_COST      = 5;    // tokens per bomb
const BOMB_SIZE      = 5;    // blast is SIZE x SIZE squares; keep ODD
const COL_WIN_BONUS  = 1;    // colonized ground counts this much EXTRA to win
```

Turn order is `nextOf(p) = (p % np) + 1`.

### Win condition — a score, not a share

You win by **scoring** more than `totalArea() / np`, which is *not* the same as
holding that share of the board:

```
winScore(pl) = area(pl) + colArea(pl) * COL_WIN_BONUS
```

`colQ` is a **subset** of `scoreQ`, so this is a deliberate bonus on ground
already counted once — not a second tally. Colonized ground is therefore worth
double a plain square at `COL_WIN_BONUS = 1`, and a player whose holdings are
*entirely* colonized wins at **`(1/np)/(1+COL_WIN_BONUS)`** of the board — 25% in
a 2-player game.

That is the intent: **taking a quarter of the board off your opponent is a win;
fencing half of empty ground is not.** Colonization already drives the token
economy, and this puts it in the victory condition too.

Two consequences worth knowing:

- The bonus makes it possible for **two players to cross the line at once**,
  which the plain-area rule could not. `winner()` therefore declares only a
  strict single leader and returns 0 on a tie — never the lower-numbered player.
- The old reachability note below is now conservative. Greedy local play still
  rarely wins on area alone, but a bomb-and-switch game that colonizes heavily
  reaches the line at half the ground it used to need.

### The two ways a game ends — `gameResult()`

`gameResult()` returns a **shape**, not a number, because winner 0 is ambiguous
on its own: `{over:true, winner:0}` is a genuine draw and `{over:false,
winner:0}` is a game still in progress. A caller reading a bare 0 as "keep
playing" would never end a drawn game.

| `reason` | meaning |
|---|---|
| `'threshold'` | someone passed `totalArea()/np` on `winScore` |
| `'exhausted'` | no legal placement remains; highest `winScore` takes it |
| `null` | still in progress |

**Threshold is checked first**, so a board that is simultaneously full and won
reports `'threshold'`. An exhausted board with equal `winScore`s is a **draw**,
not a win for the lower-numbered player — `leader()` supplies the same tie rule
`winner()` uses, which is why it was extracted rather than duplicated.

**Why token-holders do not extend the game.** "No legal placement" deliberately
does *not* mean "no legal action": a player holding tokens could still bomb or
switch, and either can free ground and reopen the board. Measured across 6 full
AI games, every player was at zero tokens in 4 of them, and in the one case with
real bombs left that player was already ahead 1602 to 143. Waiting for tokens to
run out instead would let one player sit on a single unusable token and stall
the game forever — the exact failure this condition exists to fix.

> Reachability note (plain-area figures, pre-bonus): greedy local play never
> exceeds ~44% of the board *claimed in total*. It is reachable by deliberately
> drawing one large enclosing loop, which captures 81–97% — but a loop that size
> costs ~72 moves on a 20x20 board and ~592 on 150x150. Board sizes 20/30/50
> exist so the win condition is live.

## Netcode

PeerJS WebRTC, **star topology**: guests connect only to the host. The host
applies a guest's action locally and relays it to the other guest, so all peers
see one ordered stream. Host is seat 1 (Blue), guests fill seats 2 (Red) and
3 (Green).

Only actions cross the wire, never board state — the engine's determinism does
the rest:

| msg | meaning |
|---|---|
| `{t:'m',x,y,pl}` | place a dot |
| `{t:'s',x,y,pl}` | switch an opponent's dot |
| `{t:'b',x,y,pl}` | detonate a bomb at square (x,y) |
| `{t:'l',x,y,d,pl}` | fire a laser from (x,y) in direction `d` (0-7, see `LASER_DIRS`) |
| `{t:'seat',pl,np,size}` | host assigns a seat to a joining guest |
| `{t:'start',size,np}` | host starts the game (host-authoritative) |
| `{t:'name',pl,name}` | nickname broadcast |
| `{t:'left',pl}` | a player dropped |

Guards: a guest may only act as its own seat; an action is ignored unless
`msg.pl === currentPlayer`. `LASER_DIRS`' order is part of the protocol — the
index travels over the wire, so reordering it would silently desync peers on
different builds. A `d` outside 0-7 is refused by the engine spending nothing,
so a malformed message is a no-op rather than a divergence. New game and board size are host-only, otherwise
peers silently diverge onto different boards.

---

## Roadmap

### Built

- Place, capture, colonization economy
- Bonus move per `COL_PER_MOVE` of live colonization
- Switch token per `COL_PER_SWITCH` of lifetime colonization
- **Switch**, **bomb** and **laser** — the three abilities that exist
- **EXTRAS ability picker** — one button opening a modal, driven entirely by the
  registry in `src/ui/abilities.js`
- Laser: `LASER_LEN` positions from the clicked start in one of 8 directions,
  blocked positions skipped without extending the ray, one capture pass at the
  end. `laserPreview` drives the ghost so preview and reality cannot drift
- 2 and 3 player; online star-topology netcode, nicknames, win condition
- Board sizes 20 / 30 / 50 / 150 / 300

### Planned, not built

Verified against the current source: `bridgeAt`, `cityAt`, `freezeAt` and
`pendingPenalty` appear **nowhere** in the repo. None of the below exists yet —
do not assume otherwise. (The laser is built; see above.)

**Bridge.** Connect two of your own existing dots with a straight line. Same line
machinery as the laser, but both ends are chosen, so it is aimed rather than
sprayed. Legal only when the two dots are exactly aligned (row, column, or 45°).
Cheaper than the laser — it requires an existing position.

**Freeze.** The chosen opponent loses one move on their next turn. Needs a
per-player `pendingPenalty` consumed in `movesFor`. Sharper than it sounds in a
3-player game, where it decides who closes a loop first.

**City** (largest, do last). Buildable on **colonized** land only, generating
tokens per turn — this turns colonies into an economy rather than just a score,
and is the intended direction of the game.

- Store cities keyed by **square** index, not quarter-cell:
  `Map<squareIndex, {owner, level}>`. Placement requires all four quarters of the
  square owned *and* colonized.
- Decide up front what happens when a city's square changes hands or is
  destroyed by a blast. That rule is the whole balance of the feature.

**Balance warning.** Bombs already form a loop: bomb → colonize → earn tokens →
bomb. Cities add a second loop into the same currency. On a small board this
snowballs fast. The cheapest dials are `BOMB_COST` first, then `BOMB_SIZE`.

---

## Known issues

- **Residual interior gaps: ~206** in the 40-game stress run (down from 255
  before the `place` fix). Not zero. Attribute them to an action before chasing
  them — see convention 1.
- Hard AI is ~540 ms/move on a 300x300 board (one-ply lookahead clones the whole
  board). Pre-existing, unrelated to any recent change.
- No rejoin after a disconnect — remaining players are told and input locks.
- The AI is 2-player only. Three-player is online-only by design.
- **`oppOf()` in `constants.js` is 2-player only** — and is currently called from
  nowhere at all (its `// (AI paths)` comment is stale; grep confirms zero call
  sites). It is kept because it was part of the pre-migration public surface.
  Anything 3-player must use `nextOf()`.
