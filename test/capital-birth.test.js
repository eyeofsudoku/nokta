/* ================================================================
   Capital BIRTH tests.

   Self-contained: this file carries its own invariant checker rather
   than importing the one in invariants.test.js, so a change there
   cannot silently weaken this. Every capital run is compared against a
   BASELINE run of the same game with no capitals — the question is not
   "are there zero violations in the universe" but "did capitals make
   anything worse".

   Run: node test/capital-birth.test.js
   ================================================================ */
'use strict';

import { Game } from '../src/engine/game.js';
import { chooseAIMove } from '../src/engine/ai.js';
import { capitalAnchors, capitalSitesFrom, capitalSites } from '../src/engine/geometry.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL: ' + msg); } };

// deterministic PRNG so a failure is reproducible
const mulberry = seed => () => {
  seed |= 0; seed = seed + 0x6D2B79F5 | 0;
  let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

/* ---- invariant checker ------------------------------------------ */
function checkBoard(g){
  const { N, P, owner, hE, vE, dA, dB, colFlag } = g;
  const v = { ledger: 0, unfenceable: 0, openSide: 0, badOwner: 0, orphan: 0 };

  // ledger: scoreQ / colQ must equal what owner[] and colFlag[] actually say
  const sq = [0, 0, 0, 0], cq = [0, 0, 0, 0];
  for (let c = 0; c < owner.length; c++){
    if (owner[c]){ sq[owner[c]]++; if (colFlag[c]) cq[owner[c]]++; }
  }
  for (let p = 1; p <= g.np; p++){
    if (sq[p] !== g.scoreQ[p]) v.ledger++;
    if (cq[p] !== g.colQ[p])   v.ledger++;
    if (g.scoreQ[p] < 0 || g.colQ[p] < 0) v.ledger++;
  }

  const hasDot = (x, y, pl) => g.dots[y * P + x] === pl;

  for (let sy = 0; sy < N; sy++){
    for (let sx = 0; sx < N; sx++){
      const s = sy * N + sx, b = s * 4;
      const n = owner[b], e = owner[b + 1], so = owner[b + 2], w = owner[b + 3];

      // fenceable: all-same, or {N,E}|{S,W}, or {N,W}|{E,S}
      const allSame = (n === e && e === so && so === w);
      const splitA  = (n === e && so === w);
      const splitB  = (n === w && e === so);
      if (!(allSame || splitA || splitB)) v.unfenceable++;

      // open sides WITHIN the square (dA blocks E|S and W|N, dB blocks N|E and S|W)
      if (n !== e  && (n > 0 || e > 0)  && !dB[s]) v.openSide++;
      if (e !== so && (e > 0 || so > 0) && !dA[s]) v.openSide++;
      if (so !== w && (so > 0 || w > 0) && !dB[s]) v.openSide++;
      if (w !== n  && (w > 0 || n > 0)  && !dA[s]) v.openSide++;

      // open sides ACROSS interior seams
      if (sy > 0){
        const up = owner[((sy - 1) * N + sx) * 4 + 2];
        if (up !== n && (up > 0 || n > 0) && !hE[sy * P + sx]) v.openSide++;
      }
      if (sx > 0){
        const lf = owner[(sy * N + sx - 1) * 4 + 1];
        if (lf !== w && (lf > 0 || w > 0) && !vE[sy * P + sx]) v.openSide++;
      }
    }
  }

  // boundary ownership + orphan lines, on every h/v slot
  const slot = (arr, i, a, b, ax, ay, bx, by) => {
    const line = arr[i];
    if (!line) return;
    if (a > 0 !== b > 0){
      const holder = a > 0 ? a : b;
      if (line !== holder) v.badOwner++;
    } else if (a === 0 && b === 0){
      // legal only as a free construction line: real dots of that owner
      // at both ends. Otherwise it is an orphan left by a stripped region.
      if (!(hasDot(ax, ay, line) && hasDot(bx, by, line))) v.orphan++;
    }
  };
  for (let y = 0; y <= N; y++) for (let x = 0; x < N; x++){
    const a = y > 0 ? owner[((y - 1) * N + x) * 4 + 2] : 0;
    const b = y < N ? owner[(y * N + x) * 4 + 0] : 0;
    slot(hE, y * P + x, a, b, x, y, x + 1, y);
  }
  for (let y = 0; y < N; y++) for (let x = 0; x <= N; x++){
    const a = x > 0 ? owner[(y * N + x - 1) * 4 + 1] : 0;
    const b = x < N ? owner[(y * N + x) * 4 + 3] : 0;
    slot(vE, y * P + x, a, b, x, y, x, y + 1);
  }
  return v;
}
const total = v => v.ledger + v.unfenceable + v.openSide + v.badOwner + v.orphan;
const show  = v => `ledger=${v.ledger} unfenceable=${v.unfenceable} openSide=${v.openSide} badOwner=${v.badOwner} orphan=${v.orphan}`;

// board fingerprint, for replay-determinism checks
function fingerprint(g){
  const parts = [g.dots, g.hE, g.vE, g.dA, g.dB, g.owner, g.colFlag];
  let h = 2166136261;
  for (const a of parts) for (let i = 0; i < a.length; i++){
    h ^= a[i]; h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16) + ':' + g.scoreQ.join(',') + ':' + g.colQ.join(',');
}

/* ---- 1. birth alone is invariant-legal, on every anchor ---------- */
console.log('\n== 1. every legal layout births a legal board ==');
for (const N of [6, 8, 10, 20, 30]){
  for (const np of [2, 3]){
    let bad = 0, first = null;
    for (const a of capitalAnchors(N, np)){
      const g = new Game(N, np);
      g.foundCapitals(capitalSitesFrom(N, np, a.sx, a.sy));
      const v = checkBoard(g);
      if (total(v)){ bad++; if (!first) first = `anchor ${a.sx},${a.sy}: ${show(v)}`; }
    }
    ok(bad === 0, `N=${N} np=${np}: ${bad} layouts violate invariants. ${first || ''}`);
  }
}

/* ---- 2. the ledger says exactly 4 quarters, nothing colonized ---- */
console.log('\n== 2. capital ground is fresh, not colonized ==');
{
  let bad = 0;
  for (const N of [6, 10, 20, 50]) for (const np of [2, 3]){
    const g = new Game(N, np);
    g.foundCapitals(capitalSites(N, np, mulberry(7)));
    for (let p = 1; p <= np; p++){
      if (g.scoreQ[p] !== 4) bad++;                 // one square = 4 quarters
      if (g.colQ[p] !== 0) bad++;                   // never colonized
      if (g.colEarnedQ[p] !== 0) bad++;             // no free tokens at turn zero
      if (g.switchesFor(p) !== 0) bad++;
      if (g.capitalHolder(p) !== p) bad++;          // you start holding your own
    }
    if (g.colFlag.some(f => f)) bad++;
  }
  ok(bad === 0, `${bad} ledger deviations at birth`);
}

/* ---- 3. full games: capitals must not make anything worse -------- */
// chooseAIMove generates candidates within Chebyshev 2 OF AN EXISTING DOT,
// so on a bare board it returns null and no game happens at all. Capitals
// seed dotList with their corner dots; a baseline run does not. Both sides
// therefore get the same opening dots, or the comparison is between a real
// game and an empty board. movesPlayed is asserted for exactly that reason.
//
// chooseAIMove also always scores edges for AIP, so m.edges is wrong when
// placing as player 1. place()'s return value is the only truth.
console.log('\n== 3. full AI games, capitals vs baseline ==');
function playGame(withCap, seed, diff, capSites){
  const g = new Game(20, 2);
  if (withCap) g.foundCapitals(capSites);
  const rnd = mulberry(seed);
  // identical opening for both arms
  g.place(4, 15, 1); g.place(15, 4, 2);
  let pl = 1, worst = 0, moves = 0, ledger = 0, freeGrab = 0, monoBreak = 0;
  const lastEarned = [0, 0, 0, 0];
  for (let step = 0; step < 400; step++){
    const m = chooseAIMove(g, rnd, diff);
    if (!m) break;
    const before = g.scoreQ[pl];
    const res = g.place(m.x, m.y, pl);
    if (!res) break;
    moves++;
    const v = checkBoard(g);
    worst = Math.max(worst, total(v));
    ledger += v.ledger;
    if (res.edges < 2 && g.scoreQ[pl] > before) freeGrab++;
    for (let p = 1; p <= 2; p++){
      if (g.colEarnedQ[p] < lastEarned[p]) monoBreak++;
      lastEarned[p] = g.colEarnedQ[p];
    }
    if (g.gameResult().over) break;
    pl = g.nextOf(pl);
  }
  return { worst, moves, ledger, freeGrab, monoBreak, g };
}

for (const diff of ['easy', 'medium', 'hard']){
  let baseWorst = 0, capWorst = 0, baseMoves = 0, capMoves = 0;
  let ledger = 0, freeGrab = 0, monoBreak = 0;
  for (let seed = 1; seed <= 6; seed++){
    const sites = capitalSites(20, 2, mulberry(seed * 31));
    const b = playGame(false, seed, diff, null);
    const c = playGame(true,  seed, diff, sites);
    baseWorst = Math.max(baseWorst, b.worst); capWorst = Math.max(capWorst, c.worst);
    baseMoves += b.moves; capMoves += c.moves;
    ledger += b.ledger + c.ledger;
    freeGrab += b.freeGrab + c.freeGrab;
    monoBreak += b.monoBreak + c.monoBreak;
  }
  console.log(`  ${diff.padEnd(6)} moves played: baseline ${baseMoves}, capitals ${capMoves}` +
              `  | worst concurrent violations: baseline ${baseWorst}, capitals ${capWorst}`);
  // a run that plays nothing must never be able to pass
  ok(baseMoves > 300 && capMoves > 300, `${diff}: games too short to mean anything (${baseMoves}/${capMoves})`);
  ok(capWorst <= baseWorst, `${diff}: capitals made invariants WORSE (${capWorst} vs ${baseWorst})`);
  ok(ledger === 0, `${diff}: ${ledger} ledger drifts`);
  ok(monoBreak === 0, `${diff}: colEarnedQ went backwards ${monoBreak} times`);
  ok(freeGrab === 0, `${diff}: ${freeGrab} score gains from a move that enclosed nothing`);
}

/* ---- 4. replay determinism ---------------------------------------- */
console.log('\n== 4. replaying the same stream reproduces the board ==');
{
  let bad = 0;
  for (let seed = 1; seed <= 5; seed++){
    const sites = capitalSites(20, 2, mulberry(seed * 17));
    const run = () => {
      const g = new Game(20, 2);
      g.foundCapitals(sites);
      const rnd = mulberry(seed), moves = [];
      let pl = 1;
      for (let i = 0; i < 120; i++){
        const m = chooseAIMove(g, rnd, 'medium');
        if (!m) break;
        g.place(m.x, m.y, pl); moves.push([m.x, m.y, pl]); pl = g.nextOf(pl);
      }
      return { fp: fingerprint(g), moves };
    };
    const a = run();
    if (a.moves.length < 40) bad++;   // a replay of nothing proves nothing
    // replay a's exact move list onto a fresh engine
    const g2 = new Game(20, 2);
    g2.foundCapitals(sites);
    for (const [x, y, pl] of a.moves) g2.place(x, y, pl);
    if (fingerprint(g2) !== a.fp) bad++;
  }
  ok(bad === 0, `${bad} replays diverged from the original board`);
}

/* ---- 5. a capital is ordinary ground ------------------------------ */
console.log('\n== 5. no guards: a bomb takes a capital like any square ==');
{
  const g = new Game(20, 2);
  const sites = capitalSitesFrom(20, 2, 6, 6);
  g.foundCapitals(sites);
  const victim = g.capitals[1];
  ok(g.capitalHolder(1) === 1, 'player 1 does not hold their own capital at birth');

  g.colEarnedQ[2] = 1000;                 // fund a bomb directly, no farming
  const r = g.bombAt(victim.sx, victim.sy, 2);
  ok(r !== null, 'bomb on a capital square was refused');
  ok(g.capitalHolder(1) === 2, `capital did not transfer: holder is ${g.capitalHolder(1)}`);
  const v = checkBoard(g);
  ok(total(v) === 0, `bombing a capital broke invariants: ${show(v)}`);

  // and the marker itself never moves — only the ground changes hands
  ok(g.capitals[1].sx === victim.sx && g.capitals[1].sy === victim.sy,
     'capital marker moved when the ground was captured');
}

/* ---- 6. clone carries capitals ------------------------------------ */
console.log('\n== 6. clone() is independent ==');
{
  const g = new Game(20, 2);
  g.foundCapitals(capitalSites(20, 2, mulberry(3)));
  const c = g.clone();
  ok(JSON.stringify(c.capitals) === JSON.stringify(g.capitals), 'clone lost capitals');
  c.capitals[1].sx = 99;
  ok(g.capitals[1].sx !== 99, 'clone shares capital objects with the original');
  ok(fingerprint(c) === fingerprint(g), 'clone board differs from original');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
