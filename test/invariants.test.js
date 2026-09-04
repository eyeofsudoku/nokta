/* Engine invariants. DOM-free, no dependencies.
   Run: node test/invariants.test.js                                        */
import { Game } from '../src/engine/game.js';
import { LASER_LEN, LASER_COST } from '../src/engine/constants.js';
import { LASER_DIRS } from '../src/engine/geometry.js';
import { chooseAIMove } from '../src/engine/ai.js';

let passed = 0, failed = 0;
function test(name, fn){
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e){ failed++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
function assert(cond, msg){ if (!cond) throw new Error(msg); }
function rndFrom(seed){ let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/* ---- the invariants ------------------------------------------------ */

// Every square must be uniform, or split {N,E}|{S,W} by dA, or {N,W}|{E,S} by
// dB. Only 15 of the 81 ownership combinations are fenceable; the other 66
// cannot be outlined at all and must never be written.
export function illegalSquares(G){
  const N = G.N, own = G.owner, bad = [];
  for (let s = 0; s < N * N; s++){
    const b = s * 4, n = own[b], e = own[b+1], so = own[b+2], w = own[b+3];
    const uniform = (n === e && e === so && so === w);
    const dA = (n === e && so === w && n !== so);
    const dB = (n === w && e === so && n !== e);
    if (!(uniform || dA || dB)) bad.push(s + ':' + [n,e,so,w].join(''));
  }
  return bad;
}

// Wherever owned ground meets unowned ground there must be a line — for the
// orthogonal seams and the in-square diagonal seams alike.
export function openSides(G){
  const N = G.N, P = G.P, own = G.owner, bad = [];
  const q = (sx, sy, t) => own[(sy * N + sx) * 4 + t];
  for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++){
    if (sy > 0){ const a = q(sx,sy,0), b = q(sx,sy-1,2);
      if (((a === 0) !== (b === 0)) && !G.hE[sy*P+sx]) bad.push('hE ' + sx + ',' + sy); }
    if (sx > 0){ const a = q(sx,sy,3), b = q(sx-1,sy,1);
      if (((a === 0) !== (b === 0)) && !G.vE[sy*P+sx]) bad.push('vE ' + sx + ',' + sy); }
    if (sy === 0 && q(sx,sy,0) !== 0 && !G.hE[sx])     bad.push('rim-top ' + sx);
    if (sx === 0 && q(sx,sy,3) !== 0 && !G.vE[sy*P])   bad.push('rim-left ' + sy);
    const s = sy * N + sx;
    const seams = [[0,1,G.dB[s]], [1,2,G.dA[s]], [2,3,G.dB[s]], [3,0,G.dA[s]]];
    for (const [ta, tb, line] of seams){
      const a = q(sx,sy,ta), b = q(sx,sy,tb);
      if (((a === 0) !== (b === 0)) && !line) bad.push('diag ' + sx + ',' + sy);
    }
  }
  return bad;
}

// Every boundary line of a region must belong to that region's owner. A line
// with territory on one side and empty ground on the other, owned by anyone
// else, means a region fenced by someone else's colour.
export function mixedOutlines(G){
  const N = G.N, P = G.P, o = G.owner, bad = [];
  const check = (lineOwner, a, b, label) => {
    if (!lineOwner) return;
    if ((a > 0) === (b > 0)) return;         // both owned or both empty
    const holder = a > 0 ? a : b;
    if (lineOwner !== holder) bad.push(`${label} line=${lineOwner} holder=${holder}`);
  };
  for (let sy = 0; sy < N; sy++) for (let sx = 0; sx < N; sx++){
    const s = sy * N + sx, b = s * 4;
    const above = sy > 0 ? o[((sy-1)*N+sx)*4+2] : 0;
    check(G.hE[sy*P+sx], o[b+0], above, `hE ${sx},${sy}`);
    const left = sx > 0 ? o[(sy*N+sx-1)*4+1] : 0;
    check(G.vE[sy*P+sx], o[b+3], left, `vE ${sx},${sy}`);
    if (sy === N-1) check(G.hE[(sy+1)*P+sx], o[b+2], 0, `hE ${sx},${sy+1}`);
    if (sx === N-1) check(G.vE[sy*P+sx+1], o[b+1], 0, `vE ${sx+1},${sy}`);
    check(G.dA[s], o[b+0], o[b+2], `dA ${sx},${sy}`);   // {N,E} | {S,W}
    check(G.dB[s], o[b+0], o[b+1], `dB ${sx},${sy}`);   // {N,W} | {E,S}
  }
  return bad;
}

// No edge may have unowned ground on both sides *and* no dot to justify it is
// checked elsewhere; here: a square may never carry both diagonals.
export function crossings(G){
  let n = 0;
  for (let s = 0; s < G.dA.length; s++) if (G.dA[s] && G.dB[s]) n++;
  return n;
}

// colQ must equal live colonized truth, never negative; scoreQ never negative
// and never more than the whole board.
export function ledger(G){
  const bad = [];
  for (let pl = 1; pl <= G.np; pl++){
    let live = 0;
    for (let c = 0; c < G.owner.length; c++) if (G.owner[c] === pl && G.colFlag[c]) live++;
    if (live !== G.colQ[pl]) bad.push(`colQ[${pl}] ${G.colQ[pl]} != live ${live}`);
    if (G.colQ[pl] < 0)   bad.push(`colQ[${pl}] negative`);
    if (G.scoreQ[pl] < 0) bad.push(`scoreQ[${pl}] negative`);
  }
  let sum = 0; for (let pl = 1; pl <= G.np; pl++) sum += G.scoreQ[pl];
  if (sum > G.owner.length) bad.push('scoreQ sum exceeds board');
  return bad;
}

function snapshot(G){
  return JSON.stringify([[...G.owner], [...G.dots], [...G.hE], [...G.vE],
                         [...G.dA], [...G.dB], G.scoreQ, G.colQ, G.colEarnedQ, G.switchSpent]);
}

/* ---- the suite ------------------------------------------------------ */

console.log('\nengine invariants');

test('only 15 of 81 square ownership states are fenceable', () => {
  let legal = 0;
  for (let n = 0; n < 3; n++) for (let e = 0; e < 3; e++)
  for (let s = 0; s < 3; s++) for (let w = 0; w < 3; w++){
    if ((n===e&&e===s&&s===w) || (n===e&&s===w&&n!==s) || (n===w&&e===s&&n!==e)) legal++;
  }
  assert(legal === 15, 'expected 15 fenceable states, got ' + legal);
});

test('ACCEPTANCE 1 — triangle: switching the apex leaves red nothing', () => {
  const G = new Game(8, 2);
  for (const [x,y] of [[2,2],[3,2],[3,3]]) G.place(x, y, 2);
  assert(G.scoreQ[2] === 2, 'setup: red should hold 0.5 area (2 quarters), got ' + G.scoreQ[2]);
  G.colEarnedQ[1] = 4000;
  G.switchDot(2, 2, 1);                       // blue takes the apex
  assert(G.area(2) === 0, 'red area should be 0, got ' + G.area(2));
  assert(G.scoreQ[1] === 0, 'blue should gain no ground, got ' + G.scoreQ[1]);
  assert(G.dots[G.pi(3,2)] === 2 && G.dots[G.pi(3,3)] === 2, 'two red dots should remain');
  assert(G.vE[2 * G.P + 3] === 2, 'the line between them should remain, red');
  assert(illegalSquares(G).length === 0, 'illegal squares: ' + illegalSquares(G));
  assert(mixedOutlines(G).length === 0, 'mixed outlines: ' + mixedOutlines(G));
});

test('ACCEPTANCE 2 — square: switching a corner leaves red a red-outlined triangle', () => {
  const G = new Game(8, 2);
  for (const [x,y] of [[2,2],[3,2],[3,3],[2,3]]) G.place(x, y, 2);
  assert(G.area(2) === 1, 'setup: red should hold 1 area, got ' + G.area(2));
  assert(G.dA[2*8+2] === 0 && G.dB[2*8+2] === 0, 'setup: both diagonals absent');
  G.colEarnedQ[1] = 4000;
  G.switchDot(2, 2, 1);                       // blue takes the top-left

  assert(G.area(2) === 0.5, 'red should keep exactly 0.5 area, got ' + G.area(2));
  assert(G.scoreQ[1] === 0, 'blue should gain no ground, got ' + G.scoreQ[1]);
  // the surviving triangle is the {E,S} half, fenced by the "/" diagonal
  const b = (2*8+2)*4;
  assert(G.owner[b+1] === 2 && G.owner[b+2] === 2, 'red should keep the E and S quarters');
  assert(G.owner[b+0] === 0 && G.owner[b+3] === 0, 'the N and W quarters should be neutral');
  assert(G.dB[2*8+2] === 2, 'the "/" diagonal must exist and be red, got ' + G.dB[2*8+2]);
  assert(G.dA[2*8+2] === 0, 'the opposite diagonal must not exist (crossing rule)');
  // every line fencing red is red
  assert(mixedOutlines(G).length === 0, 'mixed outlines: ' + mixedOutlines(G));
  assert(illegalSquares(G).length === 0, 'illegal squares: ' + illegalSquares(G));
  assert(openSides(G).length === 0, 'open sides: ' + openSides(G));
});

test('a switch that encloses nothing far from territory captures nothing', () => {
  const G = new Game(20, 2);
  for (const [x,y] of [[2,2],[3,2],[3,3],[2,3]]) G.place(x, y, 2);
  G.place(15, 15, 2);
  G.colEarnedQ[1] = 4000;
  const before = G.scoreQ[2];
  G.switchDot(15, 15, 1);
  assert(G.scoreQ[2] === before, 'far switch stole ground: ' + before + ' -> ' + G.scoreQ[2]);
  assert(G.scoreQ[1] === 0, 'far switch granted ground: ' + G.scoreQ[1]);
});

test('resealBorders is a no-op on a normally played board', () => {
  const G = new Game(16, 2);
  const rnd = rndFrom(4242);
  for (const [x,y] of [[3,3],[4,3],[3,4],[7,7],[8,7],[7,8]]) G.place(x, y, 1);
  let pl = 1;
  for (let i = 0; i < 120; i++){
    const m = chooseAIMove(G, rnd, 'medium');
    if (m) G.place(m.x, m.y, pl);
    pl = G.nextOf(pl);
  }
  const before = snapshot(G);
  G.resealBorders();
  assert(snapshot(G) === before, 'resealBorders mutated a normally played board');
});

test('colEarnedQ is monotonic and no double credit on retaken ground', () => {
  const G = new Game(12, 2);
  const rnd = rndFrom(99);
  let pl = 1, prev = [0,0,0,0];
  for (const [x,y] of [[3,3],[4,3],[3,4],[6,6],[7,6],[6,7]]) { G.place(x,y,pl); pl = G.nextOf(pl); }
  for (let i = 0; i < 150; i++){
    for (let p = 1; p <= 2; p++) G.colEarnedQ[p] = Math.max(G.colEarnedQ[p], 1200);
    if (i % 4 === 3){
      let done = false;
      for (let y = 0; y < G.P && !done; y++) for (let x = 0; x < G.P && !done; x++)
        if (G.canSwitch(x, y, pl)){ G.switchDot(x, y, pl); done = true; }
      if (!done){ const m = chooseAIMove(G, rnd, 'medium'); if (m) G.place(m.x, m.y, pl); }
    } else { const m = chooseAIMove(G, rnd, 'medium'); if (m) G.place(m.x, m.y, pl); }
    for (let p = 1; p <= 2; p++){
      assert(G.colEarnedQ[p] >= prev[p], `colEarnedQ[${p}] went backwards`);
      prev[p] = G.colEarnedQ[p];
    }
    pl = G.nextOf(pl);
  }
});

test('applyEdges never overwrites another player\'s slot, and revert is symmetric', () => {
  const G = new Game(8, 2);
  // p1 owns a line whose lattice points carry no dots — exactly what
  // resealBorders and bombAt produce, and the reason the slot is free to
  // build on. p2 then forms a connection across the same slot.
  G.hE[3 * G.P + 3] = 1;
  G.place(3, 3, 2); G.place(4, 3, 2);
  assert(G.hE[3 * G.P + 3] === 1,
         'p2 stole p1\'s slot, owner=' + G.hE[3 * G.P + 3]);

  // revertEdges must undo only what applyEdges actually wrote
  const G2 = new Game(8, 2);
  G2.vE[2 * G2.P + 2] = 1;
  const applied = G2.applyEdges([{ t: 1, i: 2 * G2.P + 2 }, { t: 0, i: 2 * G2.P + 2 }], 2);
  assert(applied.length === 1, 'only the free slot should be written, got ' + applied.length);
  G2.revertEdges(applied);
  assert(G2.vE[2 * G2.P + 2] === 1, "revert zeroed a slot it never owned");
  assert(G2.hE[2 * G2.P + 2] === 0, 'revert failed to undo its own write');
});

test('REGRESSION — a placed dot never steals another player\'s border line', () => {
  // seed 3: three bombs land, then at step 57 p3 places a dot at (3,9) whose
  // auto-connection lands on hE(3,9) — a slot already owned by p1 as the
  // border of territory p1 wholly owns. It is reachable only after a bomb,
  // because bomb/reseal borders are owned by the GROUND holder rather than
  // derived from dots, so both lattice points sit empty and free to build on.
  // applyEdges used to overwrite it unconditionally, fencing p1's region in
  // p3's colour — and since applyEdges runs before flood(), the stolen slot
  // was a live barrier in the capture that followed.
  const G = new Game(12, 3), rnd = rndFrom(3 * 7919);
  let pl = 1, checked = false;
  for (const [x,y] of [[3,3],[4,3],[3,4],[7,7],[8,7],[7,8],[5,9],[9,5]]){ G.place(x,y,pl); pl = G.nextOf(pl); }
  for (let i = 0; i < 160; i++){
    for (let p = 1; p <= 3; p++) G.colEarnedQ[p] = Math.max(G.colEarnedQ[p], 2000);
    let did = false;
    if (i % 19 === 18 && G.bombsFor(pl) > 0){ G.bombAt((rnd()*G.N)|0, (rnd()*G.N)|0, pl); did = true; }
    if (!did){
      const m = chooseAIMove(G, rnd, 'medium');
      if (m){
        G.place(m.x, m.y, pl);
        if (i === 57){
          assert(m.x === 3 && m.y === 9 && pl === 3, `scenario drifted: step 57 was p${pl} at (${m.x},${m.y})`);
          const b = (9 * 12 + 3) * 4;
          assert(G.owner[b] === 1 && G.owner[b+1] === 1 && G.owner[b+2] === 1 && G.owner[b+3] === 1,
                 'square (3,9) should be wholly p1');
          assert(G.hE[9 * G.P + 3] === 1,
                 'p3 stole p1\'s border line hE(3,9), owner=' + G.hE[9 * G.P + 3]);
          checked = true;
        }
      }
    }
    const mix = mixedOutlines(G);
    assert(mix.length === 0, `step ${i}: mixed outlines ${mix.slice(0,3)}`);
    pl = G.nextOf(pl);
  }
  assert(checked, 'step 57 never ran — scenario drifted');
});

test('full simulated games keep every invariant, all difficulties, 2p and 3p', () => {
  for (let seed = 1; seed <= 24; seed++){
    const np = (seed % 3 === 0) ? 3 : 2;
    const size = [12, 16, 20][seed % 3];
    const diff = ['easy','medium','hard'][seed % 3];
    const G = new Game(size, np), rnd = rndFrom(seed * 7919);
    let pl = 1;
    for (const [x,y] of [[3,3],[4,3],[3,4],[7,7],[8,7],[7,8],[5,9],[9,5]]) { G.place(x,y,pl); pl = G.nextOf(pl); }
    for (let i = 0; i < 140; i++){
      for (let p = 1; p <= np; p++) G.colEarnedQ[p] = Math.max(G.colEarnedQ[p], 2000);
      let did = false;
      if (i % 3 === 2){
        for (let k = 0; k < 12 && !did; k++){
          const x = (rnd() * G.P) | 0, y = (rnd() * G.P) | 0;
          if (G.canSwitch(x, y, pl)){ G.switchDot(x, y, pl); did = true; }
        }
      } else if (i % 19 === 18 && G.bombsFor(pl) > 0){
        G.bombAt((rnd() * G.N) | 0, (rnd() * G.N) | 0, pl); did = true;
      }
      if (!did){ const m = chooseAIMove(G, rnd, diff); if (m) G.place(m.x, m.y, pl); }

      const ill = illegalSquares(G), led = ledger(G), cr = crossings(G), mix = mixedOutlines(G);
      assert(ill.length === 0, `seed ${seed} step ${i}: illegal squares ${ill.slice(0,3)}`);
      assert(mix.length === 0, `seed ${seed} step ${i}: mixed outlines ${mix.slice(0,3)}`);
      assert(led.length === 0, `seed ${seed} step ${i}: ${led.join('; ')}`);
      assert(cr === 0,         `seed ${seed} step ${i}: ${cr} diagonal crossings`);
      pl = G.nextOf(pl);
    }
  }
});

test('replaying one action stream on fresh engines is byte-identical', () => {
  const actions = [];
  const build = () => {
    const G = new Game(14, 2), rnd = rndFrom(31337);
    let pl = 1;
    for (const [x,y] of [[3,3],[4,3],[3,4],[8,8],[9,8],[8,9]]) { G.place(x,y,pl); actions.push(['m',x,y,pl]); pl = G.nextOf(pl); }
    for (let i = 0; i < 90; i++){
      const m = chooseAIMove(G, rnd, 'medium');
      if (m){ G.place(m.x, m.y, pl); actions.push(['m', m.x, m.y, pl]); }
      pl = G.nextOf(pl);
    }
    return snapshot(G);
  };
  const first = build();
  for (let rep = 0; rep < 2; rep++){
    const G = new Game(14, 2);
    for (const [t,x,y,pl] of actions) G.place(x, y, pl);
    assert(snapshot(G) === first, 'replay ' + rep + ' diverged');
  }
});

/* ---- laser ---------------------------------------------------------- */

// owner of the edge slot between two ADJACENT lattice points, or 0
function edgeBetween(G, ax, ay, bx, by){
  const N = G.N, P = G.P, dx = bx - ax, dy = by - ay;
  if (dy === 0) return G.hE[ay * P + Math.min(ax, bx)];
  if (dx === 0) return G.vE[Math.min(ay, by) * P + ax];
  const sx = Math.min(ax, bx), sy = Math.min(ay, by);
  return dx === dy ? G.dA[sy * N + sx] : G.dB[sy * N + sx];
}
function armed(G, pl){ G.colEarnedQ[pl] = 4000; return G; }

test('laser: a clear ray lands exactly LASER_LEN dots', () => {
  const G = armed(new Game(20, 2), 1);
  const r = G.laserAt(2, 2, 0, 1);            // dir 0 = E
  assert(r, 'laser should fire');
  assert(r.landed === LASER_LEN, `expected ${LASER_LEN} dots, got ${r.landed}`);
  for (let i = 0; i < LASER_LEN; i++)
    assert(G.dots[G.pi(2 + i, 2)] === 1, `no dot at (${2+i},2)`);
  assert(G.switchesFor(1) === Math.floor(4000/40) - LASER_COST, 'wrong token spend');
});

test("laser: an opponent's dot is skipped and breaks the line", () => {
  const G = armed(new Game(20, 2), 1);
  G.place(7, 2, 2);                            // enemy dot mid-path
  const r = G.laserAt(2, 2, 0, 1);
  assert(r.landed === LASER_LEN - 1, `expected ${LASER_LEN-1}, got ${r.landed}`);
  assert(G.dots[G.pi(7, 2)] === 2, 'the enemy dot must survive');
  // the two dots either side are 2 apart: no edge of ours spans the gap
  assert(edgeBetween(G, 6, 2, 7, 2) !== 1, 'edge formed into the enemy dot');
  assert(edgeBetween(G, 7, 2, 8, 2) !== 1, 'edge formed out of the enemy dot');
});

test('laser: your own dot is skipped but the line stays continuous', () => {
  const G = armed(new Game(20, 2), 1);
  G.place(7, 2, 1);                            // our own dot mid-path
  const r = G.laserAt(2, 2, 0, 1);
  assert(r.landed === LASER_LEN - 1, `expected ${LASER_LEN-1}, got ${r.landed}`);
  assert(edgeBetween(G, 6, 2, 7, 2) === 1, 'line broke before our own dot');
  assert(edgeBetween(G, 7, 2, 8, 2) === 1, 'line broke after our own dot');
});

test('laser: a fully blocked ray is refused, spending nothing', () => {
  const G = armed(new Game(20, 2), 1);
  for (let i = 0; i < LASER_LEN; i++) G.place(2 + i, 2, 2);
  const tokensBefore = G.switchesFor(1), spentBefore = G.switchSpent[1];
  const r = G.laserAt(2, 2, 0, 1);
  assert(r === null, 'a dead ray must be refused, got ' + JSON.stringify(r));
  assert(G.switchesFor(1) === tokensBefore, 'tokens were spent on a dead ray');
  assert(G.switchSpent[1] === spentBefore, 'switchSpent moved on a dead ray');
});

test('laser: a 45° dot lands but its connection is refused by the crossing rule', () => {
  const G = armed(new Game(20, 2), 1);
  G.place(3, 3, 2); G.place(4, 4, 2);          // red owns dA of square (3,3)
  assert(G.dA[3 * G.N + 3] === 2, 'setup: red dA should exist');
  const pre = G.laserPreview(4, 3, 3, 1);      // dir 3 = SW, crosses square (3,3)
  const r = G.laserAt(4, 3, 3, 1);
  assert(G.dots[G.pi(4, 3)] === 1 && G.dots[G.pi(3, 4)] === 1, 'both dots should land');
  assert(G.dB[3 * G.N + 3] === 0, 'the crossing diagonal must be refused');
  assert(pre.links[0] === false, 'preview must predict the refused connection');
  assert(G.dA[3 * G.N + 3] === 2, "red's diagonal must survive");
});

test('laser: closing a loop captures once, with the whole area', () => {
  const G = armed(new Game(20, 2), 1);
  // four collinear dots enclose nothing on their own — no corner dots, or the
  // diagonals they form with the row would close triangles before we fire
  for (const [x,y] of [[2,3],[3,3],[4,3],[5,3]]) G.place(x, y, 1);
  assert(G.scoreQ[1] === 0, 'setup should enclose nothing yet');

  const before = G.scoreQ[1];
  const r = G.laserAt(2, 2, 0, 1);          // parallel row above closes it
  const delta = G.scoreQ[1] - before;

  // one commitCapture for the whole line: the reported figure must equal the
  // real total. Capturing per dot would report only the last dot's share.
  assert(r.gainedQ === delta, `reported ${r.gainedQ} but board gained ${delta}`);
  // 3 whole squares (12 quarters) between the rows, plus a half-square: the
  // laser dot at (6,2) runs past the row's end and connects diagonally down to
  // (5,3), fencing the {N,W} triangle of square (5,2). 14 quarters, area 3.5.
  assert(r.gainedQ === 14, `expected 14 quarters, got ${r.gainedQ}`);
  assert(G.area(1) === 3.5, `expected area 3.5, got ${G.area(1)}`);
  const b = (2 * G.N + 5) * 4;
  assert(G.owner[b] === 1 && G.owner[b+3] === 1 && G.owner[b+1] === 0 && G.owner[b+2] === 0,
         'square (5,2) should be the {N,W} half only');
});

test('laser: laserPreview matches laserAt in all 8 directions', () => {
  for (let dir = 0; dir < 8; dir++){
    const G = armed(new Game(20, 3), 1);
    // mixed obstacles: our dots, enemy dots, and an enemy diagonal
    for (const [x,y] of [[9,9],[11,11],[6,12],[12,6]]) G.place(x, y, 2);
    for (const [x,y] of [[8,10],[10,8]]) G.place(x, y, 3);
    for (const [x,y] of [[13,13],[14,14]]) G.place(x, y, 1);
    const pre = G.laserPreview(10, 10, dir, 1);
    const G2 = G.clone();
    const r = G2.laserAt(10, 10, dir, 1);
    assert(pre.ok === (r !== null), `dir ${dir}: ok=${pre.ok} but laserAt gave ${r}`);
    if (!r) continue;
    const landed = pre.positions.filter(p => p.willLand);
    assert(landed.length === r.landed, `dir ${dir}: preview ${landed.length} vs actual ${r.landed}`);
    landed.forEach((p, i) => {
      assert(p.x === r.positions[i].x && p.y === r.positions[i].y,
             `dir ${dir}: position ${i} differs`);
    });
    for (let i = 0; i + 1 < pre.positions.length; i++){
      const a = pre.positions[i], b = pre.positions[i + 1];
      const real = edgeBetween(G2, a.x, a.y, b.x, b.y) === 1;
      assert(pre.links[i] === real,
             `dir ${dir}: link ${i} (${a.x},${a.y})-(${b.x},${b.y}) preview=${pre.links[i]} real=${real}`);
    }
  }
});

test('laser: every invariant holds after firing, 2p and 3p', () => {
  for (let seed = 1; seed <= 12; seed++){
    const np = (seed % 2) ? 2 : 3;
    const G = new Game(16, np), rnd = rndFrom(seed * 4099);
    let pl = 1;
    for (const [x,y] of [[3,3],[4,3],[3,4],[8,8],[9,8],[8,9]]) { G.place(x,y,pl); pl = G.nextOf(pl); }
    for (let i = 0; i < 60; i++){
      for (let p = 1; p <= np; p++) G.colEarnedQ[p] = Math.max(G.colEarnedQ[p], 3000);
      if (i % 4 === 3) G.laserAt((rnd()*G.P)|0, (rnd()*G.P)|0, (rnd()*8)|0, pl);
      else { const m = chooseAIMove(G, rnd, 'medium'); if (m) G.place(m.x, m.y, pl); }
      const ill = illegalSquares(G), mix = mixedOutlines(G), led = ledger(G), os = openSides(G);
      assert(ill.length === 0, `seed ${seed} step ${i}: illegal ${ill.slice(0,3)}`);
      assert(mix.length === 0, `seed ${seed} step ${i}: mixed ${mix.slice(0,3)}`);
      assert(led.length === 0, `seed ${seed} step ${i}: ${led.join('; ')}`);
      assert(os.length === 0,  `seed ${seed} step ${i}: open sides ${os.slice(0,3)}`);
      assert(crossings(G) === 0, `seed ${seed} step ${i}: crossings`);
      pl = G.nextOf(pl);
    }
  }
});

test('laser: an identical action stream replays byte-identically', () => {
  const acts = [];
  const rnd = rndFrom(2024);
  for (let i = 0; i < 40; i++)
    acts.push([(rnd()*15)|0, (rnd()*15)|0, (rnd()*8)|0, (i % 2) + 1]);
  const build = () => {
    const G = new Game(14, 2);
    for (const [x,y,d,pl] of acts){ G.colEarnedQ[pl] = 8000; G.laserAt(x, y, d, pl); }
    return snapshot(G);
  };
  const first = build();
  assert(build() === first, 'replay 1 diverged');
  assert(build() === first, 'replay 2 diverged');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed) { if (typeof process !== 'undefined') process.exit(1); }
