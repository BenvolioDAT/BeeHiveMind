'use strict';

// Owns: quota/backlog helper calculations used by spawn planning.
// Does not own: queue mutation or spawn execution.
// Called by: BeeSpawnManager.

function buildBacklogBucket(totalSites, criticalSites) {
  if (criticalSites > 0 || totalSites >= 12) return 'CRITICAL';
  if (totalSites >= 7) return 'HIGH';
  if (totalSites >= 3) return 'MEDIUM';
  if (totalSites > 0) return 'LOW';
  return 'NONE';
}

function repairBacklogBucket(totalRepairs, criticalRepairs) {
  if (criticalRepairs > 0 || totalRepairs >= 30) return 'CRITICAL';
  if (totalRepairs >= 15) return 'HIGH';
  if (totalRepairs >= 6) return 'MEDIUM';
  if (totalRepairs > 0) return 'LOW';
  return 'NONE';
}

function countCriticalBuildBacklog(room) {
  if (!room || typeof room.find !== 'function') return 0;
  var sites = room.find(FIND_CONSTRUCTION_SITES) || [];
  var count = 0;
  for (var i = 0; i < sites.length; i++) {
    var site = sites[i];
    if (!site || !site.progressTotal || site.progressTotal <= 0) continue;
    var ratio = (site.progress || 0) / site.progressTotal;
    if (ratio < 0.25) count += 1;
  }
  return count;
}

function countCriticalRepairBacklog(room) {
  if (!room || typeof room.find !== 'function') return 0;
  var list = room.find(FIND_STRUCTURES) || [];
  var count = 0;
  for (var i = 0; i < list.length; i++) {
    var structure = list[i];
    if (!structure || !structure.hitsMax || structure.hitsMax <= 0) continue;
    var hp = structure.hits || 0;
    if (hp < 2000) { count += 1; continue; }
    if ((hp / structure.hitsMax) < 0.15) count += 1;
  }
  return count;
}

function computeUrgentBacklogSignals(room, plannerSignals, deps) {
  var build = plannerSignals && plannerSignals.criticalBuildBacklog > 0;
  var repair = plannerSignals && plannerSignals.criticalRepairBacklog > 0;
  if (room) {
    if (!build && deps.countCriticalBuildBacklog(room) > 0) build = true;
    if (!repair && deps.countCriticalRepairBacklog(room) > 0) repair = true;
  }
  return { builder: build, repair: repair };
}

module.exports = {
  buildBacklogBucket: buildBacklogBucket,
  repairBacklogBucket: repairBacklogBucket,
  countCriticalBuildBacklog: countCriticalBuildBacklog,
  countCriticalRepairBacklog: countCriticalRepairBacklog,
  computeUrgentBacklogSignals: computeUrgentBacklogSignals
};
