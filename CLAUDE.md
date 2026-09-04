# NOKTA — grid territory game

Two or three players place dots on a lattice. Dots of the same colour auto-connect
into lines; closing a loop claims the enclosed area. Claiming ground that already
belongs to an opponent is **colonization**, which drives the whole economy
(bonus moves and ability tokens).

Deployed at `https://eyeofsudoku.github.io/nokta/` via GitHub Pages.
**The served file must be named `index.html` at the repo root.**

---

## Working conventions (important)

0. **Run `node test/invariants.test.js` after any engine change.** It scans the
   whole board for illegal squares, open sides and ledger drift after every
   action, across full simulated games at each AI difficulty for 2 and 3
   players. It catches exactly the class of bug that reasoning misses.
1. **Invariant metrics count DISTINCT violations, never per-step sums.** A
   harness that adds the violation count after every action multiplies one
   long-lived violation by however many steps it survives. That is how a stress
   run once reported "230 mixed outlines" for what were **9** distinct ones,
   never more than 2 on the board at once — a 25x inflation that also pointed
   the blame at the wrong operation. Report distinct violations, max
   concurrent, and which action introduced each.
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
  property. Two things break it, both guarded in `switchDot`: `applyEdges`
  overwrites a slot unconditionally (slots have a single owner, and
  `resealBorders`/`bombAt` create borders owned by the ground-holder rather than
  by dots), and collapsing one player's enclosure can strand another player's
  territory against a line it does not own — `reownBorders()` fixes exactly
  those, and only on `territory|empty` seams.
- **Every square must be fenceable.** Inside a square the four quarters meet at
  the centre, and the only separators are the two diagonals — of which a square
  may hold **at most one**, since two would cross. So a square is outlineable in
  exactly three states:
    1. all four quarters the same owner,
    2. split by `dA`: `{N,E}` one owner, `{S,W}` another,
    3. split by `dB`: `{N,W}` one owner, `{E,S}` another.
  Across 3 owners (neutral/P1/P2) that is **15 of the 81 combinations — the
  other 66 cannot be outlined at all**. A square with one, or three, quarters of
  a given owner is invalid. Any operation writing `owner[]` must leave every
  touched square legal. A player's holdings must therefore always equal
  **exactly what their own lines enclose** — release what is no longer fenced in
  *and* claim what is, or a re-cut square can strand a lone owned quarter. A quarter-carve is not a
  rendering bug to paper over — the state itself is unrepresentable, and
  `dAVis()`/`dBVis()` document the assumption it breaks (`N==E`, `S==W`).
- Replaying the same ordered action stream on a fresh engine must reproduce a
  byte-identical board (this is what makes the netcode work — see below).

---

## `place` is no longer byte-identical to the original engine

Through the module migration and the `switchDot` rewrite, `place`/`bomb`/AI were
held byte-identical on purpose, to prove those changes were surgical. That no
longer holds, deliberately:

- `applyEdges` will not overwrite a slot owned by another player. Edge slots
  have a single owner, and `resealBorders`/`bombAt` create borders owned by the
  **ground holder** rather than derived from dots — so a slot can be someone's
  territory boundary while both its lattice points sit empty and free to build
  on. Placing there used to steal it. This matters beyond cosmetics because
  `applyEdges` runs *before* `flood()`, so a stolen slot is a live barrier in
  the capture that immediately follows. (Measured: in all 9 observed cases the
  capture result was unchanged, so nothing was mis-captured in practice — but
  the ordering makes it possible, and repair-after-the-fact cannot undo a
  capture.)
- `applyEdges` therefore returns the edges it actually wrote, and `revertEdges`
  must be given that list — reverting the full requested list would zero a slot
  we never owned. `simPlace` relies on this, so hard-AI lookahead now evaluates
  the position that would really result.
- `place` ends with `reownBorders()` as a safety net. Prevention cannot reach
  every case: a capture can *strand* a boundary, claiming ground next to a line
  another player drew. That still fires, so do not remove it.

Everything else about `place` is unchanged, and the five standard AI/bomb
scenarios still reproduce the pre-migration board exactly.

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

Two critical follow-ups, both of which fix real bugs — do not remove:

- **`clearInteriorEdges()`** — after a capture, delete edges whose two adjacent
  quarter-cells share the same owner. `flood(pl)` treats *every* edge `pl` owns
  as a barrier, board-wide and forever. An old loop buried inside territory that
  later changed hands keeps its interior permanently unreachable, so
  `commitCapture` re-claimed it on **any** later move by `pl` — even one on the
  far side of the board enclosing nothing. Visually a no-op (the renderer
  already hides those lines).
- **`resealBorders()`** — only used after a blast. Adds a line wherever owned
  ground meets empty ground and no line exists. **Only ever adds, and only
  between two real in-board cells** — putting a line on the board rim would stop
  `flood()` seeding from that side and make the entire outside look enclosed,
  causing a mass phantom capture. Must be a no-op on a normally-played board;
  there is a test for exactly that.

---

## Rules constants (single source of truth)

```js
const COL_PER_SWITCH = 40;   // quarter-cells of lifetime colonization per token (40 = 10 area)
const COL_PER_MOVE   = 400;  // quarter-cells of live colonization per bonus move (400 = 100 area)
const BOMB_COST      = 5;    // tokens per bomb
const BOMB_SIZE      = 5;    // blast is SIZE x SIZE squares; keep ODD
```

Turn order is `nextOf(p) = (p % np) + 1`. Win condition: hold more than
`totalArea() / np` of the **whole board** (half for 2 players, a third for 3).

> Reachability note: greedy local play never exceeds ~44% of the board *claimed
> in total*, so the win rule effectively cannot trigger through ordinary play.
> It is reachable by deliberately drawing one large enclosing loop, which
> captures 81–97% — but a loop that size costs ~72 moves on a 20x20 board and
> ~592 on 150x150. Board sizes 20/30/50 exist so the win condition is live.

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
| `{t:'seat',pl,np,size}` | host assigns a seat to a joining guest |
| `{t:'start',size,np}` | host starts the game (host-authoritative) |
| `{t:'name',pl,name}` | nickname broadcast |
| `{t:'left',pl}` | a player dropped |

Guards: a guest may only act as its own seat; an action is ignored unless
`msg.pl === currentPlayer`. New game and board size are host-only, otherwise
peers silently diverge onto different boards.

## Known issues

- Hard AI is ~540 ms/move on a 300x300 board (one-ply lookahead clones the whole
  board). Pre-existing, unrelated to any recent change.
- No rejoin after a disconnect — remaining players are told and input locks.
- The AI is 2-player only. Three-player is online-only by design.
