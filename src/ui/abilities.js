/* ================================================================
   ABILITY REGISTRY — the single source of truth for the EXTRAS picker.

   Everything the UI needs to show, price, enable and arm an ability lives
   in one entry here. Adding a new ability should be ONE entry in this
   table plus whatever engine work it needs — never edits scattered
   through index.html. If you find yourself editing the modal, the button
   or the key handling to add one, this abstraction has failed; fix it
   here rather than working around it.

   Costs and sizes are read from constants.js, never restated, so
   retuning BOMB_COST or LASER_LEN updates the picker automatically.

   DOM-free on purpose: `mode` is the arming instruction (it is the value
   the UI puts in armedMode), so this file needs no access to UI globals
   and stays importable and testable on its own.
   ================================================================ */
'use strict';

import { COL_PER_SWITCH, BOMB_COST, BOMB_SIZE, LASER_COST, LASER_LEN }
  from '../engine/constants.js';

// The engine has no SWITCH_COST constant — canSwitch() encodes the price
// as `switchesFor(pl) > 0`. Declared here so the picker has one number to
// read, but the engine is still the authority: if a real constant is ever
// added to constants.js, import it and delete this.
export const SWITCH_COST = 1;

export const ABILITIES = [
  {
    id: 'switch',
    mode: 'switch',
    icon: '⇄',
    name: 'Switch',
    cost: SWITCH_COST,
    description: 'Flip one opponent dot to your colour. Their enclosure breaks; '
               + 'they keep only what their remaining lines still enclose.',
    canUse: (game, pl) => game.switchesFor(pl) >= SWITCH_COST,
  },
  {
    id: 'bomb',
    mode: 'bomb',
    icon: '\u{1F4A5}',
    name: 'Bomb',
    cost: BOMB_COST,
    description: `Claim a ${BOMB_SIZE}×${BOMB_SIZE} square. Enemy ground inside is `
               + 'colonized; enemy ground in the ring around it is destroyed.',
    canUse: (game, pl) => game.switchesFor(pl) >= BOMB_COST,
  },
  {
    id: 'laser',
    mode: 'laser',
    icon: '⚡',
    name: 'Laser',
    cost: LASER_COST,
    description: `Fire up to ${LASER_LEN} dots in a straight line. R rotates direction; `
               + 'blocked points are skipped.',
    canUse: (game, pl) => game.switchesFor(pl) >= LASER_COST,
  },
];

export function abilityByMode(mode){
  return ABILITIES.find(a => a.mode === mode) || null;
}

export function anyAffordable(game, pl){
  return ABILITIES.some(a => a.canUse(game, pl));
}

// Tokens held, and how far to the next one. colEarnedQ is lifetime and
// monotonic, so the remainder against COL_PER_SWITCH is genuine progress.
export function tokenProgress(game, pl){
  const have = game.switchesFor(pl);
  const into = game.colEarnedQ[pl] % COL_PER_SWITCH;
  return { have, into, per: COL_PER_SWITCH, toNext: COL_PER_SWITCH - into };
}
