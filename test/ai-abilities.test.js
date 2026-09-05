/* ================================================================
   AI ABILITY POLICY tests.

   The headline assertion is a head-to-head: an AI that spends tokens
   must beat an identical AI that cannot, at the same difficulty. If it
   loses, either the policy is wrong or the abilities are underpowered,
   and either is a finding.

   Both sides receive an IDENTICAL token stipend. That isolates the
   policy from the economy: the current colonization faucet yields ~0.2
   tokens per game on 20x20, so without a stipend neither side could
   afford anything and the comparison would measure nothing. The stipend
   is also a preview of capital income.

   Run: node test/ai-abilities.test.js
   ================================================================ */
'use strict';

import { Game } from '../src/engine/game.js';
import { chooseAIMove, chooseAIAction, bestBomb, bombValueTable, bombValueAt,
         DENY_WEIGHT } from '../src/engine/ai.js';
import { capitalSites } from '../src/engine/geometry.js';
import { AIP, HUMAN, BOMB_COST, COL_PER_SWITCH, COL_WIN_BONUS } from '../src/engine/constants.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL: ' + msg); } };
const mul = s => () => {
  s |= 0; s = s + 0x6D2B79F5 | 0;
  let t = Math.imul(s ^ s >>> 15, 1 | s);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

/* ---- 1. chooseAIMove is unchanged for every existing caller ------- */
console.log('\n== 1. chooseAIMove(G, rnd, diff) still behaves exactly as before ==');
{
  let diff = 0, n = 0;
  for (const d of ['easy', 'medium', 'hard']){
    for (let seed = 1; seed <= 4; seed++){
      const g = new Game(20, 2);
      g.foundCapitals(capitalSites(20, 2, mul(seed * 31)));
      const rnd = mul(seed); let pl = 1;
      for (let i = 0; i < 120; i++){
        // same rnd stream fed to both call shapes, on the same position
        const a = chooseAIMove(g, mul(i * 977 + seed), d);
        const b = chooseAIMove(g, mul(i * 977 + seed), d, AIP);
        n++;
        if (JSON.stringify(a) !== JSON.stringify(b)) diff++;
        const m = chooseAIMove(g, rnd, d); if (!m) break;
        if (!g.place(m.x, m.y, pl)) break;
        if (g.gameResult().over) break;
        pl = g.nextOf(pl);
      }
    }
  }
  ok(diff === 0, `${diff}/${n} positions differed when pl defaulted vs explicit AIP`);
  console.log(`  ${n} positions compared, ${diff} differences`);
}

/* ---- 2. the analytic bomb value is exact -------------------------- */
console.log('\n== 2. bomb valuation matches a real bombAt exactly ==');
{
  let worstGain = 0, worstDeny = 0, checked = 0, bestAgree = 0, bestCases = 0;
  for (const ply of [60, 180, 300]){
    for (let seed = 1; seed <= 3; seed++){
      const g = new Game(20, 2);
      g.foundCapitals(capitalSites(20, 2, mul(seed * 31)));
      const rnd = mul(seed); let pl = 1;
      for (let i = 0; i < ply; i++){
        const m = chooseAIMove(g, rnd, 'medium'); if (!m) break;
        if (!g.place(m.x, m.y, pl)) break;
        if (g.gameResult().over) break;
        pl = g.nextOf(pl);
      }
      const T = bombValueTable(g, AIP);
      let trueBest = null;
      for (let cy = 0; cy < g.N; cy++) for (let cx = 0; cx < g.N; cx++){
        const c = g.clone(); c.colEarnedQ[AIP] += 100000;
        const bMe = g.winScore(AIP), bOp = g.winScore(HUMAN);
        if (!c.bombAt(cx, cy, AIP)) continue;
        const tg = c.winScore(AIP) - bMe, td = bOp - c.winScore(HUMAN);
        const p = bombValueAt(g, T, cx, cy);
        worstGain = Math.max(worstGain, Math.abs(tg - p.gain));
        worstDeny = Math.max(worstDeny, Math.abs(td - p.deny));
        checked++;
        const ts = tg + DENY_WEIGHT * td;
        if (!trueBest || ts > trueBest.s) trueBest = { s: ts };
      }
      const picked = bestBomb(g, AIP);
      if (trueBest && picked){
        bestCases++;
        if (Math.abs(picked.score - trueBest.s) < 1e-9) bestAgree++;
      }
    }
  }
  console.log(`  ${checked} squares; max gain error ${worstGain}, max deny error ${worstDeny}`);
  ok(worstGain === 0, `bomb gain prediction was wrong by up to ${worstGain}`);
  ok(worstDeny === 0, `bomb deny prediction was wrong by up to ${worstDeny}`);
  ok(bestAgree === bestCases, `bestBomb picked a suboptimal target in ${bestCases - bestAgree}/${bestCases} positions`);
}

/* ---- 3. head to head --------------------------------------------- */
// Faithful turn structure: movesFor(pl) actions per turn, read once at
// the start of the turn exactly as startTurn does, since an ability and
// a placement both cost one move from the same pool.
function runMatch({ N, seed, diff, spender, stipendEvery }){
  const g = new Game(N, 2);
  g.foundCapitals(capitalSites(N, 2, mul(seed * 31)));
  const rnd = mul(seed);
  let pl = 1, turns = 0, acts = { place: 0, bomb: 0, switch: 0 };
  for (let turn = 0; turn < 4000; turn++){
    const moves = g.movesFor(pl);
    for (let k = 0; k < moves; k++){
      let a;
      if (pl === spender) a = chooseAIAction(g, rnd, diff, pl);
      else {
        const m = chooseAIMove(g, rnd, diff, pl);
        a = m ? { type: 'place', x: m.x, y: m.y } : null;
      }
      if (!a) return { g, turns, acts, stalled: true };
      let r = null;
      if (a.type === 'place')       r = g.place(a.x, a.y, pl);
      else if (a.type === 'bomb')   r = g.bombAt(a.x, a.y, pl);
      else if (a.type === 'switch') r = g.switchDot(a.x, a.y, pl);
      if (!r) return { g, turns, acts, stalled: true };
      acts[a.type]++;
      if (g.gameResult().over) return { g, turns, acts, stalled: false };
    }
    turns++;
    // identical stipend to BOTH players, so the only asymmetry is policy
    if (stipendEvery && turn % stipendEvery === 0)
      for (let p = 1; p <= 2; p++) g.colEarnedQ[p] += COL_PER_SWITCH;
    pl = g.nextOf(pl);
  }
  return { g, turns, acts, stalled: false };
}

console.log('\n== 3. spending AI vs non-spending AI, identical stipend ==');
for (const diff of ['easy', 'medium', 'hard']){
  let spenderWins = 0, plainWins = 0, draws = 0, bombs = 0, switches = 0, games = 0;
  for (let seed = 1; seed <= 10; seed++){
    // alternate which seat spends, so first-move advantage cannot explain it
    const spender = (seed % 2) ? 2 : 1;
    const r = runMatch({ N: 20, seed, diff, spender, stipendEvery: 8 });
    const w = r.g.gameResult().winner;
    games++; bombs += r.acts.bomb; switches += r.acts.switch;
    if (w === spender) spenderWins++;
    else if (w === 0) draws++;
    else plainWins++;
  }
  console.log(`  ${diff.padEnd(6)} spender ${spenderWins}  plain ${plainWins}  draw ${draws}` +
              `   | bombs used ${bombs}, switches ${switches}`);
  ok(bombs > 0, `${diff}: the spending AI never used a single bomb — policy is inert`);
  ok(spenderWins > plainWins, `${diff}: spending AI did NOT beat the non-spending AI (${spenderWins} vs ${plainWins})`);
}

/* ---- 4. the policy banks rather than fritters --------------------- */
console.log('\n== 4. tokens are saved for bombs, not spent on weak switches ==');
{
  const g = new Game(20, 2);
  g.foundCapitals(capitalSites(20, 2, mul(5)));
  const rnd = mul(5); let pl = 1;
  for (let i = 0; i < 200; i++){
    const m = chooseAIMove(g, rnd, 'medium'); if (!m) break;
    if (!g.place(m.x, m.y, pl)) break;
    pl = g.nextOf(pl);
  }
  // 4 tokens: cannot afford a bomb (costs 5), could afford 4 switches
  g.colEarnedQ[AIP] += COL_PER_SWITCH * 4;
  ok(g.switchesFor(AIP) === 4, `expected 4 tokens, got ${g.switchesFor(AIP)}`);
  let spentSwitch = 0;
  for (let i = 0; i < 40; i++){
    const a = chooseAIAction(g, mul(i + 100), 'hard', AIP);
    if (a && a.type === 'switch') spentSwitch++;
  }
  console.log(`  with 4 tokens and no bomb affordable: ${spentSwitch}/40 chose a switch`);
  ok(spentSwitch < 40, 'policy always switched, so the savings rule never fires');

  // with 5 it must reach for the bomb
  g.colEarnedQ[AIP] += COL_PER_SWITCH;
  let choseBomb = 0;
  for (let i = 0; i < 40; i++){
    const a = chooseAIAction(g, mul(i + 100), 'hard', AIP);
    if (a && a.type === 'bomb') choseBomb++;
  }
  console.log(`  with 5 tokens: ${choseBomb}/40 chose the bomb`);
  ok(choseBomb > 20, `bomb affordable but chosen only ${choseBomb}/40 times`);
}

/* ---- 5. the laser stays out ---------------------------------------- */
console.log('\n== 5. the policy never buys a dominated laser ==');
{
  let lasers = 0, n = 0;
  for (let seed = 1; seed <= 4; seed++){
    const g = new Game(20, 2);
    g.foundCapitals(capitalSites(20, 2, mul(seed * 31)));
    const rnd = mul(seed); let pl = 1;
    for (let i = 0; i < 250; i++){
      const m = chooseAIMove(g, rnd, 'medium'); if (!m) break;
      if (!g.place(m.x, m.y, pl)) break;
      pl = g.nextOf(pl);
    }
    g.colEarnedQ[AIP] += COL_PER_SWITCH * 30;
    for (let i = 0; i < 30; i++){
      const a = chooseAIAction(g, mul(i * 13 + seed), 'hard', AIP);
      n++; if (a && a.type === 'laser') lasers++;
    }
  }
  ok(lasers === 0, `${lasers}/${n} actions were lasers, which are dominated at equal cost`);
  console.log(`  ${n} well-funded decisions, ${lasers} lasers`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
