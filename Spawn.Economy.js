'use strict';
// Spawn.Economy.js
// Owns: room maturity and economy-state classification + planner economy config.
// Does not own: quota decisions and spawn queue execution.
// Called by: BeeSpawnManager.

function plannerConfig(CoreConfig) {
  var planner = CoreConfig && CoreConfig.settings && CoreConfig.settings.combat && CoreConfig.settings.combat.planner
    ? CoreConfig.settings.combat.planner
    : {};
  return { economy: planner.economy || {} };
}

function classifyRoomMaturity(room) {
  if (!room) return 'EARLY';
  var rcl = (room.controller && typeof room.controller.level === 'number') ? room.controller.level : 0;
  var cap = room.energyCapacityAvailable || 0;
  if (rcl >= 8 || cap >= 2600) return 'ENDGAME';
  if (rcl >= 6 || cap >= 1800) return 'LATE';
  if (rcl >= 4 || cap >= 800) return 'MID';
  return 'EARLY';
}

function classifyEconomyState(room, maturity, CoreConfig) {
  if (!room) return 'CRITICAL';
  var cfg = plannerConfig(CoreConfig).economy;
  var storageEnergy = room.storage && room.storage.store ? (room.storage.store[RESOURCE_ENERGY] || 0) : 0;
  var terminalEnergy = room.terminal && room.terminal.store ? (room.terminal.store[RESOURCE_ENERGY] || 0) : 0;
  var stock = storageEnergy + terminalEnergy;
  var cap = room.energyCapacityAvailable || 0;
  var rcl = (room.controller && typeof room.controller.level === 'number') ? room.controller.level : 0;
  var criticalStorage = typeof cfg.CRITICAL_STORAGE === 'number' ? cfg.CRITICAL_STORAGE : 20000;
  var strainedStorage = typeof cfg.STRAINED_STORAGE === 'number' ? cfg.STRAINED_STORAGE : 80000;
  var healthyStorage = typeof cfg.HEALTHY_STORAGE === 'number' ? cfg.HEALTHY_STORAGE : 180000;
  var criticalTerminal = typeof cfg.CRITICAL_TERMINAL === 'number' ? cfg.CRITICAL_TERMINAL : 10000;
  var strainedTerminal = typeof cfg.STRAINED_TERMINAL === 'number' ? cfg.STRAINED_TERMINAL : 40000;
  var healthyTerminal = typeof cfg.HEALTHY_TERMINAL === 'number' ? cfg.HEALTHY_TERMINAL : 100000;
  var earlyCap = typeof cfg.EARLY_CAPACITY === 'number' ? cfg.EARLY_CAPACITY : 550;
  var midCap = typeof cfg.MID_CAPACITY === 'number' ? cfg.MID_CAPACITY : 1300;
  var lateCap = typeof cfg.LATE_CAPACITY === 'number' ? cfg.LATE_CAPACITY : 2300;
  if (!room.storage && !room.terminal) {
    if (cap <= earlyCap || rcl <= 3) return 'CRITICAL';
    if (cap <= midCap || rcl <= 5) return 'STRAINED';
    if (cap <= lateCap || maturity === 'LATE') return 'HEALTHY';
    return 'RICH';
  }
  if (storageEnergy <= criticalStorage && terminalEnergy <= criticalTerminal) return 'CRITICAL';
  if (stock <= strainedStorage || (terminalEnergy > 0 && terminalEnergy <= strainedTerminal)) return 'STRAINED';
  if (stock <= healthyStorage || (terminalEnergy > 0 && terminalEnergy <= healthyTerminal)) return 'HEALTHY';
  return 'RICH';
}

module.exports = { plannerConfig: plannerConfig, classifyRoomMaturity: classifyRoomMaturity, classifyEconomyState: classifyEconomyState };
