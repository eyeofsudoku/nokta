/* ================================================================
   Tunable rules and player identities — the single source of truth.
   DOM-free. Imports nothing.
   ================================================================ */
'use strict';

export const HUMAN = 1, AIP = 2, GREEN = 3;

/* ---- tunable rules (change here, nothing else) -------------------- */
export const COL_PER_SWITCH = 40;   // quarter-cells of lifetime colonization per switch token (40 = 10 area)
export const COL_PER_MOVE   = 400;  // quarter-cells of live colonization per bonus move  (400 = 100 area)
export const BOMB_COST      = 5;    // switch tokens spent to detonate one bomb
export const BOMB_SIZE      = 5;    // blast is BOMB_SIZE x BOMB_SIZE squares; keep ODD so it has a true centre
// Laser. LASER_COST is kept separate from BOMB_COST even though both start at
// 5: they are different tools and need independent tuning. A bomb is a
// guaranteed 25-area grab; a laser may capture a great deal or nothing at all.
export const LASER_LEN      = 10;   // ray length in POSITIONS, not dots landed
export const LASER_COST     = 5;    // switch tokens spent to fire one laser

export function oppOf(p){ return p === 1 ? 2 : 1; }   // 2-player only (AI paths)
