/* ================================================================
   GAME LOGIC — DOM-free, unit-testable.
   Imports nothing outside engine/, so it runs in node as-is.

   Territory (face detection): after a player pl adds lines, flood-fill
   the quarter-triangle graph from the OUTSIDE, treating only pl's
   edges as barriers. Every cell not reached and not already pl's
   becomes pl territory. This is planar face detection on a fixed
   embedding, and it inherently handles: concave shapes, nested loops,
   merging (union by ownership), triangle->square upgrades (0.5 -> 1.0),
   colonization of opponent cells, and multiple simultaneous captures.
   The board border is never a barrier, so loops must be fully closed
   by drawn lines. Nothing is ever deleted: dots/edges inside claimed
   territory stay in the data (future detection stays correct) and are
   merely hidden by the renderer, derived from cell ownership.
   ================================================================ */
'use strict';

import { COL_PER_SWITCH, COL_PER_MOVE, BOMB_COST, BOMB_SIZE,
         LASER_LEN, LASER_COST } from './constants.js';
import {
  pi, inP, inS, incidentCells, incidentEdges,
  blastBounds, inBlast, cellNeighbours, LASER_DIRS
} from './geometry.js';

export class Game {
  constructor(n, np){ this.reset(n, np); }

  reset(n, np){
    this.N = n;               // squares per side
    this.P = n + 1;           // points per side
    this.np = np || 2;        // number of players: 2 or 3
    const N = n, P = this.P;
    this.dots  = new Uint8Array(P * P);     // 0 empty / 1 blue / 2 red / 3 green
    this.hE    = new Uint8Array(P * P);     // horizontal edge owner
    this.vE    = new Uint8Array(P * P);     // vertical edge owner
    this.dA    = new Uint8Array(N * N);     // "\" diagonal owner
    this.dB    = new Uint8Array(N * N);     // "/" diagonal owner
    this.owner = new Uint8Array(N * N * 4); // quarter-cell owner
    this.colFlag = new Uint8Array(N * N * 4); // was colonized at some point
    this.visited = new Int32Array(N * N * 4); // flood epoch marks
    this.stack   = new Int32Array(N * N * 4);
    this.epoch = 0;
    this.scoreQ = [0, 0, 0, 0];  // quarter-cells owned, indexed by player
    this.colQ   = [0, 0, 0, 0];  // quarter-cells colonized and STILL HELD
    // Switch tokens are earned on lifetime colonization, not live holdings.
    // colQ goes down when ground is lost (by design), so paying tokens off it
    // would let a player farm: lose colonies, retake them, re-cross the
    // threshold, earn again. colEarnedQ only ever rises; spent is subtracted.
    this.colEarnedQ = [0, 0, 0, 0];
    this.switchSpent = [0, 0, 0, 0];
    this.dotList = [];        // {x,y} for fast candidate generation
    this.lastPlaced = [];     // recent placements for UI markers
  }

  // Turn order for 2 or 3 players: 1 -> 2 -> (3) -> 1
  nextOf(p){ return (p % this.np) + 1; }
  players(){ const a = []; for (let p = 1; p <= this.np; p++) a.push(p); return a; }

  pi(x, y){ return pi(this.P, x, y); }
  inP(x, y){ return inP(this.P, x, y); }
  inS(x, y){ return inS(this.N, x, y); }

  area(pl){ return this.scoreQ[pl] / 4; }
  colArea(pl){ return this.colQ[pl] / 4; }
  movesFor(pl){ return 1 + Math.floor(this.colQ[pl] / COL_PER_MOVE); }

  // One dot-switch earned per COL_PER_SWITCH quarters of lifetime colonization.
  switchesFor(pl){ return Math.floor(this.colEarnedQ[pl] / COL_PER_SWITCH) - this.switchSpent[pl]; }
  bombsFor(pl){ return Math.floor(this.switchesFor(pl) / BOMB_COST); }

  totalArea(){ return this.N * this.N; }
  // Win: hold more than a 1/np share of the WHOLE board (half for 2, third for 3).
  winner(){
    const need = this.totalArea() / this.np;
    for (let p = 1; p <= this.np; p++) if (this.area(p) > need) return p;
    return 0;
  }

  /* ---- point <-> incident quarter-cells -------------------------- */
  // See geometry.js — pure functions of the board dimensions.
  incidentCells(x, y, cb){ return incidentCells(this.N, x, y, cb); }

  pointInterior(x, y){ // strictly inside claimed territory -> placement blocked
    let any = false, all = true;
    this.incidentCells(x, y, c => { any = true; if (this.owner[c] === 0) all = false; });
    return any && all;
  }

  pointTouchesTerritory(x, y){ // on or inside territory -> dot hidden
    let t = false;
    this.incidentCells(x, y, c => { if (this.owner[c] > 0) t = true; });
    return t;
  }

  canPlace(x, y){
    return this.inP(x, y) && this.dots[this.pi(x, y)] === 0 && !this.pointInterior(x, y);
  }

  /* ---- legal auto-connections ------------------------------------ */
  // Edges a dot placed at (x,y) by pl would create. Non-mutating.
  // Enforces: dx<=1, dy<=1, same-square corners only, no crossings.
  newEdges(x, y, pl){
    const res = [];
    const { dots, dA, dB, P, N } = this;
    const at = (px, py) => px >= 0 && py >= 0 && px < P && py < P && dots[py * P + px] === pl;

    if (at(x + 1, y)) res.push({ t: 0, i: y * P + x });           // hE right
    if (at(x - 1, y)) res.push({ t: 0, i: y * P + (x - 1) });     // hE left
    if (at(x, y + 1)) res.push({ t: 1, i: y * P + x });           // vE down
    if (at(x, y - 1)) res.push({ t: 1, i: (y - 1) * P + x });     // vE up

    // Diagonals — blocked if the crossing (opposite) diagonal exists.
    if (at(x + 1, y + 1) && this.inS(x, y)         && !dB[y * N + x])               res.push({ t: 2, i: y * N + x });               // p is TL, dA(x,y)
    if (at(x - 1, y - 1) && this.inS(x - 1, y - 1) && !dB[(y - 1) * N + (x - 1)])   res.push({ t: 2, i: (y - 1) * N + (x - 1) });   // p is BR
    if (at(x + 1, y - 1) && this.inS(x, y - 1)     && !dA[(y - 1) * N + x])         res.push({ t: 3, i: (y - 1) * N + x });         // p is BL, dB(x,y-1)
    if (at(x - 1, y + 1) && this.inS(x - 1, y)     && !dA[y * N + (x - 1)])         res.push({ t: 3, i: y * N + (x - 1) });         // p is TR, dB(x-1,y)
    return res;
  }

  _edgeArr(t){ return t === 0 ? this.hE : t === 1 ? this.vE : t === 2 ? this.dA : this.dB; }
  // Never overwrite another player's line. An edge slot has a single owner, and
  // resealBorders/bombAt create borders owned by whoever holds the GROUND
  // rather than derived from dots — so a slot can already be someone's
  // territory boundary while both its lattice points sit empty, free for
  // another player to build on. Stealing it fences their region in our colour,
  // and because applyEdges runs BEFORE flood(), a stolen slot would also be a
  // live barrier in the very capture that follows.
  //
  // Returns the edges actually written, so revertEdges can undo exactly those
  // — reverting the full requested list would zero a slot we never owned.
  applyEdges(list, pl){
    const applied = [];
    for (const e of list){
      const arr = this._edgeArr(e.t);
      if (arr[e.i] && arr[e.i] !== pl) continue;
      arr[e.i] = pl; applied.push(e);
    }
    return applied;
  }
  revertEdges(list){ for (const e of list) this._edgeArr(e.t)[e.i] = 0; }

  /* ---- planar face detection: flood from outside ----------------- */
  flood(pl){
    const { N, P, hE, vE, dA, dB, visited, stack } = this;
    const ep = ++this.epoch;
    let sp = 0;
    const push = c => { if (visited[c] !== ep){ visited[c] = ep; stack[sp++] = c; } };

    // Outside seeds — board border is never a barrier.
    for (let sx = 0; sx < N; sx++){
      if (hE[sx]           !== pl) push((sx) * 4 + 0);                 // top row, N tris
      if (hE[N * P + sx]   !== pl) push(((N - 1) * N + sx) * 4 + 2);   // bottom row, S tris
    }
    for (let sy = 0; sy < N; sy++){
      if (vE[sy * P]       !== pl) push((sy * N) * 4 + 3);             // left col, W tris
      if (vE[sy * P + N]   !== pl) push((sy * N + (N - 1)) * 4 + 1);   // right col, E tris
    }

    while (sp > 0){
      const c = stack[--sp];
      const t = c & 3, s = c >> 2;
      const sx = s % N, sy = (s / N) | 0, b = s * 4;

      // In-square neighbours. Pair (t, t+1) is blocked by dB when t is
      // even, by dA when t is odd (N-E:dB, E-S:dA, S-W:dB, W-N:dA).
      const n1 = (t + 1) & 3;
      if (((t & 1) === 0 ? dB[s] : dA[s]) !== pl) push(b + n1);
      const n2 = (t + 3) & 3;
      if (((n2 & 1) === 0 ? dB[s] : dA[s]) !== pl) push(b + n2);

      // Cross-square neighbours through h/v edge slots.
      if      (t === 0){ if (sy > 0     && hE[sy * P + sx]       !== pl) push(((sy - 1) * N + sx) * 4 + 2); }
      else if (t === 1){ if (sx < N - 1 && vE[sy * P + sx + 1]   !== pl) push((sy * N + sx + 1) * 4 + 3); }
      else if (t === 2){ if (sy < N - 1 && hE[(sy + 1) * P + sx] !== pl) push(((sy + 1) * N + sx) * 4 + 0); }
      else             { if (sx > 0     && vE[sy * P + sx]       !== pl) push((sy * N + sx - 1) * 4 + 1); }
    }
  }

  // Claim every cell unreachable from outside that pl doesn't own yet.
  commitCapture(pl){
    const { owner, visited, colFlag } = this;
    const ep = this.epoch;
    let q = 0, colq = 0;
    for (let c = 0; c < owner.length; c++){
      if (visited[c] !== ep && owner[c] !== pl){
        const prev = owner[c];
        if (prev !== 0){
          // Colonization from whichever player held it — with 3 players this
          // can be either opponent within a single capture, so debit per-cell
          // rather than assuming a single "the opponent".
          colq++; this.scoreQ[prev]--;
          // prev is losing this cell, so if it was counting toward prev's
          // *currently held* colonized total, remove that credit — colQ
          // must track live colonized holdings, not lifetime history,
          // or bonus moves (movesFor) get awarded for ground already lost.
          if (colFlag[c]) this.colQ[prev]--;
          colFlag[c] = 1;
        }
        owner[c] = pl; this.scoreQ[pl]++; q++;
      }
    }
    this.colQ[pl] += colq;
    this.colEarnedQ[pl] += colq;   // lifetime, monotonic — drives switch tokens
    return { q, colq };
  }

  // After a capture, delete edges that are strictly INTERIOR to a single
  // player's territory (both adjacent quarter-cells owned by the same
  // player). These are exactly the lines the renderer already hides, so
  // this is visually a no-op — colFlag, ownership and the colonized tint
  // are all untouched.
  //
  // Why it's necessary: flood(pl) treats every one of pl's edges as a
  // barrier, board-wide and forever. An old loop left buried inside
  // territory that has since changed hands keeps its interior permanently
  // unreachable, so commitCapture re-claims it on ANY later move by pl
  // that triggers a flood — even a move on the far side of the board that
  // encloses nothing. Clearing buried edges removes that free re-capture
  // while leaving a genuine new enclosure fully able to take the ground back.
  clearInteriorEdges(){
    const { N, P, owner, hE, vE, dA, dB } = this;
    for (let y = 0; y <= N; y++){
      for (let x = 0; x < N; x++){
        const i = y * P + x;
        if (hE[i]){
          const above = y > 0 ? owner[((y - 1) * N + x) * 4 + 2] : 0;
          const below = y < N ? owner[(y * N + x) * 4 + 0]       : 0;
          if (above > 0 && above === below) hE[i] = 0;
        }
      }
    }
    for (let y = 0; y < N; y++){
      for (let x = 0; x <= N; x++){
        const i = y * P + x;
        if (vE[i]){
          const left  = x > 0 ? owner[(y * N + (x - 1)) * 4 + 1] : 0;
          const right = x < N ? owner[(y * N + x) * 4 + 3]       : 0;
          if (left > 0 && left === right) vE[i] = 0;
        }
      }
    }
    for (let s = 0; s < N * N; s++){
      if (dA[s]){ const a = owner[s * 4 + 0], b = owner[s * 4 + 2]; if (a > 0 && a === b) dA[s] = 0; }
      if (dB[s]){ const a = owner[s * 4 + 0], b = owner[s * 4 + 1]; if (a > 0 && a === b) dB[s] = 0; }
    }
  }

  countCapture(pl){ // simulation: tally only, no mutation
    const { owner, visited } = this;
    const ep = this.epoch;
    let q = 0, colq = 0;
    for (let c = 0; c < owner.length; c++){
      if (visited[c] !== ep && owner[c] !== pl){ q++; if (owner[c] !== 0) colq++; }
    }
    return { q, colq };
  }

  /* ---- dot switch: spend a token to flip an opponent's dot --------- */
  // The 8 edge slots incident to lattice point (x,y) — see geometry.js.
  incidentEdges(x, y){ return incidentEdges(this.P, this.N, x, y); }

  canSwitch(x, y, pl){
    if (!this.inP(x, y)) return false;
    const d = this.dots[this.pi(x, y)];
    return d !== 0 && d !== pl && this.switchesFor(pl) > 0;
  }

  // Flip an enemy dot to pl. Edges are rewired (the victim's connections
  // through this point die, pl's legal connections form), then the normal
  // flood/capture runs — so a switch CAN close a loop and take territory.
  switchDot(x, y, pl){
    if (!this.canSwitch(x, y, pl)) return null;
    const idx = this.pi(x, y);
    const victim = this.dots[idx];

    // drop the victim's edges through this point
    for (const e of this.incidentEdges(x, y)){
      const arr = this._edgeArr(e.t);
      if (arr[e.i] === victim) arr[e.i] = 0;
    }

    this.dots[idx] = pl;

    // The victim's surviving dots may now connect in ways they could not while
    // the switched dot was theirs — this is what rebuilds the triangle.
    this.rederiveEdgesAround(x, y, victim);
    const eds = this.newEdges(x, y, pl);
    this.applyEdges(eds, pl);

    // The victim keeps only what their own remaining lines still enclose.
    const shrunk = this.recomputeHoldings(victim);

    // The switcher captures only if this genuinely closed one of THEIR loops,
    // so a switch is a disruption tool rather than a land grab.
    let cap = { q: 0, colq: 0 };
    if (eds.length >= 2){
      this.flood(pl);
      cap = this.commitCapture(pl);
    }
    this.clearInteriorEdges();
    this.resealBorders();
    this.reownBorders();
    this.switchSpent[pl]++;
    this.lastPlaced.push({ x, y, pl, time: (typeof performance !== 'undefined' ? performance.now() : 0) });
    if (this.lastPlaced.length > 12) this.lastPlaced.shift();
    return { victim, edges: eds.length, gainedQ: cap.q, colQ: cap.colq, freedQ: shrunk.freed };
  }

  // Re-derive `who`'s edges around a point whose ownership just changed.
  //
  // Edges are DERIVED FROM DOTS, not accumulated state. The engine otherwise
  // only ever adds an edge when a dot is placed, which is safe while dots are
  // never removed — but a switch takes a dot out of a player's structure, and
  // that can make a connection legal that never was before. Closing a 1x1
  // square leaves both diagonals absent; switch the top-left corner away and
  // the two surviving corners can finally see each other across the "/"
  // diagonal, which is what lets the victim keep a triangle instead of an
  // L-shape enclosing nothing. newEdges enforces the crossing rule, so a
  // diagonal is never added opposite an existing one.
  rederiveEdgesAround(x, y, who){
    for (let dy = -1; dy <= 1; dy++){
      for (let dx = -1; dx <= 1; dx++){
        const nx = x + dx, ny = y + dy;
        if ((dx === 0 && dy === 0) || !this.inP(nx, ny)) continue;
        if (this.dots[this.pi(nx, ny)] !== who) continue;
        for (const e of this.newEdges(nx, ny, who)){
          const arr = this._edgeArr(e.t);
          if (!arr[e.i]) arr[e.i] = who;
        }
      }
    }
  }

  // Recompute what `who` holds: their territory becomes EXACTLY what their
  // remaining lines enclose.
  //
  // A switch takes a DOT, not ground. Ground they can no longer fence in goes
  // neutral — it does NOT transfer to the switcher, who has no loop around it;
  // handing it over would fence the switcher's new territory with the victim's
  // lines, and every boundary line of a region must belong to that region's
  // owner.
  //
  // The claim half matters as much as the release half. Re-deriving edges can
  // legally add a diagonal that re-cuts a square, leaving a quarter enclosed
  // but unowned — and a lone owned quarter is one of the 66 unfenceable
  // states. Owning everything enclosed keeps every square legal. Only neutral
  // ground is claimed: a third party's cells are never colonized by a move
  // someone else made.
  //
  // Released ground stops being anyone's colony, so colQ drops and colFlag
  // clears — otherwise a later capture of it as NEUTRAL would leave colQ short
  // of the live truth, since commitCapture only credits colonization when it
  // takes from a player. colEarnedQ is lifetime and never moves here, so
  // releasing and retaking cannot farm tokens.
  recomputeHoldings(who){
    this.flood(who);
    const { owner, visited, colFlag } = this;
    const ep = this.epoch;
    let freed = 0, kept = 0;
    for (let c = 0; c < owner.length; c++){
      const reachable = visited[c] === ep;
      if (owner[c] === who && reachable){
        owner[c] = 0; this.scoreQ[who]--;
        if (colFlag[c]){ this.colQ[who]--; colFlag[c] = 0; }
        freed++;
      } else if (owner[c] === 0 && !reachable){
        owner[c] = who; this.scoreQ[who]++;
        if (colFlag[c]) this.colQ[who]++;   // keep colQ == live colonized truth
        kept++;
      }
    }
    return { freed, kept };
  }

  /* ---- BOMB: spend BOMB_COST tokens to flatten a square ------------ */
  // Blast covers a BOMB_SIZE square centred on square (cx,cy), clipped to the
  // board so a centre near the edge still works.
  blastBounds(cx, cy){ return blastBounds(this.N, cx, cy); }
  inBlast(c, b){ return inBlast(this.N, c, b); }

  // Geometric neighbours of a quarter-cell, IGNORING lines — see geometry.js.
  cellNeighbours(c, out){ return cellNeighbours(this.N, c, out); }

  // RENDER-ONLY border lookup. A blast can leave territory on a frontier that
  // never had a drawn line (the boundary used to be interior), so the outline
  // has to be derived from ownership at draw time. This deliberately does NOT
  // store an edge: a real edge is a flood barrier, and handing the victim a
  // barrier that happens to ring the blast lets them reclaim the whole thing
  // for free on their next move anywhere on the board.
  // Returns the player whose outline should be drawn, or 0 for none.
  hBorderOwner(x, y){
    const N = this.N;
    if (this.hE[y * this.P + x]) return 0;            // a real line is already drawn
    const a = y > 0 ? this.owner[((y - 1) * N + x) * 4 + 2] : 0;
    const b = y < N ? this.owner[(y * N + x) * 4 + 0]       : 0;
    if (a === b) return 0;
    return (a && b) ? Math.min(a, b) : (a || b);
  }
  vBorderOwner(x, y){
    const N = this.N;
    if (this.vE[y * this.P + x]) return 0;
    const a = x > 0 ? this.owner[(y * N + (x - 1)) * 4 + 1] : 0;
    const b = x < N ? this.owner[(y * N + x) * 4 + 3]       : 0;
    if (a === b) return 0;
    return (a && b) ? Math.min(a, b) : (a || b);
  }

  canBomb(pl){ return this.bombsFor(pl) > 0; }

  // Every piece of territory must have a line where it meets empty ground.
  // Destroying the ring turns owned cells neutral, and the line that used to
  // sit there was an interior line (already cleared) or got stripped with the
  // dead ground — leaving a survivor with an open side. This re-draws those
  // borders, owned by whoever still holds the ground.
  //
  // Only ever ADDS, and only between two real in-board cells: putting a line
  // on the board rim would stop flood() seeding from that side and make the
  // whole outside look enclosed.
  resealBorders(){
    const { N, P, owner, hE, vE } = this;
    for (let y = 1; y < N; y++){
      for (let x = 0; x < N; x++){
        const i = y * P + x;
        if (hE[i]) continue;
        const above = owner[((y - 1) * N + x) * 4 + 2];
        const below = owner[(y * N + x) * 4 + 0];
        if (above > 0 && below === 0) hE[i] = above;
        else if (below > 0 && above === 0) hE[i] = below;
      }
    }
    for (let y = 0; y < N; y++){
      for (let x = 1; x < N; x++){
        const i = y * P + x;
        if (vE[i]) continue;
        const left  = owner[(y * N + (x - 1)) * 4 + 1];
        const right = owner[(y * N + x) * 4 + 3];
        if (left > 0 && right === 0) vE[i] = left;
        else if (right > 0 && left === 0) vE[i] = right;
      }
    }
    // A square legally split along a diagonal must still carry that diagonal.
    // Stripping edges through a switched point can take it away and leave the
    // fill with no separator. Restore it only where the split genuinely exists
    // and the opposite diagonal is absent, so the crossing rule still holds.
    for (let s = 0; s < N * N; s++){
      if (this.dA[s] || this.dB[s]) continue;
      const b = s * 4, qn = owner[b], qe = owner[b+1], qs = owner[b+2], qw = owner[b+3];
      if (qn === qe && qs === qw && qn !== qs)      this.dA[s] = qn || qs;  // {N,E}|{S,W}
      else if (qn === qw && qe === qs && qn !== qe) this.dB[s] = qn || qe;  // {N,W}|{E,S}
    }
  }
  // Every boundary line of a region must belong to that region's owner.
  //
  // resealBorders only ever ADDS a missing line — deliberately, and there is a
  // test pinning that contract. But a line can end up owned by the wrong
  // player without ever going missing: when a switch collapses one player's
  // enclosure, ground next to ANOTHER player's existing territory turns empty,
  // and the line already sitting on that seam still belongs to the player who
  // drew it. Edge slots have a single owner, so the two cannot share it — and
  // the region's owner is the one that must hold it, exactly as reseal would
  // have assigned it had the slot been empty.
  //
  // Only ever re-owns a line that already exists on a territory|empty seam;
  // never creates one, never touches a line between two owned regions or two
  // empty cells (a free construction line stays with whoever drew it).
  reownBorders(){
    const { N, P, owner, hE, vE } = this;
    const fix = (arr, i, a, b) => {
      const line = arr[i];
      if (!line) return;
      if ((a > 0) === (b > 0)) return;
      const holder = a > 0 ? a : b;
      if (line !== holder) arr[i] = holder;
    };
    for (let sy = 0; sy < N; sy++){
      for (let sx = 0; sx < N; sx++){
        const s = sy * N + sx, b = s * 4;
        fix(hE, sy * P + sx, owner[b + 0], sy > 0 ? owner[((sy - 1) * N + sx) * 4 + 2] : 0);
        fix(vE, sy * P + sx, owner[b + 3], sx > 0 ? owner[(sy * N + sx - 1) * 4 + 1] : 0);
        if (sy === N - 1) fix(hE, (sy + 1) * P + sx, owner[b + 2], 0);
        if (sx === N - 1) fix(vE, sy * P + sx + 1, owner[b + 1], 0);
        fix(this.dA, s, owner[b + 0], owner[b + 2]);   // {N,E} | {S,W}
        fix(this.dB, s, owner[b + 0], owner[b + 1]);   // {N,W} | {E,S}
      }
    }
  }

  killEdgesAround(c){
    const N = this.N, P = this.P, t = c & 3, s = c >> 2, sx = s % N, sy = (s / N) | 0;
    if (t === 0){ this.hE[sy * P + sx] = 0; this.dB[s] = 0; this.dA[s] = 0; }
    if (t === 1){ this.vE[sy * P + sx + 1] = 0; this.dB[s] = 0; this.dA[s] = 0; }
    if (t === 2){ this.hE[(sy + 1) * P + sx] = 0; this.dB[s] = 0; this.dA[s] = 0; }
    if (t === 3){ this.vE[sy * P + sx] = 0; this.dB[s] = 0; this.dA[s] = 0; }
  }

  // Blast rules:
  //  - inside the square: enemy ground is colonized, neutral ground is claimed
  //  - the one-square ring immediately around it: enemy ground is DESTROYED
  //    (back to neutral, lines stripped) — this is what severs a region
  //  - anything further away keeps its owner: a 3x2 clipped on one side
  //    leaves 1x2 taken, 1x2 destroyed, 1x2 still the victim's
  //  - the blast draws its own perimeter, so the new territory has a real
  //    border that blocks placement instead of an invisible edge
  bombAt(cx, cy, pl){
    if (!this.inS(cx, cy) || !this.canBomb(pl)) return null;
    const b = this.blastBounds(cx, cy);
    const { owner, colFlag, N, P } = this;
    let gained = 0, colq = 0, dissolved = 0;

    // 1. inside the blast
    for (let sy = b.y0; sy <= b.y1; sy++){
      for (let sx = b.x0; sx <= b.x1; sx++){
        const base = (sy * N + sx) * 4;
        for (let t = 0; t < 4; t++){
          const c = base + t, prev = owner[c];
          if (prev === pl) continue;
          if (prev !== 0){
            this.scoreQ[prev]--;
            if (colFlag[c]) this.colQ[prev]--;
            colFlag[c] = 1; colq++;
          }
          owner[c] = pl; this.scoreQ[pl]++; gained++;
        }
      }
    }

    // 2. the adjacent ring — enemy ground here is destroyed, not taken
    const rx0 = Math.max(0, b.x0 - 1), rx1 = Math.min(N - 1, b.x1 + 1);
    const ry0 = Math.max(0, b.y0 - 1), ry1 = Math.min(N - 1, b.y1 + 1);
    for (let sy = ry0; sy <= ry1; sy++){
      for (let sx = rx0; sx <= rx1; sx++){
        if (sx >= b.x0 && sx <= b.x1 && sy >= b.y0 && sy <= b.y1) continue; // inside, handled
        const base = (sy * N + sx) * 4;
        for (let t = 0; t < 4; t++){
          const c = base + t, prev = owner[c];
          if (prev === 0 || prev === pl) continue;
          this.scoreQ[prev]--;
          if (colFlag[c]) this.colQ[prev]--;
          owner[c] = 0; colFlag[c] = 0; dissolved++;
          this.killEdgesAround(c);      // no orphan outline over dead ground
        }
      }
    }

    // 3. the blast draws its own wall: dots + edges around the square
    const px1 = b.x1 + 1, py1 = b.y1 + 1;
    const claimPoint = (x, y) => {
      const i = y * P + x, prev = this.dots[i];
      if (prev === pl) return;
      if (prev !== 0) for (const e of this.incidentEdges(x, y)){
        const arr = this._edgeArr(e.t);
        if (arr[e.i] === prev) arr[e.i] = 0;   // victim's links through this point die
      }
      this.dots[i] = pl;
      if (prev === 0) this.dotList.push({ x, y });
    };
    for (let x = b.x0; x <= px1; x++){ claimPoint(x, b.y0); claimPoint(x, py1); }
    for (let y = b.y0; y <= py1; y++){ claimPoint(b.x0, y); claimPoint(px1, y); }
    for (let x = b.x0; x <= b.x1; x++){ this.hE[b.y0 * P + x] = pl; this.hE[py1 * P + x] = pl; }
    for (let y = b.y0; y <= b.y1; y++){ this.vE[y * P + b.x0] = pl; this.vE[y * P + px1] = pl; }

    this.colQ[pl] += colq;
    this.colEarnedQ[pl] += colq;          // bombs feed the token economy
    this.switchSpent[pl] += BOMB_COST;
    this.clearInteriorEdges();
    this.resealBorders();   // survivors must not be left with an open side
    this.lastPlaced.push({ x: cx, y: cy, pl, time: (typeof performance !== 'undefined' ? performance.now() : 0) });
    if (this.lastPlaced.length > 12) this.lastPlaced.shift();
    return { gainedQ: gained, colQ: colq, dissolvedQ: dissolved, bounds: b };
  }

  /* ---- LASER: spend LASER_COST tokens to draw a line of dots -------- */
  // The ray is LASER_LEN POSITIONS long starting AT (x,y) — not LASER_LEN dots.
  // A blocked position gets no dot and the ray continues past it; it does not
  // extend further to compensate, so fewer than LASER_LEN dots may land. That
  // is the whole strategic point: blocking a laser path is a real defensive
  // move, because the two dots either side of a skip are 2 apart and no edge
  // forms between them.
  laserRay(x, y, dir){
    const out = [];
    if (!Number.isInteger(dir) || dir < 0 || dir > 7 || !this.inP(x, y)) return out;
    const [dx, dy] = LASER_DIRS[dir];
    for (let i = 0; i < LASER_LEN; i++){
      const px = x + dx * i, py = y + dy * i;
      if (!this.inP(px, py)) break;   // a straight ray never re-enters the board
      out.push({ x: px, y: py, willLand: this.canPlace(px, py) });
    }
    return out;
  }

  // Would an edge of pl exist between the adjacent points a and b once the ray
  // has been fired? Mirrors newEdges + applyEdges: both ends must hold pl's
  // dot, the slot must be free or already pl's, and a diagonal is refused if
  // the opposite diagonal of that square exists.
  _wouldConnect(ax, ay, bx, by, pl, landing){
    const N = this.N, P = this.P;
    const has = (px, py) => this.dots[py * P + px] === pl || landing.has(py * P + px);
    if (!has(ax, ay) || !has(bx, by)) return false;
    const dx = bx - ax, dy = by - ay;
    let arr, i, opp = null;
    if (dy === 0)      { arr = this.hE; i = ay * P + Math.min(ax, bx); }
    else if (dx === 0) { arr = this.vE; i = Math.min(ay, by) * P + ax; }
    else {
      // the square the diagonal cuts, and the diagonal that would cross it
      const sx = Math.min(ax, bx), sy = Math.min(ay, by);
      if (!inS(N, sx, sy)) return false;
      if (dx === dy) { arr = this.dA; i = sy * N + sx; opp = this.dB[i]; }   // "\"
      else           { arr = this.dB; i = sy * N + sx; opp = this.dA[i]; }   // "/"
    }
    if (opp) return false;
    return !arr[i] || arr[i] === pl;
  }

  // Non-mutating prediction the ghost renders from. `ok` is true exactly when
  // laserAt would succeed, and `links[i]` says whether positions i and i+1 end
  // up joined — so a skipped opponent dot shows as a real gap, while a skipped
  // dot of your own still reads as a continuous run.
  laserPreview(x, y, dir, pl){
    const positions = this.laserRay(x, y, dir);
    const landing = new Set();
    for (const p of positions) if (p.willLand) landing.add(p.y * this.P + p.x);
    const links = [];
    for (let i = 0; i + 1 < positions.length; i++){
      const a = positions[i], b = positions[i + 1];
      links.push(this._wouldConnect(a.x, a.y, b.x, b.y, pl, landing));
    }
    const landed = landing.size;
    return { positions, links, landed, ok: landed > 0 && this.canLaser(pl) };
  }

  canLaser(pl){ return this.switchesFor(pl) >= LASER_COST; }

  laserAt(x, y, dir, pl){
    if (!this.canLaser(pl)) return null;
    const ray = this.laserRay(x, y, dir);
    const positions = ray.filter(p => p.willLand).map(p => ({ x: p.x, y: p.y }));
    if (!positions.length) return null;   // never spend a token on a dead ray

    // Apply as we go: that is what lets consecutive laser dots connect to each
    // other, since newEdges only sees dots that already exist.
    for (const p of positions){
      this.dots[this.pi(p.x, p.y)] = pl;
      this.dotList.push({ x: p.x, y: p.y });
      this.applyEdges(this.newEdges(p.x, p.y, pl), pl);
    }

    // One capture pass for the whole line, not one per dot.
    this.flood(pl);
    const cap = this.commitCapture(pl);
    if (cap.q > 0) this.clearInteriorEdges();
    this.reownBorders();

    this.switchSpent[pl] += LASER_COST;
    const t = (typeof performance !== 'undefined' ? performance.now() : 0);
    for (const p of positions){
      this.lastPlaced.push({ x: p.x, y: p.y, pl, time: t });
      if (this.lastPlaced.length > 12) this.lastPlaced.shift();
    }
    return { landed: positions.length, gainedQ: cap.q, colQ: cap.colq, positions };
  }

  /* ---- the single mutation API (human and AI both use this) ------ */
  place(x, y, pl){
    if (!this.canPlace(x, y)) return null;
    this.dots[this.pi(x, y)] = pl;
    this.dotList.push({ x, y });
    const eds = this.newEdges(x, y, pl);
    this.applyEdges(eds, pl);
    let cap = { q: 0, colq: 0 };
    // Any new loop must pass through the new dot, which needs >=2 new
    // edges — so capture is only possible in that case.
    if (eds.length >= 2){
      this.flood(pl);
      cap = this.commitCapture(pl);
      if (cap.q > 0) this.clearInteriorEdges();
    }
    // Safety net. The applyEdges guard prevents the switcher/placer from
    // STEALING a boundary, but a capture can still strand one: commitCapture
    // claims ground next to a line another player drew, leaving their line
    // fencing our region. Prevention cannot reach that case, so repair it.
    this.reownBorders();
    this.lastPlaced.push({ x, y, pl, time: (typeof performance !== 'undefined' ? performance.now() : 0) });
    if (this.lastPlaced.length > 12) this.lastPlaced.shift();
    return { edges: eds.length, gainedQ: cap.q, colQ: cap.colq };
  }

  simPlace(x, y, pl){ // try a move, measure capture, roll everything back
    if (!this.canPlace(x, y)) return null;
    const idx = this.pi(x, y);
    this.dots[idx] = pl;
    const eds = this.newEdges(x, y, pl);
    const res = { q: 0, colq: 0, edges: eds.length };
    if (eds.length >= 2){
      const applied = this.applyEdges(eds, pl);
      this.flood(pl);
      const r = this.countCapture(pl);
      res.q = r.q; res.colq = r.colq;
      this.revertEdges(applied);
    }
    this.dots[idx] = 0;
    return res;
  }

  /* ---- render-side visibility (derived, never stored) ------------ */
  // 0 = hidden interior line, 1 = territory boundary, 2 = free construction line
  hEdgeVis(x, y){
    const N = this.N;
    const above = (y > 0) ? this.owner[((y - 1) * N + x) * 4 + 2] : 0; // S tri of square above
    const below = (y < N) ? this.owner[(y * N + x) * 4 + 0]       : 0; // N tri of square below
    if (above > 0 && below > 0) return 0;
    return (above > 0 || below > 0) ? 1 : 2;
  }
  vEdgeVis(x, y){
    const N = this.N;
    const left  = (x > 0) ? this.owner[(y * N + (x - 1)) * 4 + 1] : 0; // E tri of left square
    const right = (x < N) ? this.owner[(y * N + x) * 4 + 3]       : 0; // W tri of right square
    if (left > 0 && right > 0) return 0;
    return (left > 0 || right > 0) ? 1 : 2;
  }
  dAVis(s){ // sides {N,E} vs {S,W}; dB can't coexist so N==E and S==W here
    const a = this.owner[s * 4 + 0], b = this.owner[s * 4 + 2];
    if (a > 0 && b > 0) return 0;
    return (a > 0 || b > 0) ? 1 : 2;
  }
  dBVis(s){ // sides {N,W} vs {E,S}
    const a = this.owner[s * 4 + 0], b = this.owner[s * 4 + 1];
    if (a > 0 && b > 0) return 0;
    return (a > 0 || b > 0) ? 1 : 2;
  }

  // Deep, independent copy — used by the hard-difficulty AI to look one move
  // ahead without touching the real game state. visited/stack are scratch
  // buffers (re-derived every flood() call) so they're reallocated fresh
  // rather than copied.
  clone(){
    const g = Object.create(Game.prototype);
    g.N = this.N; g.P = this.P; g.np = this.np;
    g.dots = this.dots.slice();
    g.hE = this.hE.slice();
    g.vE = this.vE.slice();
    g.dA = this.dA.slice();
    g.dB = this.dB.slice();
    g.owner = this.owner.slice();
    g.colFlag = this.colFlag.slice();
    g.visited = new Int32Array(this.visited.length);
    g.stack = new Int32Array(this.stack.length);
    g.epoch = 0;
    g.scoreQ = this.scoreQ.slice();
    g.colQ = this.colQ.slice();
    g.colEarnedQ = this.colEarnedQ.slice();
    g.switchSpent = this.switchSpent.slice();
    g.dotList = this.dotList.slice();
    g.lastPlaced = this.lastPlaced.slice();
    return g;
  }
}
