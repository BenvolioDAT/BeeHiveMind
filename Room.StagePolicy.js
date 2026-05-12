'use strict';

var STAGES_BY_RCL = {
  0: {
    rcl: 0,
    id: 'RCL0_UNKNOWN',
    name: 'RCL 0 - Unknown',
    focus: 'Room controller data is unavailable; use safe fallback metadata only.'
  },
  1: {
    rcl: 1,
    id: 'RCL1_BOOTSTRAP_SURVIVAL',
    name: 'RCL 1 - Bootstrap Survival',
    focus: 'Keep the room alive with basic harvesting and upgrading until RCL 2 is reached.'
  },
  2: {
    rcl: 2,
    id: 'RCL2_EXTENSION_RUSH',
    name: 'RCL 2 - Extension Rush',
    focus: 'Build the first extension set quickly and stabilize early logistics support.'
  },
  3: {
    rcl: 3,
    id: 'RCL3_TOWER_BOOTSTRAP',
    name: 'RCL 3 - Tower Bootstrap',
    focus: 'Build and feed the first tower while continuing extension and economy growth.'
  },
  4: {
    rcl: 4,
    id: 'RCL4_STORAGE_PIVOT',
    name: 'RCL 4 - Storage Pivot',
    focus: 'Build storage and prepare the room to shift from spawn-fed logistics to stored-energy logistics.'
  },
  5: {
    rcl: 5,
    id: 'RCL5_LINK_ECONOMY',
    name: 'RCL 5 - Link Economy',
    focus: 'Build useful links and reduce hauling pressure with link-supported energy flow.'
  },
  6: {
    rcl: 6,
    id: 'RCL6_TERMINAL_MINERAL_UNLOCK',
    name: 'RCL 6 - Terminal / Mineral Unlock',
    focus: 'Unlock terminal and mineral operations after storage-backed logistics are stable.'
  },
  7: {
    rcl: 7,
    id: 'RCL7_THROUGHPUT_EXPANSION',
    name: 'RCL 7 - Throughput Expansion',
    focus: 'Use second-spawn throughput and larger infrastructure capacity to scale production.'
  },
  8: {
    rcl: 8,
    id: 'RCL8_ENDGAME_SPECIALIZATION',
    name: 'RCL 8 - Endgame Specialization',
    focus: 'Specialize the room with full endgame infrastructure for long-term goals.'
  }
};

var POLICIES_BY_RCL = {
  0: {
    primaryGoal: 'Use safe fallback policy metadata when room controller level is unknown.',
    secondaryGoals: ['Wait for valid room/controller data.', 'Keep policy output stable and readable for debugging.'],
    avoidForNow: ['Behavior changes based on unknown inputs.', 'Assuming owned-room progression state.'],
    structureFocus: { spawn: false, extensions: false, tower: false, storage: false, links: false, terminal: false, extractor: false, labs: false, factory: false, observer: false, powerSpawn: false, nuker: false },
    spawnStrategyHint: { survivalFirst: true, growthAllowed: false, remoteAllowed: false, combatOnlyIfThreatened: true }
  },
  1: {
    primaryGoal: 'Keep the room alive and upgrade to RCL 2.',
    secondaryGoals: ['Maintain basic harvesting and upgrading.', 'Build simple roads/containers only when useful.'],
    avoidForNow: ['Remote mining expansion.', 'Heavy construction or combat planning unless hostile emergency.'],
    structureFocus: { spawn: true, extensions: false, tower: false, storage: false, links: false, terminal: false, extractor: false, labs: false, factory: false, observer: false, powerSpawn: false, nuker: false },
    spawnStrategyHint: { survivalFirst: true, growthAllowed: false, remoteAllowed: false, combatOnlyIfThreatened: true }
  },
  2: {
    primaryGoal: 'Build the first 5 extensions quickly.',
    secondaryGoals: ['Stabilize harvesting flow.', 'Add basic courier support around extension fill.'],
    avoidForNow: ['Remote expansion.', 'Expensive nonessential work.'],
    structureFocus: { spawn: true, extensions: true, tower: false, storage: false, links: false, terminal: false, extractor: false, labs: false, factory: false, observer: false, powerSpawn: false, nuker: false },
    spawnStrategyHint: { survivalFirst: true, growthAllowed: true, remoteAllowed: false, combatOnlyIfThreatened: true }
  },
  3: {
    primaryGoal: 'Build and feed the first tower.',
    secondaryGoals: ['Keep tower energy stable once built.', 'Continue extension growth and basic repair safety.'],
    avoidForNow: ['Overbuilding roads/walls before tower is functional.', 'Optional heavy projects that slow tower readiness.'],
    structureFocus: { spawn: true, extensions: true, tower: true, storage: false, links: false, terminal: false, extractor: false, labs: false, factory: false, observer: false, powerSpawn: false, nuker: false },
    spawnStrategyHint: { survivalFirst: true, growthAllowed: true, remoteAllowed: false, combatOnlyIfThreatened: true }
  },
  4: {
    primaryGoal: 'Build storage and shift logistics around stored energy.',
    secondaryGoals: ['Prepare Queen logistics readiness.', 'Maintain stable builder and repair support during pivot.'],
    avoidForNow: ['Spending all energy on upgrading while storage/bootstrap work is unfinished.', 'Unplanned expansion before storage is online.'],
    structureFocus: { spawn: true, extensions: true, tower: true, storage: true, links: false, terminal: false, extractor: false, labs: false, factory: false, observer: false, powerSpawn: false, nuker: false },
    spawnStrategyHint: { survivalFirst: true, growthAllowed: true, remoteAllowed: true, combatOnlyIfThreatened: true }
  },
  5: {
    primaryGoal: 'Build useful links and reduce courier pressure.',
    secondaryGoals: ['Establish source/controller link routing.', 'Keep storage-backed logistics stable while links ramp.'],
    avoidForNow: ['Overcommitting courier scaling when links should replace hauling later.', 'Premature advanced-industry complexity.'],
    structureFocus: { spawn: true, extensions: true, tower: true, storage: true, links: true, terminal: false, extractor: false, labs: false, factory: false, observer: false, powerSpawn: false, nuker: false },
    spawnStrategyHint: { survivalFirst: true, growthAllowed: true, remoteAllowed: true, combatOnlyIfThreatened: true }
  },
  6: {
    primaryGoal: 'Unlock terminal and mineral operations.',
    secondaryGoals: ['Construct terminal and extractor.', 'Prepare basic labs/mineral readiness if planned.'],
    avoidForNow: ['Mineral and market complexity before storage/terminal stability.', 'Overexpansion that weakens core economy.'],
    structureFocus: { spawn: true, extensions: true, tower: true, storage: true, links: true, terminal: true, extractor: true, labs: true, factory: false, observer: false, powerSpawn: false, nuker: false },
    spawnStrategyHint: { survivalFirst: true, growthAllowed: true, remoteAllowed: true, combatOnlyIfThreatened: true }
  },
  7: {
    primaryGoal: 'Use the second spawn and larger extension capacity to increase throughput.',
    secondaryGoals: ['Strengthen spawn pipeline throughput.', 'Expand tower/lab coverage and factory readiness.'],
    avoidForNow: ['Treating the room like RCL 4/5 once extra spawn capacity exists.', 'Bottlenecking on old single-spawn assumptions.'],
    structureFocus: { spawn: true, extensions: true, tower: true, storage: true, links: true, terminal: true, extractor: true, labs: true, factory: true, observer: false, powerSpawn: false, nuker: false },
    spawnStrategyHint: { survivalFirst: false, growthAllowed: true, remoteAllowed: true, combatOnlyIfThreatened: true }
  },
  8: {
    primaryGoal: 'Specialize the room for its long-term purpose.',
    secondaryGoals: ['Use full endgame infrastructure capacity.', 'Drive role/infrastructure specialization in future policy PRs.'],
    avoidForNow: ['Generic do-everything-equally planning.', 'Keeping all priorities at flat baseline levels.'],
    structureFocus: { spawn: true, extensions: true, tower: true, storage: true, links: true, terminal: true, extractor: true, labs: true, factory: true, observer: true, powerSpawn: true, nuker: true },
    spawnStrategyHint: { survivalFirst: false, growthAllowed: true, remoteAllowed: true, combatOnlyIfThreatened: true }
  }
};

function getRoomStage(room) {
  try {
    if (!room || !room.controller || typeof room.controller.level !== 'number') {
      return STAGES_BY_RCL[0];
    }
    var level = Math.floor(room.controller.level);
    if (level < 1) level = 1;
    if (level > 8) level = 8;
    return STAGES_BY_RCL[level] || STAGES_BY_RCL[0];
  } catch (err) {
    return STAGES_BY_RCL[0];
  }
}

function getRoomStagePolicy(room) {
  try {
    var stage = getRoomStage(room);
    var policy = POLICIES_BY_RCL[stage.rcl] || POLICIES_BY_RCL[0];
    return {
      stage: stage,
      primaryGoal: policy.primaryGoal,
      secondaryGoals: policy.secondaryGoals,
      avoidForNow: policy.avoidForNow,
      structureFocus: policy.structureFocus,
      spawnStrategyHint: policy.spawnStrategyHint
    };
  } catch (err) {
    return {
      stage: STAGES_BY_RCL[0],
      primaryGoal: POLICIES_BY_RCL[0].primaryGoal,
      secondaryGoals: POLICIES_BY_RCL[0].secondaryGoals,
      avoidForNow: POLICIES_BY_RCL[0].avoidForNow,
      structureFocus: POLICIES_BY_RCL[0].structureFocus,
      spawnStrategyHint: POLICIES_BY_RCL[0].spawnStrategyHint
    };
  }
}

module.exports = {
  getRoomStage: getRoomStage,
  getRoomStagePolicy: getRoomStagePolicy
};
