'use strict';

/**
 * bodyConfigs.combat.es5.js
 * -------------------------------------------------
 * Tiered body layouts for combat roles. Each tier is
 * tuned for a specific energy bracket with comments
 * explaining survivability and role intent.
 *
 * Export shape:
 *   module.exports = {
 *     CombatArcher: [ { tier: 'Skirmisher', minEnergy: 550, body: [...], note: '...' }, ... ],
 *     ...
 *   };
 *
 * Tiers are ordered strongest-first; caller picks the
 * first layout whose minEnergy <= available energy.
 */

var configs = {
  CombatArcher: [
    {
      tier: 'Siege Ranger',
      minEnergy: 2000,
      body: [
        MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, // mobility so we can kite even with fatigue
        RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK,
        RANGED_ATTACK, RANGED_ATTACK,
        HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, // 6 HEAL → 72 HPS (keeps pace with two towers)
        TOUGH, TOUGH, TOUGH, TOUGH // front padding vs chip damage
      ],
      note: 'Late-game fortress ranger: 6 HEAL keeps 2x tower focus sustainable while firing at full DPS.'
    },
    {
      tier: 'Heavy Ranger',
      minEnergy: 1300,
      body: [
        MOVE, MOVE, MOVE, MOVE, MOVE,
        RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK,
        RANGED_ATTACK,
        HEAL, HEAL, HEAL, HEAL,
        TOUGH, TOUGH
      ],
      note: 'Balanced kiter: 5 MOVE keeps 4 ranged + 4 heal parts mobile; 4 HEAL → 48 HPS (enough for softened tower fire).'
    },
    {
      tier: 'Skirmisher',
      minEnergy: 780,
      body: [
        MOVE, MOVE, MOVE, MOVE,
        RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK,
        HEAL, HEAL,
        TOUGH
      ],
      note: 'Starter invader hunter: 3 ranged to one-shot drones, 2 HEAL to self-sustain under light tower splash.'
    },
    {
      tier: 'Scout Archer',
      minEnergy: 480,
      body: [MOVE, MOVE, MOVE, RANGED_ATTACK, RANGED_ATTACK, HEAL],
      note: 'Emergency: two ranged + one heal keep basic kiting alive for remote harass.'
    }
  ],

  CombatMedic: [
    {
      tier: 'Fortress Surgeon',
      minEnergy: 1950,
      body: [
        MOVE, MOVE, MOVE, MOVE, MOVE, MOVE,
        HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, // 8 HEAL = 96 HPS
        TOUGH, TOUGH, TOUGH, TOUGH // buffer vs burst
      ],
      note: 'Primary sustain backbone: 6 MOVE avoids fatigue while pushing 96 HPS for tower windows.'
    },
    {
      tier: 'Battle Medic',
      minEnergy: 1320,
      body: [
        MOVE, MOVE, MOVE, MOVE, MOVE,
        HEAL, HEAL, HEAL, HEAL, HEAL, HEAL,
        TOUGH, TOUGH
      ],
      note: 'Mid-tier support: 5 MOVE keeps up with armored melee; 6 HEAL = 72 HPS (enough for single tower + chip).'
    },
    {
      tier: 'Field Nurse',
      minEnergy: 780,
      body: [MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL, HEAL],
      note: 'Budget escort: 4 MOVE + 5 HEAL = 60 HPS, handles invader rifles.'
    },
    {
      tier: 'First Aid',
      minEnergy: 450,
      body: [MOVE, MOVE, MOVE, HEAL, HEAL, HEAL],
      note: 'Emergency filler when economy is strained; 3 HEAL to cover chip damage while regrouping.'
    }
  ],

  CombatMelee: [
    {
      tier: 'Rampart Breaker',
      minEnergy: 2080,
      body: [
        TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH,
        MOVE, MOVE, MOVE, MOVE, MOVE, MOVE,
        ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK,
        HEAL, HEAL
      ],
      note: 'Eight TOUGH up front absorb tower alpha; 6 ATTACK = 360 burst, 2 HEAL for self top-off when medic busy.'
    },
    {
      tier: 'Shield Bearer',
      minEnergy: 1500,
      body: [
        TOUGH, TOUGH, TOUGH, TOUGH, TOUGH,
        MOVE, MOVE, MOVE, MOVE, MOVE,
        ATTACK, ATTACK, ATTACK, ATTACK,
        HEAL, HEAL
      ],
      note: 'Tower-window bruiser: 5 TOUGH reduce first volley; 4 ATTACK keep pressure, paired with medic for sustain.'
    },
    {
      tier: 'Vanguard',
      minEnergy: 960,
      body: [TOUGH, TOUGH, TOUGH, MOVE, MOVE, MOVE, ATTACK, ATTACK, ATTACK, HEAL],
      note: 'Invader cleaner: 3 ATTACK for burst, 1 HEAL to patch small hits while holding aggro.'
    },
    {
      tier: 'Bruiser',
      minEnergy: 520,
      body: [TOUGH, TOUGH, MOVE, MOVE, ATTACK, ATTACK],
      note: 'Emergency wall: double ATTACK for threat control when towers offline.'
    }
  ],

  Dismantler: [
    {
      tier: 'Siege Dismantler',
      minEnergy: 2300,
      body: [
        MOVE, MOVE, MOVE, MOVE, MOVE, MOVE,
        WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK,
        HEAL, HEAL
      ],
      note: 'Nine WORK punch 405 dismantle DPS; 2 HEAL offset tower splash with medic backing.'
    },
    {
      tier: 'Assault Dismantler',
      minEnergy: 1600,
      body: [
        MOVE, MOVE, MOVE, MOVE, MOVE,
        WORK, WORK, WORK, WORK, WORK, WORK,
        HEAL
      ],
      note: 'Six WORK gives 270 DPS; 1 HEAL handles chip damage while hugging medic cover.'
    },
    {
      tier: 'Breacher',
      minEnergy: 950,
      body: [MOVE, MOVE, MOVE, WORK, WORK, WORK, WORK, WORK],
      note: 'Rampart opener for mid-RCL rooms; rely on medic adjacency for heals.'
    },
    {
      tier: 'Opportunist',
      minEnergy: 550,
      body: [MOVE, MOVE, WORK, WORK, WORK, WORK],
      note: 'Cheap utility for damaged walls or low tower rooms; avoid soloing tough forts.'
    }
  ]
};

module.exports = configs;
