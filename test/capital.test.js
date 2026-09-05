/* ================================================================
   Capital PLACEMENT tests. Geometry only — no Game, no board state.

   Run: node test/capital.test.js
   ================================================================ */
'use strict';

import {
  capitalMargin, capitalSitesFrom, capitalAnchors, capitalSites
} from '../src/engine/geometry.js';
import { CAPITAL_MIN_SEP } from '../src/engine/constants.js';

const SIZES = [6, 8, 10, 20, 30, 50, 150, 300];
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL: ' + msg); } };

// The four lattice points that are corners of square (sx,sy).
const cornerDots = s => [
  s.sx + ',' + s.sy, (s.sx + 1) + ',' + s.sy,
  s.sx + ',' + (s.sy + 1), (s.sx + 1) + ',' + (s.sy + 1)
];

console.log('\n== 1. every anchor yields a legal layout ==');
for (const N of SIZES){
  for (const np of [2, 3]){
    const m = capitalMargin(N);
    const anchors = capitalAnchors(N, np);
    let bad = 0, dotClash = 0;
    for (const a of anchors){
      const sites = capitalSitesFrom(N, np, a.sx, a.sy);
      if (!sites || sites.length !== np){ bad++; continue; }
      for (const s of sites){
        if (s.sx < m || s.sy < m || s.sx > N - 1 - m || s.sy > N - 1 - m) bad++;
        if (!Number.isInteger(s.sx) || !Number.isInteger(s.sy)) bad++;
      }
      for (let i = 0; i < np; i++) for (let j = i + 1; j < np; j++){
        const d = Math.max(Math.abs(sites[i].sx - sites[j].sx),
                           Math.abs(sites[i].sy - sites[j].sy));
        if (d < CAPITAL_MIN_SEP) bad++;
      }
      // The real invariant MIN_SEP exists to protect: capitals are born
      // with 4 corner dots each, and one lattice point cannot be two
      // capitals' corner. Checked directly, not inferred from the gap.
      const seen = new Set();
      for (const s of sites) for (const d of cornerDots(s)){
        if (seen.has(d)) dotClash++; else seen.add(d);
      }
    }
    ok(bad === 0, `N=${N} np=${np}: ${bad} illegal sites from anchors`);
    ok(dotClash === 0, `N=${N} np=${np}: ${dotClash} shared corner dots`);
  }
}

console.log('\n== 2. every board size is playable (>=1 anchor) ==');
for (const N of SIZES){
  for (const np of [2, 3]){
    const n = capitalAnchors(N, np).length;
    ok(n > 0, `N=${N} np=${np}: NO legal capital layout exists`);
    console.log(`  N=${String(N).padStart(3)} np=${np}  margin=${String(capitalMargin(N)).padStart(2)}  legal anchors=${n}`);
  }
}

console.log('\n== 3. capitalSitesFrom is deterministic ==');
{
  let drift = 0;
  for (const N of [10, 20, 50]) for (const np of [2, 3])
    for (const a of capitalAnchors(N, np)){
      const x = JSON.stringify(capitalSitesFrom(N, np, a.sx, a.sy));
      const y = JSON.stringify(capitalSitesFrom(N, np, a.sx, a.sy));
      if (x !== y) drift++;
    }
  ok(drift === 0, `${drift} anchors gave different answers on repeat calls`);
}

console.log('\n== 4. 2p symmetry is exact (180 deg about centre) ==');
{
  let bad = 0;
  for (const N of SIZES) for (const a of capitalAnchors(N, 2)){
    const [p, q] = capitalSitesFrom(N, 2, a.sx, a.sy);
    if (p.sx + q.sx !== N - 1 || p.sy + q.sy !== N - 1) bad++;
  }
  ok(bad === 0, `${bad} 2p layouts were not exact 180 deg rotations`);
}

console.log('\n== 5. capitalSites only ever returns an enumerated layout ==');
{
  let bad = 0;
  for (const N of [6, 10, 20, 50]) for (const np of [2, 3]){
    const legal = new Set(capitalAnchors(N, np).map(a => a.sx + ',' + a.sy));
    for (let i = 0; i < 400; i++){
      const s = capitalSites(N, np, Math.random);
      if (!s || !legal.has(s[0].sx + ',' + s[0].sy)) bad++;
    }
  }
  ok(bad === 0, `${bad} random picks fell outside the legal anchor set`);
  // rnd() === 1 must not run off the end of the array.
  let edge = 0;
  for (const N of [6, 10, 20]) for (const np of [2, 3])
    for (const r of [0, 0.999999, 1]) if (!capitalSites(N, np, () => r)) edge++;
  ok(edge === 0, `${edge} boundary rnd() values returned null`);
}

console.log('\n== 6. same rnd value reproduces the same layout ==');
{
  let bad = 0;
  for (const N of [10, 20, 50]) for (const np of [2, 3])
    for (const r of [0.13, 0.5, 0.87]){
      const a = JSON.stringify(capitalSites(N, np, () => r));
      const b = JSON.stringify(capitalSites(N, np, () => r));
      if (a !== b) bad++;
    }
  ok(bad === 0, `${bad} repeats diverged for a fixed rnd`);
}

console.log('\n== 7. illegal input returns null, never throws ==');
{
  const cases = [[20, 2, -1, 5], [20, 2, 20, 5], [20, 2, 0, 0], [20, 4, 10, 10], [20, 1, 10, 10]];
  let bad = 0;
  for (const [N, np, sx, sy] of cases){
    let r; try { r = capitalSitesFrom(N, np, sx, sy); } catch (e){ bad++; continue; }
    if (r !== null) bad++;
  }
  ok(bad === 0, `${bad} illegal inputs did not return null`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
