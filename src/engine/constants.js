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

// Colonized ground counts this much EXTRA toward the win condition, on top of
// the once it already counts via scoreQ. 1 = colonized ground is worth double
// a plain square. Consequence: a player whose holdings are ENTIRELY colonized
// wins at (1/np)/(1+COL_WIN_BONUS) of the board — 25% in a 2-player game at 1.
// Intended: taking a quarter of the board off your opponent is a win; fencing
// half of empty ground is not.
export const COL_WIN_BONUS  = 1;

export function oppOf(p){ return p === 1 ? 2 : 1; }   // 2-player only (AI paths)

/* ---- capital ------------------------------------------------------
   The capital is NORMAL GROUND plus a marker: no engine guards, no bomb
   immunity. See CLAUDE.md. These two dials control PLACEMENT only.

   The margin scales with N rather than being fixed. A fixed margin of 2
   leaves a 6x6 board with ZERO legal sites once minimum separation is
   applied, which would make the admin small boards useless for testing
   the capital — and on a 300x300 a margin of 2 is functionally the rim.
   "Inland" only means something relative to board size. */
export const CAPITAL_MARGIN_DIV = 10;  // margin = max(1, round(N / this))
export const CAPITAL_MIN_SEP    = 2;   // min Chebyshev gap, in squares, between capitals
