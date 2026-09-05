/* ================================================================
   GEOMETRY — pure index maths. DOM-free, state-free.
   Every function here is a function of the board dimensions
   (N squares per side, P = N+1 lattice points per side) and its
   arguments only, so it can be reasoned about in isolation.

   Geometry model (screen coordinates, y grows down):
   - Board of N×N unit squares, (N+1)×(N+1) lattice points.
   - Square (sx,sy): TL=(sx,sy) TR=(sx+1,sy) BR=(sx+1,sy+1) BL=(sx,sy+1)
   - Each square is decomposed into 4 atomic quarter-triangles that
     meet at the square's center M (area 0.25 each):
       t=0 N (TL,TR,M)   t=1 E (TR,BR,M)   t=2 S (BR,BL,M)   t=3 W (BL,TL,M)
   - Edge slots (single owner each, so two players can never share
     or cross on the same slot):
       hE[y*P+x] : (x,y)-(x+1,y)          x<N
       vE[y*P+x] : (x,y)-(x,y+1)          y<N
       dA[sy*N+sx] : TL-BR  "\"  — separates {N,E} | {S,W}, i.e. blocks N<->W and E<->S
       dB[sy*N+sx] : TR-BL  "/"  — separates {N,W} | {E,S}, i.e. blocks N<->E and S<->W
     In this constrained geometry the ONLY possible segment crossing
     is dA vs dB inside the same square (all other segment pairs meet
     at endpoints at most), so the crossing rule is: a diagonal is
     illegal iff the opposite diagonal of that square exists.
   ================================================================ */
'use strict';

import { BOMB_SIZE, CAPITAL_MARGIN_DIV, CAPITAL_MIN_SEP } from './constants.js';

/* ---- index maths ------------------------------------------------ */
export function pi(P, x, y){ return y * P + x; }
export function inP(P, x, y){ return x >= 0 && y >= 0 && x < P && y < P; }
export function inS(N, x, y){ return x >= 0 && y >= 0 && x < N && y < N; }

/* ---- point <-> incident quarter-cells -------------------------- */
// The (up to 8) quarter-cells having lattice point (x,y) as a vertex.
export function incidentCells(N, x, y, cb){
  // [square sx, square sy, tri a, tri b] — point's role in that square:
  // TL -> N,W ; TR -> N,E ; BR -> E,S ; BL -> S,W
  if (x < N     && y < N    ){ const b = (y * N + x) * 4;             cb(b + 0); cb(b + 3); } // TL of (x,y)
  if (x > 0     && y < N    ){ const b = (y * N + (x - 1)) * 4;       cb(b + 0); cb(b + 1); } // TR of (x-1,y)
  if (x > 0     && y > 0    ){ const b = ((y - 1) * N + (x - 1)) * 4; cb(b + 1); cb(b + 2); } // BR of (x-1,y-1)
  if (x < N     && y > 0    ){ const b = ((y - 1) * N + x) * 4;       cb(b + 2); cb(b + 3); } // BL of (x,y-1)
}

// The 8 edge slots incident to lattice point (x,y). Mirrors newEdges'
// geometry exactly — an edge slot only ever exists between two dots of
// the same owner, so any incident slot owned by `who` involves this dot.
export function incidentEdges(P, N, x, y){
  const res = [];
  if (x < N)                 res.push({ t: 0, i: y * P + x });
  if (x > 0)                 res.push({ t: 0, i: y * P + (x - 1) });
  if (y < N)                 res.push({ t: 1, i: y * P + x });
  if (y > 0)                 res.push({ t: 1, i: (y - 1) * P + x });
  if (inS(N, x, y))                 res.push({ t: 2, i: y * N + x });
  if (inS(N, x - 1, y - 1))         res.push({ t: 2, i: (y - 1) * N + (x - 1) });
  if (inS(N, x, y - 1))             res.push({ t: 3, i: (y - 1) * N + x });
  if (inS(N, x - 1, y))             res.push({ t: 3, i: y * N + (x - 1) });
  return res;
}

/* ---- blast geometry --------------------------------------------- */
// Blast covers a BOMB_SIZE square centred on square (cx,cy), clipped to the
// board so a centre near the edge still works.
export function blastBounds(N, cx, cy){
  const h = (BOMB_SIZE - 1) >> 1;
  return {
    x0: Math.max(0, cx - h), x1: Math.min(N - 1, cx + h),
    y0: Math.max(0, cy - h), y1: Math.min(N - 1, cy + h)
  };
}

export function inBlast(N, c, b){
  const s = c >> 2, sx = s % N, sy = (s / N) | 0;
  return sx >= b.x0 && sx <= b.x1 && sy >= b.y0 && sy <= b.y1;
}

// Geometric neighbours of a quarter-cell, IGNORING lines. Territory
// "regions" are contiguous blobs of one owner, not line-bounded faces —
// a bomb dissolves the whole blob it clips into.
export function cellNeighbours(N, c, out){
  const t = c & 3, s = c >> 2, sx = s % N, sy = (s / N) | 0, b = s * 4;
  out.length = 0;
  out.push(b + ((t + 1) & 3), b + ((t + 3) & 3));
  if      (t === 0){ if (sy > 0)     out.push(((sy - 1) * N + sx) * 4 + 2); }
  else if (t === 1){ if (sx < N - 1) out.push((sy * N + sx + 1) * 4 + 3); }
  else if (t === 2){ if (sy < N - 1) out.push(((sy + 1) * N + sx) * 4 + 0); }
  else             { if (sx > 0)     out.push((sy * N + sx - 1) * 4 + 1); }
}

// Laser directions, index 0-7: E, SE, S, SW, W, NW, N, NE (screen coords, y
// grows down). The anchor is the START of the ray, not its centre, so the two
// senses of each axis are genuinely different rays — a line is symmetric at
// 180° only when centred. All 8 are distinct and the index travels over the
// wire, so this order is part of the protocol: do not reorder it.
export const LASER_DIRS = [
  [ 1,  0], [ 1,  1], [ 0,  1], [-1,  1],
  [-1,  0], [-1, -1], [ 0, -1], [ 1, -1],
];

/* ---- capital placement ------------------------------------------
   Pure functions of the board dimensions. No state, no engine access.

   Two layers on purpose:
   - capitalSitesFrom() is fully DETERMINISTIC — given the anchor square
     it derives every site. This is the part the netcode depends on and
     the part the tests enumerate exhaustively.
   - capitalSites() is the thin random layer that only chooses the
     anchor. The host picks once and sends the resulting COORDINATES in
     the start message, never a seed, so replaying an action stream on a
     fresh engine still reproduces a byte-identical board.

   Capitals are born like a blast: 4 corner dots and 4 owned edges. Two
   capitals sharing a corner dot would put two owners on one edge slot,
   which is unrepresentable — hence CAPITAL_MIN_SEP. */

// Squares of clear rim on every side. Scales with N; never below 1.
export function capitalMargin(N){
  return Math.max(1, Math.round(N / CAPITAL_MARGIN_DIV));
}

// Is (sx,sy) a square at least `margin` squares clear of every rim?
function inland(N, sx, sy, m){
  return sx >= m && sy >= m && sx <= N - 1 - m && sy <= N - 1 - m;
}

// Chebyshev gap in squares. Two squares that touch (even diagonally)
// measure 1; a gap of >= CAPITAL_MIN_SEP leaves a clear square between.
function sep(a, b){
  return Math.max(Math.abs(a.sx - b.sx), Math.abs(a.sy - b.sy));
}

// Every capital site derived from one anchor square, or null if the
// resulting layout is illegal (off board, too near a rim, or two
// capitals close enough to share a corner dot).
//
// 2p: exact 180 degree rotation about the board centre.
// 3p: three points 120 degrees apart on the circle through the anchor,
//     ROUNDED to squares — near-symmetric, not exact. Accepted: a lattice
//     has no exact 3-fold symmetry about a square centre.
export function capitalSitesFrom(N, np, sx, sy){
  const m = capitalMargin(N);
  if (!inS(N, sx, sy) || !inland(N, sx, sy, m)) return null;

  const sites = [{ sx, sy }];
  const c = (N - 1) / 2, dx = sx - c, dy = sy - c;

  if (np === 2){
    sites.push({ sx: N - 1 - sx, sy: N - 1 - sy });
  } else if (np === 3){
    for (const a of [2 * Math.PI / 3, 4 * Math.PI / 3]){
      const cs = Math.cos(a), sn = Math.sin(a);
      sites.push({
        sx: Math.round(c + dx * cs - dy * sn),
        sy: Math.round(c + dx * sn + dy * cs)
      });
    }
  } else return null;

  for (const s of sites)
    if (!inS(N, s.sx, s.sy) || !inland(N, s.sx, s.sy, m)) return null;
  for (let i = 0; i < sites.length; i++)
    for (let j = i + 1; j < sites.length; j++)
      if (sep(sites[i], sites[j]) < CAPITAL_MIN_SEP) return null;

  return sites;
}

// Every anchor square that yields a legal layout. Enumerated rather than
// rejection-sampled so an impossible board reports empty instead of
// spinning forever, and so tests can measure how much choice a board has.
export function capitalAnchors(N, np){
  const m = capitalMargin(N), out = [];
  for (let sy = m; sy <= N - 1 - m; sy++)
    for (let sx = m; sx <= N - 1 - m; sx++)
      if (capitalSitesFrom(N, np, sx, sy)) out.push({ sx, sy });
  return out;
}

// Pick a layout at random. Returns null when the board admits none, so
// the caller decides whether to play without capitals rather than the
// geometry throwing.
export function capitalSites(N, np, rnd){
  const anchors = capitalAnchors(N, np);
  if (!anchors.length) return null;
  const r = (rnd || Math.random)();
  const a = anchors[Math.min(anchors.length - 1, Math.floor(r * anchors.length))];
  return capitalSitesFrom(N, np, a.sx, a.sy);
}
