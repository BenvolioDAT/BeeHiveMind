'use strict';
// Spawn.Counts.js
// Owns: live/spawning/planned role counting helpers.
// Must not own: queue mutation or quota/arbitration policy.
// Called by: BeeSpawnManager.

function getScoutHomeFromMemory(memory) {
  if (!memory) return null;
  if (memory.home) return memory.home;
  if (memory._home) return memory._home;
  if (memory.scout && memory.scout.home) return memory.scout.home;
  return null;
}

function countRoleInRoom(C, roomName, roleName, canonicalRole, dyingSoonTtl) {
  if (!C || !C.creeps || !roomName || !roleName) return 0;
  var target = canonicalRole(roleName);
  if (!target) return 0;
  var count = 0;
  for (var i = 0; i < C.creeps.length; i++) {
    var creep = C.creeps[i];
    if (!creep || !creep.my || !creep.room || creep.room.name !== roomName) continue;
    var ttl = creep.ticksToLive;
    if (typeof ttl === 'number' && ttl <= dyingSoonTtl) continue;
    var role = creep.memory && (creep.memory.role || creep.memory.task);
    if (canonicalRole(role) === target) count += 1;
  }
  return count;
}

function countScoutByHome(C, roomName, canonicalRole, dyingSoonTtl) {
  if (!C || !C.creeps || !roomName) return 0;
  var count = 0;
  for (var i = 0; i < C.creeps.length; i++) {
    var creep = C.creeps[i];
    if (!creep || !creep.my) continue;
    var ttl = creep.ticksToLive;
    if (typeof ttl === 'number' && ttl <= dyingSoonTtl) continue;
    var role = creep.memory && (creep.memory.role || creep.memory.task);
    if (canonicalRole(role) !== 'Scout') continue;
    var home = getScoutHomeFromMemory(creep.memory);
    if (!home && creep.room && creep.room.name) home = creep.room.name;
    if (home === roomName) count += 1;
  }
  return count;
}

module.exports = { countRoleInRoom: countRoleInRoom, countScoutByHome: countScoutByHome };
