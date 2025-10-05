'use strict';

/**
 * Combat body tiers — separated so spawn logic can share compositions.
 * Each tier includes comments describing tradeoffs (DPS/HPS/EHP) and TOUGH placement.
 */

var configs = {
  CombatMelee: [
    {
      name: 'low',
      // 2 TOUGH (front-loaded), 6 ATTACK, 6 MOVE.  Balanced opener for 800 energy.
      // EHP ~ (2 tough * 100 * 0.7) + hits. Enough MOVE to keep pace with medics.
      body: [TOUGH, TOUGH, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE]
    },
    {
      name: 'mid',
      // 4 TOUGH, 10 ATTACK, 8 MOVE. Higher burst DPS and modest soak for tower doors.
      body: [TOUGH, TOUGH, TOUGH, TOUGH, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE]
    },
    {
      name: 'high',
      // 6 TOUGH up front, 12 ATTACK, 10 MOVE. Built for fortress commits when margin positive.
      body: [TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE]
    }
  ],
  CombatArcher: [
    {
      name: 'low',
      // 2 TOUGH to blunt splash, 5 RANGED, 5 MOVE.  Maintains 2:1 move ratio for kiting.
      body: [TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE]
    },
    {
      name: 'mid',
      // 4 TOUGH, 8 RANGED, 8 MOVE.  Mass-attack threshold (>=4) with extra kite margin.
      body: [TOUGH, TOUGH, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE]
    },
    {
      name: 'high',
      // 6 TOUGH, 10 RANGED, 10 MOVE.  Sustained DPS for siege + ability to reposition every tick.
      body: [TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE]
    }
  ],
  CombatMedic: [
    {
      name: 'low',
      // 2 MOVE, 2 HEAL.  24 HPS baseline to keep pace with harass squads.
      body: [MOVE, MOVE, HEAL, HEAL]
    },
    {
      name: 'mid',
      // 4 MOVE, 4 HEAL.  48 HPS; enough MOVE for swamp travel alongside melee.
      body: [MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL]
    },
    {
      name: 'high',
      // 6 MOVE, 6 HEAL.  72 HPS allows fortress pushes when tower margin favorable.
      body: [MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL]
    }
  ],
  Dismantler: [
    {
      name: 'low',
      // 4 WORK, 4 MOVE.  Door popper for low-tower windows.
      body: [WORK, WORK, WORK, WORK, MOVE, MOVE, MOVE, MOVE]
    },
    {
      name: 'mid',
      // 6 WORK, 6 MOVE.  Maintains ratio for route control.
      body: [WORK, WORK, WORK, WORK, WORK, WORK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE]
    },
    {
      name: 'high',
      // 10 WORK, 8 MOVE, 2 TOUGH (front).  Handles fortress dismantle when tower window detected.
      body: [TOUGH, TOUGH, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE]
    }
  ]
};

module.exports = configs;
