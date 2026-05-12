'use strict';

// Owns: spawn arbitration gates and queue-item allow/deny checks.
// Does not own: queue mutation or spawn execution.
// Called by: BeeSpawnManager.

function budgetBlocksRole(arb, role, band, hasUrgentException, deps) {
  if (!arb || !arb.recoveryMode) return false;
  if (!arb.bandUsage || arb.bandUsage.total < deps.BAND_BUDGET_MIN_SAMPLES) return false;
  if (deps.FLOOR_ROLE_SET[role]) return false;
  if (hasUrgentException) return false;
  var cap = arb.budgetCaps && arb.budgetCaps[band];
  if (typeof cap !== 'number') return false;
  var share = arb.bandUsage.shares && typeof arb.bandUsage.shares[band] === 'number' ? arb.bandUsage.shares[band] : 0;
  return share > cap;
}

function suppressedBandsForState(economyState, recoveryMode) {
  var map = {};
  if (economyState === 'CRITICAL') { map.GROWTH = true; map.SUPPORT = true; map.SITUATIONAL = true; }
  else if (economyState === 'STRAINED') map.SITUATIONAL = true;
  if (recoveryMode) { map.GROWTH = true; map.SUPPORT = true; map.SITUATIONAL = true; }
  return map;
}

function isEmergencyDefenseNeeded(roomName, deps) {
  if (!roomName) return false;
  var score = deps.SquadFlagIntel && typeof deps.SquadFlagIntel.threatScoreForRoom === 'function' ? (deps.SquadFlagIntel.threatScoreForRoom(roomName) || 0) : 0;
  if (score > 0) return true;
  var room = Game.rooms[roomName];
  if (!room || typeof room.find !== 'function') return false;
  return (room.find(FIND_HOSTILE_CREEPS) || []).length > 0;
}

function recordBlockedRoleReason(debug, role, reason) {
  if (!debug || !role || !reason) return;
  if (!debug.arbitration) debug.arbitration = {};
  if (!debug.arbitration.blockedRoleReasons) debug.arbitration.blockedRoleReasons = {};
  debug.arbitration.blockedRoleReasons[role] = reason;
}

function canSpawnQueuedRoleSimple(C, room, roomName, role, item, quotas, deps) {
  var canonical = deps.canonicalRole(role);
  if (!canonical) return { allowed: false, reason: 'INVALID_ROLE' };
  var energyAvailable = room && typeof room.energyAvailable === 'number' ? room.energyAvailable : 0;
  if (energyAvailable < deps.minEnergyFor(canonical)) return { allowed: false, reason: 'BLOCKED_LOW_ENERGY' };

  var sourceCount = room && typeof room.find === 'function' ? (room.find(FIND_SOURCES) || []).length : 0;
  var quotaBaseHarvest = (quotas && typeof quotas.BaseHarvest === 'number') ? quotas.BaseHarvest : sourceCount;
  var baseHarvestFloor = sourceCount > 0 ? Math.min(quotaBaseHarvest, sourceCount) : Math.max(0, quotaBaseHarvest);
  var survivalFloors = {
    BaseHarvest: Math.max(0, baseHarvestFloor),
    Courier: Math.max(0, Math.min((quotas && quotas.Courier) || 0, deps.PROTECTED_ROLE_FLOORS.Courier)),
    Queen: Math.max(0, Math.min((quotas && quotas.Queen) || 0, deps.PROTECTED_ROLE_FLOORS.Queen))
  };

  var survivalRoles = ['BaseHarvest', 'Courier', 'Queen'];
  var unmetSurvival = [];
  for (var i = 0; i < survivalRoles.length; i++) {
    var sRole = survivalRoles[i];
    var floor = survivalFloors[sRole] || 0;
    if (floor <= 0) continue;
    var live = deps.getRoomLocalLiveCount(C, roomName, sRole);
    if (live < floor) unmetSurvival.push(sRole);
  }

  if (deps.FLOOR_ROLE_SET[canonical]) {
    var required = survivalFloors[canonical] || 0;
    if (required > 0 && deps.getRoomLocalLiveCount(C, roomName, canonical) < required) return { allowed: true, reason: 'SURVIVAL_FLOOR_NEEDED' };
  }
  if (unmetSurvival.length > 0 && !deps.FLOOR_ROLE_SET[canonical]) return { allowed: false, reason: 'BLOCKED_SURVIVAL_FLOOR_UNMET', unmetSurvival: unmetSurvival };

  // Support gate: Builder and Scout use simple gates so they do not get starved forever or over-spawn.
  if (canonical === 'Builder' || canonical === 'Scout') {
    var quota = Math.max(0, (quotas && quotas[canonical]) || 0);
    var liveCount = deps.getRoomLocalLiveCount(C, roomName, canonical);
    if (quota <= 0) return liveCount <= 0 ? { allowed: true, reason: 'SIMPLE_SUPPORT_ALLOWED' } : { allowed: false, reason: 'BLOCKED_LIVE_AT_OR_ABOVE_QUOTA' };
    if (liveCount >= quota) return { allowed: false, reason: 'BLOCKED_LIVE_AT_OR_ABOVE_QUOTA' };
    return { allowed: true, reason: 'SIMPLE_SUPPORT_ALLOWED' };
  }
  return { allowed: true, reason: 'ALLOWED' };
}

function queueItemAllowed(item, arb, deps) {
  // Arbitration decides whether a queued creep is allowed to spawn right now.
  if (!item || !arb) return { allowed: true, reason: 'NO_ARB' };
  var role = deps.canonicalRole(item.role);
  if (role === 'Builder' || role === 'Scout') return canSpawnQueuedRoleSimple(arb.C, arb.room, arb.roomName, role, item, arb.quotas || {}, deps);

  var band = deps.roleBand(role);
  var builderException = role === 'Builder' && arb.urgentBacklog && arb.urgentBacklog.builder && arb.recoveryMode && ((arb.roleTotals && arb.roleTotals.Builder) || 0) < 1;
  var repairException = role === 'Repair' && arb.urgentBacklog && arb.urgentBacklog.repair && arb.recoveryMode && ((arb.roleTotals && arb.roleTotals.Repair) || 0) < 1;
  var hasUrgentException = builderException || repairException;

  if (arb.suppressedBands && arb.suppressedBands[band]) {
    if (builderException) return { allowed: true, reason: 'EXCEPTION_CRITICAL_BUILD' };
    if (repairException) return { allowed: true, reason: 'EXCEPTION_CRITICAL_REPAIR' };
    return { allowed: false, reason: 'BAND_SUPPRESSED_' + band };
  }
  if (arb.unmetSurvivalFloors && arb.unmetSurvivalFloors.length > 0 && !deps.FLOOR_ROLE_SET[role]) {
    if (hasUrgentException) return builderException ? { allowed: true, reason: 'EXCEPTION_CRITICAL_BUILD' } : { allowed: true, reason: 'EXCEPTION_CRITICAL_REPAIR' };
    return { allowed: false, reason: 'WAITING_ON_SURVIVAL' };
  }
  if (arb.unmetEconomyFloors && arb.unmetEconomyFloors.length > 0) {
    if (role !== 'Upgrader' && !deps.FLOOR_ROLE_SET[role]) return { allowed: false, reason: 'WAITING_ON_ECONOMY' };
  }

  // Recovery mode protects survival/economy creeps when the room is weak.
  if (arb.recoveryMode && (band === 'SITUATIONAL' || band === 'SUPPORT' || band === 'GROWTH')) {
    if ((role === 'Builder' || role === 'Scout') && (!arb.unmetSurvivalFloors || !arb.unmetSurvivalFloors.length)) {
      var age = Math.max(0, Game.time - (item.created || Game.time));
      var threshold = role === 'Builder' ? deps.BUILDER_STARVATION_TICKS : deps.SCOUT_STARVATION_TICKS;
      var total = (arb.roleTotals && typeof arb.roleTotals[role] === 'number') ? arb.roleTotals[role] : 0;
      if (total <= 0 && age >= threshold && (arb.energyAvailable || 0) >= deps.minEnergyFor(role)) return { allowed: true, reason: 'EXCEPTION_SUPPORT_ANTI_STARVATION' };
    }
    if (hasUrgentException) return builderException ? { allowed: true, reason: 'EXCEPTION_CRITICAL_BUILD' } : { allowed: true, reason: 'EXCEPTION_CRITICAL_REPAIR' };
    return { allowed: false, reason: 'RECOVERY_SUPPRESS_' + band };
  }
  if (budgetBlocksRole(arb, role, band, hasUrgentException, deps)) return { allowed: false, reason: 'BUDGET_BLOCK_' + band };
  return { allowed: true, reason: 'ALLOWED' };
}

module.exports = { budgetBlocksRole: budgetBlocksRole, suppressedBandsForState: suppressedBandsForState, queueItemAllowed: queueItemAllowed, canSpawnQueuedRoleSimple: canSpawnQueuedRoleSimple, recordBlockedRoleReason: recordBlockedRoleReason, isEmergencyDefenseNeeded: isEmergencyDefenseNeeded };
