/* ================================================================
   AI — tiered move selection. DOM-free.
   Drives the game only through the public Game API (place/simPlace/
   clone), so it never needs Game internals.
   ================================================================ */
'use strict';

import { HUMAN, AIP } from './constants.js';

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

export function chooseAIMove(G, rnd, difficulty){
  rnd = rnd || Math.random;
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
    const eds = G.newEdges(x, y, AIP);
    let diag = 0; for (const e of eds) if (e.t >= 2) diag++;
    let ownAdj = 0, oppAdj = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++){
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= P || ny >= P) continue;
      const v = G.dots[ny * P + nx];
      if (v === AIP) ownAdj++; else if (v === HUMAN) oppAdj++;
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
    const r = G.simPlace(o.x, o.y, AIP);
    if (r) o.s += r.q * 25 + r.colq * 45; // area*100, colonized extra
  }

  // Block the human's best immediate capture by taking that point.
  // Easy sometimes skips this on purpose so it stays beatable.
  if (rnd() < tune.blockChance){
    const bestT = findBestReply(G, HUMAN, tune.blockCap(N));
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
      G2.place(o.x, o.y, AIP);
      const reply = findBestReply(G2, HUMAN, Math.min(10, tune.blockCap(N)));
      if (reply) o.s -= reply.value * 0.9;
    }
    list.sort((a, b) => b.s - a.s);
  }

  return list[0];
}
