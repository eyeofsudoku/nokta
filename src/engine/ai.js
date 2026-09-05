/* ================================================================
   AI — tiered move selection. DOM-free.
   Drives the game only through the public Game API (place/simPlace/
   clone), so it never needs Game internals.
   ================================================================ */
'use strict';

import { HUMAN, AIP, oppOf, BOMB_COST, BOMB_SIZE, LASER_COST,
         COL_WIN_BONUS } from './constants.js';

/* ---- tiered AI: same rules, same place() API ---------------------
   easy/medium/hard share one scoring pass; hard adds a genuine one-ply
   lookahead via Game.clone(), penalizing AI moves that hand the human a
   big reply. Time-boxed so a cluttered 300-board still stays responsive. */
export const AI_TUNING = {
  easy:   { rndW: 10, simBudget: N => N <= 160 ? 8  : 5,  blockCap: N => N <= 160 ? 8  : 5,  blockChance: 0.5, lookahead: 0 },
  medium: { rndW: 3,  simBudget: N => N <= 160 ? 22 : 12, blockCap: N => N <= 160 ? 22 : 12, blockChance: 1.0, lookahead: 0 },
  hard:   { rndW: 1,  simBudget: N => N <= 160 ? 26 : 14, blockCap: N => N <= 160 ? 26 : 14, blockChance: 1.0, lookahead: 5 }
};

// Best-value closing move for player pl on board G, capped to a candidate
// shortlist for speed. Shared by threat-blocking and the hard-mode lookahead.
export function findBestReply(G, pl, cap){
  const P = G.P;
  const cand = new Set();
  for (const d of G.dotList){
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++){
      const nx = d.x + dx, ny = d.y + dy;
      if (nx < 0 || ny < 0 || nx >= P || ny >= P) continue;
      const k = ny * P + nx;
      if (G.dots[k] === 0) cand.add(k);
    }
  }
  let list = [];
  for (const k of cand){
    const x = k % P, y = (k / P) | 0;
    if (!G.canPlace(x, y)) continue;
    const eds = G.newEdges(x, y, pl).length;
    if (eds >= 2) list.push({ x, y, k, eds });
  }
  list.sort((a, b) => b.eds - a.eds);
  list = list.slice(0, cap);
  let best = null, bestV = 0;
  for (const t of list){
    const r = G.simPlace(t.x, t.y, pl);
    if (r){
      const v = r.q * 25 + r.colq * 45;
      if (v > bestV){ bestV = v; best = { x: t.x, y: t.y, k: t.k, value: v }; }
    }
  }
  return best;
}

// `pl` defaults to AIP, so every existing 3-argument call is unchanged.
// It exists because chooseAIAction scores a placement against a bomb on
// one scale, and a candidate scored for the wrong colour would compare
// the wrong two numbers. The AI is 2-player only (see CLAUDE.md), which
// is what makes oppOf valid here.
export function chooseAIMove(G, rnd, difficulty, pl){
  rnd = rnd || Math.random;
  pl = pl || AIP;
  const opp = oppOf(pl);
  const tune = AI_TUNING[difficulty] || AI_TUNING.medium;
  const P = G.P, N = G.N;

  // Candidates: empty, legal points within Chebyshev 2 of any dot.
  const cand = new Set();
  for (const d of G.dotList){
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++){
      const nx = d.x + dx, ny = d.y + dy;
      if (nx < 0 || ny < 0 || nx >= P || ny >= P) continue;
      const k = ny * P + nx;
      if (G.dots[k] === 0) cand.add(k);
    }
  }

  const list = [];
  for (const k of cand){
    const x = k % P, y = (k / P) | 0;
    if (!G.canPlace(x, y)) continue;
    const eds = G.newEdges(x, y, pl);
    let diag = 0; for (const e of eds) if (e.t >= 2) diag++;
    let ownAdj = 0, oppAdj = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++){
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= P || ny >= P) continue;
      const v = G.dots[ny * P + nx];
      if (v === pl) ownAdj++; else if (v === opp) oppAdj++;
    }
    const s = eds.length * 5 + diag * 1.4 + ownAdj * 1.1 + oppAdj * 0.8 + rnd() * tune.rndW;
    list.push({ x, y, k, edges: eds.length, s });
  }
  if (!list.length) return null;

  list.sort((a, b) => b.s - a.s);

  // Deep-evaluate real capture potential for closable candidates.
  const simBudget = tune.simBudget(N);
  const deep = list.filter(o => o.edges >= 2).slice(0, simBudget);
  for (const o of deep){
    const r = G.simPlace(o.x, o.y, pl);
    if (r) o.s += r.q * 25 + r.colq * 45; // area*100, colonized extra
  }

  // Block the human's best immediate capture by taking that point.
  // Easy sometimes skips this on purpose so it stays beatable.
  if (rnd() < tune.blockChance){
    const bestT = findBestReply(G, opp, tune.blockCap(N));
    if (bestT){
      let f = list.find(o => o.k === bestT.k);
      if (!f){ f = { x: bestT.x, y: bestT.y, k: bestT.k, edges: 0, s: 0 }; list.push(f); }
      f.s += bestT.value * 0.95;
    }
  }

  list.sort((a, b) => b.s - a.s);

  // Hard only: for the top few candidates, actually play them out on a
  // clone and see how big a reply the human would get — then discount
  // moves that hand back a big capture. Time-boxed to stay responsive.
  if (tune.lookahead > 0){
    const started = performance.now();
    const timeBudgetMs = 380;
    const shortlist = list.slice(0, tune.lookahead);
    for (const o of shortlist){
      if (performance.now() - started > timeBudgetMs) break;
      const G2 = G.clone();
      G2.place(o.x, o.y, pl);
      const reply = findBestReply(G2, opp, Math.min(10, tune.blockCap(N)));
      if (reply) o.s -= reply.value * 0.9;
    }
    list.sort((a, b) => b.s - a.s);
  }

  return list[0];
}


/* ================================================================
   ABILITY-AWARE ACTION SELECTION

   An ability costs one move from the same pool as placing a dot, so a
   bomb and a placement compete for the same action and must be scored on
   one scale. That scale is AREA, because winScore is in area:

     score = gain + DENY_WEIGHT * deny

   gain is the actor's own winScore rise, which is the only thing that
   drives a 'threshold' win. deny is the opponent's winScore loss, which
   does NOT move the actor toward the threshold and only matters for the
   'exhausted' ending — hence the discount rather than equal weight.

   Measured on 20x20 with COL_WIN_BONUS=1, best action of each type:

     ply    place gain   switch(1t) gain/deny   bomb(5t) gain/deny
      40       0.3            3.0 / 0.4            26.1 /  1.1
     200       0.6            1.6 / 25.8           41.0 / 24.2
     320       0.6            0.8 / 49.0           45.3 / 33.1

   Two conclusions are baked into the policy below. A bomb outgains a
   placement by 50-90x, so tokens should be spent, not hoarded. And the
   switch inverts over the game: an early capture tool, a late pure
   demolition charge that barely helps the switcher win.
   ================================================================ */

export const DENY_WEIGHT = 0.4;

// Fraction of turns each tier is willing to use an ability at all. Easy
// stays beatable by mostly ignoring the strongest mechanic in the game.
export const ABILITY_TUNING = {
  easy:   { abilityChance: 0.35, switchCap: N => N <= 160 ? 4  : 2 },
  medium: { abilityChance: 0.85, switchCap: N => N <= 160 ? 8  : 4 },
  hard:   { abilityChance: 1.00, switchCap: N => N <= 160 ? 12 : 6 }
};

/* ---- exact bomb valuation, no cloning ---------------------------
   bombAt performs NO flood: every effect is per-quarter and fully
   determined by owner[] and colFlag[]. So the value of every target on
   the board is computable arithmetically, and the AI's bomb targeting is
   OPTIMAL rather than heuristic. Verified against real bombAt over 8000
   squares: max error 0 on both gain and deny, best target matched an
   exhaustive clone search 20/20.

     inside the blast : enemy -> mine AND flagged colonized (so it counts
                        1 + COL_WIN_BONUS to me), neutral -> mine (1)
     the ring around  : enemy -> destroyed to neutral

   The victim loses the same amount whether the ground was taken or
   destroyed, so denial is simply the enemy holdings over the blast box
   EXPANDED BY ONE — inside and ring in a single rectangle.

   Summed-area tables make each candidate O(1), so a whole 300x300 board
   costs one O(N^2) pass instead of 90000 clones. */
export function bombValueTable(G, pl){
  const { N, owner, colFlag } = G;
  const W = N + 1;
  const neu = new Int32Array(W * W), enm = new Int32Array(W * W), ecol = new Int32Array(W * W);
  for (let sy = 0; sy < N; sy++){
    for (let sx = 0; sx < N; sx++){
      const b = (sy * N + sx) * 4;
      let n = 0, e = 0, ec = 0;
      for (let t = 0; t < 4; t++){
        const c = b + t, o = owner[c];
        if (o === 0) n++;
        else if (o !== pl){ e++; if (colFlag[c]) ec++; }
      }
      const i = (sy + 1) * W + (sx + 1);
      neu[i]  = n  + neu[i - 1]  + neu[i - W]  - neu[i - W - 1];
      enm[i]  = e  + enm[i - 1]  + enm[i - W]  - enm[i - W - 1];
      ecol[i] = ec + ecol[i - 1] + ecol[i - W] - ecol[i - W - 1];
    }
  }
  const box = (T, x0, y0, x1, y1) =>
    T[(y1 + 1) * W + (x1 + 1)] - T[y0 * W + (x1 + 1)] - T[(y1 + 1) * W + x0] + T[y0 * W + x0];
  return { neu, enm, ecol, box, W };
}

// Gain and denial of bombing square (cx,cy), in area units. Exact.
export function bombValueAt(G, T, cx, cy){
  const N = G.N, h = (BOMB_SIZE - 1) >> 1;
  const x0 = Math.max(0, cx - h), x1 = Math.min(N - 1, cx + h);
  const y0 = Math.max(0, cy - h), y1 = Math.min(N - 1, cy + h);
  const gain = 0.25 * T.box(T.neu, x0, y0, x1, y1)
             + 0.25 * (1 + COL_WIN_BONUS) * T.box(T.enm, x0, y0, x1, y1);
  // inside AND ring in one rectangle: the victim loses the same either way
  const rx0 = Math.max(0, x0 - 1), rx1 = Math.min(N - 1, x1 + 1);
  const ry0 = Math.max(0, y0 - 1), ry1 = Math.min(N - 1, y1 + 1);
  const deny = 0.25 * (T.box(T.enm, rx0, ry0, rx1, ry1)
             + COL_WIN_BONUS * T.box(T.ecol, rx0, ry0, rx1, ry1));
  return { gain, deny };
}

export function bestBomb(G, pl){
  const T = bombValueTable(G, pl);
  let best = null;
  for (let cy = 0; cy < G.N; cy++){
    for (let cx = 0; cx < G.N; cx++){
      const v = bombValueAt(G, T, cx, cy);
      const s = v.gain + DENY_WEIGHT * v.deny;
      if (!best || s > best.score) best = { type: 'bomb', x: cx, y: cy, score: s, cost: BOMB_COST, ...v };
    }
  }
  return best;
}

/* ---- switch: needs a real clone, so shortlist first --------------
   switchDot runs recomputeHoldings on the victim, which is a flood — no
   closed form. Candidates are ranked by how much of the victim's
   structure passes through the dot (its incident edge count), because a
   dot carrying many of their lines is the one whose removal collapses an
   enclosure. Only the top few are actually simulated. */
export function bestSwitch(G, pl, cap){
  const opp = oppOf(pl), P = G.P;
  if (G.switchesFor(pl) < 1) return null;
  const shortlist = [];
  for (const d of G.dotList){
    const o = G.dots[d.y * P + d.x];
    if (o === 0 || o === pl) continue;
    let n = 0;
    for (const e of G.incidentEdges(d.x, d.y)) if (G._edgeArr(e.t)[e.i] === o) n++;
    if (n > 0) shortlist.push({ x: d.x, y: d.y, n });
  }
  shortlist.sort((a, b) => b.n - a.n);
  let best = null;
  for (const t of shortlist.slice(0, cap)){
    const g2 = G.clone();
    const beforeMe = G.winScore(pl), beforeOpp = G.winScore(opp);
    if (!g2.switchDot(t.x, t.y, pl)) continue;
    const gain = g2.winScore(pl) - beforeMe;
    const deny = beforeOpp - g2.winScore(opp);
    const s = gain + DENY_WEIGHT * deny;
    if (!best || s > best.score) best = { type: 'switch', x: t.x, y: t.y, score: s, cost: 1, gain, deny };
  }
  return best;
}

/* ---- the policy --------------------------------------------------
   Tokens are spent on whichever affordable action has the best score PER
   TOKEN, but only if nothing better is worth saving for. A bomb outscores
   a switch per token at every measured stage, so the effect of the
   savings rule is that the AI banks 1-4 tokens rather than frittering
   them on switches — and takes the switch only when it genuinely beats
   the bomb it is saving toward.

   The laser is deliberately absent. At equal cost to a bomb it measured
   3.1-7.0 gain against the bomb's 26-45, with essentially no denial: it
   is strictly dominated, and an AI that bought one would be playing
   worse on purpose. If LASER_COST or LASER_LEN is ever retuned, add it
   here as another candidate and re-measure — do not add it back
   untested for the sake of completeness. */
export function chooseAIAction(G, rnd, difficulty, pl){
  rnd = rnd || Math.random;
  pl = pl || AIP;
  const tune = ABILITY_TUNING[difficulty] || ABILITY_TUNING.medium;

  const move = chooseAIMove(G, rnd, difficulty, pl);
  let placeAct = null;
  if (move){
    const r = G.simPlace(move.x, move.y, pl);
    const gain = r ? (r.q + r.colq * COL_WIN_BONUS) / 4 : 0;
    const deny = r ? r.colq / 4 : 0;
    placeAct = { type: 'place', x: move.x, y: move.y,
                 score: gain + DENY_WEIGHT * deny, cost: 0, gain, deny };
  }

  const tokens = G.switchesFor(pl);
  if (tokens < 1 || rnd() > tune.abilityChance) return placeAct;

  // The bomb is scored even when unaffordable: that is what the savings
  // rule compares against, and it costs nothing to compute.
  const bomb = bestBomb(G, pl);
  const bombPer = bomb ? bomb.score / BOMB_COST : 0;

  if (G.canBomb(pl) && bomb && bomb.score > (placeAct ? placeAct.score : 0)) return bomb;

  const sw = bestSwitch(G, pl, tune.switchCap(G.N));
  if (sw && sw.score > bombPer && sw.score > (placeAct ? placeAct.score : 0)) return sw;

  return placeAct;
}
