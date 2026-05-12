'use strict';

// BaseHarvest behavior implementation only. Public role wiring stays in role.BaseHarvest.js.
var CFG = require('role.BaseHarvest.Config');

function debugSay(creep, msg) {
  if (CFG.DEBUG_SAY && creep && msg) creep.say(msg, true);
}

function getTargetPosition(target) {
  if (!target) return null;
  if (target.pos) return target.pos;
  if (target.x != null && target.y != null && target.roomName) return target;
  return null;
}

function debugDrawLine(creep, target, color, label) {
  if (!CFG.DEBUG_DRAW || !creep || !target) return;
  var room = creep.room; if (!room || !room.visual) return;
  var tpos = getTargetPosition(target); if (!tpos || tpos.roomName !== room.name) return;
  try {
    room.visual.line(creep.pos, tpos, {
      color: color, width: CFG.DRAW.WIDTH, opacity: CFG.DRAW.OPACITY, lineStyle: "solid"
    });
    if (label) {
      room.visual.text(label, tpos.x, tpos.y - 0.3, {
        color: color, opacity: CFG.DRAW.OPACITY, font: CFG.DRAW.FONT, align: "center"
      });
    }
  } catch (e) {}
}

function debugRing(room, pos, color, text) {
  if (!CFG.DEBUG_DRAW || !room || !room.visual || !pos) return;
  try {
    room.visual.circle(pos, { radius: 0.5, fill: "transparent", stroke: color, opacity: CFG.DRAW.OPACITY, width: CFG.DRAW.WIDTH });
    if (text) room.visual.text(text, pos.x, pos.y - 0.6, { color: color, font: CFG.DRAW.FONT, opacity: CFG.DRAW.OPACITY, align: "center" });
  } catch (e) {}
}

function isWalkable(pos) { if (!pos || !pos.roomName) return false; if (pos.x <= 0 || pos.x >= 49 || pos.y <= 0 || pos.y >= 49) return false; var t = new Room.Terrain(pos.roomName); return t.get(pos.x, pos.y) !== TERRAIN_MASK_WALL; }
function isTileOccupiedByAlly(pos, myName) { var creeps = pos.lookFor(LOOK_CREEPS); for (var i = 0; i < creeps.length; i++) { var c = creeps[i]; if (c.my && c.name !== myName) return true; } return false; }
function isTileOccupiedByAnyCreep(pos, myName) { var creeps = pos.lookFor(LOOK_CREEPS); for (var i = 0; i < creeps.length; i++) { var c = creeps[i]; if (!c) continue; if (!myName || c.name !== myName) return true; } return false; }

function countWalkableSeatsAround(pos) { var seats = 0; var t = new Room.Terrain(pos.roomName); for (var dx = -1; dx <= 1; dx++) { for (var dy = -1; dy <= 1; dy++) { if (dx === 0 && dy === 0) continue; var x = pos.x + dx, y = pos.y + dy; if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue; if (t.get(x, y) !== TERRAIN_MASK_WALL) seats++; } } return seats; }
function getAdjacentContainerForSource(source) { var arr = source.pos.findInRange(FIND_STRUCTURES, 1, { filter: function (s) { return s.structureType === STRUCTURE_CONTAINER; } }); return (arr && arr.length) ? arr[0] : null; }
function getPreferredSeatPos(source) { var cont = getAdjacentContainerForSource(source); if (cont) return cont.pos; var candidates = []; for (var dx = -1; dx <= 1; dx++) { for (var dy = -1; dy <= 1; dy++) { if (dx === 0 && dy === 0) continue; var p = new RoomPosition(source.pos.x + dx, source.pos.y + dy, source.pos.roomName); if (isWalkable(p)) candidates.push(p); } } if (!candidates.length) return null; candidates.sort(function(a, b) { return (a.y - b.y) || (a.x - b.x); }); return candidates[0]; }
function matchesRole(creep, roleName, legacyTask) { if (!creep || !creep.memory) return false; var role = creep.memory.role; if (role && roleName && String(role).toLowerCase() === String(roleName).toLowerCase()) return true; var task = creep.memory.task; var legacy = legacyTask || roleName; if (task && legacy && String(task).toLowerCase() === String(legacy).toLowerCase()) return true; if (task && roleName && String(task).toLowerCase() === String(roleName).toLowerCase()) return true; return false; }
function getIncumbents(roomName, sourceId, excludeName) { var out = []; for (var name in Game.creeps) { var c = Game.creeps[name]; if (!c || !c.my) continue; if (excludeName && name === excludeName) continue; if (c.memory && matchesRole(c, 'BaseHarvest', 'baseharvest') && c.memory.assignedSource === sourceId && c.room && c.room.name === roomName) out.push(c); } return out; }
function countAssignedHarvesters(roomName, sourceId) { return getIncumbents(roomName, sourceId, null).length; }

function resolveSourceConflict(creep, source) {
  var neighbors = source.pos.findInRange(FIND_MY_CREEPS, 1, { filter: function(c) { return c.name !== creep.name && matchesRole(c, 'BaseHarvest', 'baseharvest') && c.memory.assignedSource === source.id; } });
  if (neighbors.length === 0) return false;
  if (countAssignedHarvesters(creep.room.name, source.id) <= 1) return false;
  var all = neighbors.concat([creep]); var winner = all[0]; for (var i = 1; i < all.length; i++) { if (all[i].name < winner.name) winner = all[i]; }
  if (winner.name !== creep.name) {
    creep.memory._avoidSourceId = source.id;
    creep.memory._avoidUntil = Game.time + CFG.AVOID_TICKS_AFTER_YIELD;
    creep.memory.assignedSource = null;
    creep.memory._reassignCooldown = Game.time + 5;
    creep.memory.waitingForSeat = false;
    debugSay(creep, 'yield 🐝'); debugRing(creep.room, source.pos, CFG.DRAW.YIELD, "YIELD"); return true;
  }
  return false;
}

function shouldQueueForSource(creep, source, seats, used) { if (used < seats) return false; var inc = getIncumbents(creep.room.name, source.id, creep.name); for (var i = 0; i < inc.length; i++) { var t = inc[i].ticksToLive; if (typeof t === 'number' && t <= CFG.HANDOFF_TTL) return true; } return false; }
function findQueueSpotNearSeat(seatPos, myName) { var best = null, bestScore = -Infinity; for (var dx = -1; dx <= 1; dx++) { for (var dy = -1; dy <= 1; dy++) { if (dx === 0 && dy === 0) continue; var p = new RoomPosition(seatPos.x + dx, seatPos.y + dy, seatPos.roomName); if (!isWalkable(p)) continue; var occupied = isTileOccupiedByAlly(p, myName); var score = occupied ? -10 : 0; score += (-p.y * 0.01) + (-p.x * 0.001); if (score > bestScore) { bestScore = score; best = p; } } } return best; }

function assignSource(creep) {
  if (creep.spawning) return;
  if (creep.memory._reassignCooldown && Game.time < creep.memory._reassignCooldown) return creep.memory.assignedSource || null;
  if (creep.memory.assignedSource) return creep.memory.assignedSource;
  var sources = creep.room.find(FIND_SOURCES); if (!sources || !sources.length) return null;
  var best = null; var bestScore = -Infinity; var bestWillQueue = false;
  for (var i = 0; i < sources.length; i++) {
    var s = sources[i];
    if (creep.memory._avoidSourceId === s.id && creep.memory._avoidUntil && Game.time < creep.memory._avoidUntil) continue;
    var seatPos = getPreferredSeatPos(s); if (!seatPos) continue;
    var seats = getAdjacentContainerForSource(s) ? 1 : countWalkableSeatsAround(s.pos);
    if (CFG.MAX_HARVESTERS_PER_SOURCE > 0) seats = Math.min(seats, CFG.MAX_HARVESTERS_PER_SOURCE);
    var used = countAssignedHarvesters(creep.room.name, s.id); var free = seats - used; var willQueue = false;
    if (free <= 0) { if (!shouldQueueForSource(creep, s, seats, used)) continue; willQueue = true; }
    var range = creep.pos.getRangeTo(seatPos); var score = (free > 0 ? 1000 : 0) - range;
    if (score > bestScore) { bestScore = score; best = { source: s, seatPos: seatPos }; bestWillQueue = willQueue; }
  }
  if (!best) return null;
  creep.memory.assignedSource = best.source.id; creep.memory.seatX = best.seatPos.x; creep.memory.seatY = best.seatPos.y; creep.memory.seatRoom = best.seatPos.roomName; creep.memory.waitingForSeat = !!bestWillQueue;
  debugSay(creep, bestWillQueue ? '⏳' : '🎯'); debugRing(creep.room, best.source.pos, CFG.DRAW.SOURCE, "SRC"); debugRing(creep.room, best.seatPos, CFG.DRAW.SEAT, "SEAT");
  return best.source.id;
}

function getContainerAtOrAdjacent(pos) { var here = pos.lookFor(LOOK_STRUCTURES); for (var i = 0; i < here.length; i++) { if (here[i].structureType === STRUCTURE_CONTAINER) return here[i]; } var around = pos.findInRange(FIND_STRUCTURES, 1, { filter: function(s) { return s.structureType === STRUCTURE_CONTAINER; } }); return (around && around.length) ? around[0] : null; }
function countCreepsWithRole(roleName, legacyTask) { var n = 0; for (var name in Game.creeps) { var c = Game.creeps[name]; if (c && matchesRole(c, roleName, legacyTask)) n++; } return n; }

function ensureBaseHarvestIdentity(creep) { if (!creep || !creep.memory) return; if (!creep.memory.role || String(creep.memory.role).toLowerCase() === 'baseharvest') creep.memory.role = 'BaseHarvest'; if (!creep.memory.task) creep.memory.task = 'baseharvest'; }
function determineBaseHarvestState(creep) { ensureBaseHarvestIdentity(creep); if (!creep) return 'IDLE'; var empty = creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0; var full = creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0; if (empty) { creep.memory.harvesting = true; debugSay(creep, '⤵️MINE'); } else if (full) { creep.memory.harvesting = false; debugSay(creep, '⤴️DROP'); } var nextState = 'IDLE'; if (creep.memory.harvesting) nextState = 'HARVEST'; else if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) nextState = 'OFFLOAD'; creep.memory.state = nextState; return nextState; }

function runHarvestPhase(creep) {
  var sid = assignSource(creep); if (!sid) { debugSay(creep, '❓'); return; }
  var source = Game.getObjectById(sid); if (!source) { creep.memory.assignedSource = null; creep.memory.waitingForSeat = false; return; }
  if (resolveSourceConflict(creep, source)) return;
  var seatPos = (creep.memory.seatRoom === creep.room.name) ? new RoomPosition(creep.memory.seatX, creep.memory.seatY, creep.memory.seatRoom) : getPreferredSeatPos(source);
  if (seatPos) debugRing(creep.room, seatPos, CFG.DRAW.SEAT, "SEAT");
  var seats = getAdjacentContainerForSource(source) ? 1 : countWalkableSeatsAround(source.pos);
  if (CFG.MAX_HARVESTERS_PER_SOURCE > 0) seats = Math.min(seats, CFG.MAX_HARVESTERS_PER_SOURCE);
  var used = countAssignedHarvesters(creep.room.name, source.id);
  if (used < seats) creep.memory.waitingForSeat = false;
  var seatBlocked = seatPos ? (isTileOccupiedByAnyCreep(seatPos, creep.name) && !creep.pos.isEqualTo(seatPos)) : false;
  var shouldQ = (seatBlocked || creep.memory.waitingForSeat) && used >= seats && shouldQueueForSource(creep, source, seats, used);
  if (shouldQ) {
    var queueSpot = findQueueSpotNearSeat(seatPos, creep.name) || seatPos;
    creep.memory.waitingForSeat = true;
    debugSay(creep, '⏳'); debugRing(creep.room, queueSpot, CFG.DRAW.QUEUE, "QUEUE");
    if (!creep.pos.isEqualTo(queueSpot)) { creep.travelTo(queueSpot, { range: 0, reusePath: CFG.TRAVEL_REUSE }); return; }
    if (creep.pos.getRangeTo(source) <= 1) { debugDrawLine(creep, source, CFG.DRAW.SOURCE, "HARV"); creep.harvest(source); }
    if (!isTileOccupiedByAnyCreep(seatPos, creep.name) || countAssignedHarvesters(creep.room.name, source.id) < seats) { creep.travelTo(seatPos, { range: 0, reusePath: CFG.TRAVEL_REUSE }); creep.memory.waitingForSeat = false; }
    return;
  }
  if (seatPos && !creep.pos.isEqualTo(seatPos)) { debugSay(creep, '🪑'); creep.travelTo(seatPos, { range: 0, reusePath: CFG.TRAVEL_REUSE }); return; }
  creep.memory.waitingForSeat = false;
  var courierCount = countCreepsWithRole('Courier', 'courier'); var queenCount = countCreepsWithRole('Queen', 'queen'); var haveCollectors = (courierCount > 0 || queenCount > 0);
  var contHere = getContainerAtOrAdjacent(creep.pos);
  if (haveCollectors && contHere && creep.pos.isEqualTo(contHere.pos)) {
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) { var tr = creep.transfer(contHere, RESOURCE_ENERGY); if (tr === ERR_FULL) { debugSay(creep, '⬇️'); creep.drop(RESOURCE_ENERGY); } else if (tr === ERR_NOT_IN_RANGE) { creep.travelTo(contHere.pos, { range: 0, reusePath: CFG.TRAVEL_REUSE }); return; } }
  }
  debugSay(creep, '⛏️'); debugDrawLine(creep, source, CFG.DRAW.SOURCE, "HARV"); creep.harvest(source);
}

function runOffloadPhase(creep) {
  var courierCount2 = countCreepsWithRole('Courier', 'courier'); var queenCount2 = countCreepsWithRole('Queen', 'queen'); var haveCollectors2 = (courierCount2 > 0 || queenCount2 > 0);
  if (!haveCollectors2) {
    var spawn = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, { filter: function(s) { return s.structureType === STRUCTURE_SPAWN && s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0; } });
    if (spawn) { debugSay(creep, '🏠'); debugDrawLine(creep, spawn, CFG.DRAW.OFFLOAD, "RETURN"); var toSpawn = creep.transfer(spawn, RESOURCE_ENERGY); if (toSpawn === ERR_NOT_IN_RANGE) { creep.travelTo(spawn, { range: 1, reusePath: CFG.TRAVEL_REUSE }); return; } if (toSpawn === OK) return; }
    var ext = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, { filter: function(s) { return s.structureType === STRUCTURE_EXTENSION && s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0; } });
    if (ext) { debugSay(creep, '🏠'); debugDrawLine(creep, ext, CFG.DRAW.OFFLOAD, "RETURN"); var toExt = creep.transfer(ext, RESOURCE_ENERGY); if (toExt === ERR_NOT_IN_RANGE) { creep.travelTo(ext, { range: 1, reusePath: CFG.TRAVEL_REUSE }); return; } if (toExt === OK) return; }
    if (creep.room.storage && creep.room.storage.store && creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) { debugSay(creep, '🏠'); debugDrawLine(creep, creep.room.storage, CFG.DRAW.OFFLOAD, "RETURN"); var toStorage = creep.transfer(creep.room.storage, RESOURCE_ENERGY); if (toStorage === ERR_NOT_IN_RANGE) { creep.travelTo(creep.room.storage, { range: 1, reusePath: CFG.TRAVEL_REUSE }); return; } if (toStorage === OK) return; }
    var cont = creep.pos.findClosestByPath(FIND_STRUCTURES, { filter: function(s) { return s.structureType === STRUCTURE_CONTAINER && s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0; } });
    if (cont) { debugSay(creep, '🏠'); debugDrawLine(creep, cont, CFG.DRAW.OFFLOAD, "RETURN"); var toCont = creep.transfer(cont, RESOURCE_ENERGY); if (toCont === ERR_NOT_IN_RANGE) { creep.travelTo(cont, { range: 1, reusePath: CFG.TRAVEL_REUSE }); return; } if (toCont === OK) return; }
    debugSay(creep, '⬇️'); creep.drop(RESOURCE_ENERGY); return;
  }
  var cont2 = getContainerAtOrAdjacent(creep.pos);
  if (cont2) {
    if (!creep.pos.isEqualTo(cont2.pos)) { debugSay(creep, '📦→'); debugDrawLine(creep, cont2, CFG.DRAW.OFFLOAD, "SEAT"); creep.travelTo(cont2.pos, { range: 0, reusePath: CFG.TRAVEL_REUSE }); return; }
    debugSay(creep, '📦'); var tr2 = creep.transfer(cont2, RESOURCE_ENERGY); if (tr2 === OK) return; if (tr2 === ERR_NOT_IN_RANGE) { creep.travelTo(cont2.pos, { range: 0, reusePath: CFG.TRAVEL_REUSE }); return; }
    debugSay(creep, '⬇️'); creep.drop(RESOURCE_ENERGY); return;
  }
  debugSay(creep, '⬇️'); debugRing(creep.room, creep.pos, CFG.DRAW.OFFLOAD, "DROP"); creep.drop(RESOURCE_ENERGY);
}

function idleWhenEmpty(creep) { if (!creep || creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) return; debugSay(creep, '🧘'); debugRing(creep.room, creep.pos, CFG.DRAW.IDLE, "IDLE"); }
function run(creep) { var state = determineBaseHarvestState(creep); if (state === 'HARVEST') { runHarvestPhase(creep); return; } if (state === 'OFFLOAD') { runOffloadPhase(creep); return; } idleWhenEmpty(creep); }

module.exports = { run: run };
