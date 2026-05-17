'use strict';

var CoreConfig = require('core.config');
var MovementManager = require('Movement.Manager');

function getCombatConfig() {
  var settings = (CoreConfig && CoreConfig.settings) || {};
  return settings.combat || {};
}

function getRoomCombatMemory(roomName) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  if (!Memory.rooms[roomName].combat) Memory.rooms[roomName].combat = {};
  return Memory.rooms[roomName].combat;
}

function getHomeRoomName(creep) {
  if (!creep || !creep.memory) return creep && creep.room ? creep.room.name : null;
  return creep.memory.home || creep.memory.spawnRoom || (creep.room && creep.room.name) || null;
}

function getPrimarySpawn(room) {
  if (!room) return null;
  var spawns = room.find(FIND_MY_SPAWNS);
  if (!spawns || !spawns.length) return null;
  return spawns[0];
}

function isNearExit(x, y) { return x <= 1 || x >= 48 || y <= 1 || y >= 48; }

function hasRoadAt(room, x, y) {
  var structures = room.lookForAt(LOOK_STRUCTURES, x, y);
  for (var i = 0; i < structures.length; i++) {
    if (structures[i].structureType === STRUCTURE_ROAD) return true;
  }
  return false;
}

function hasBlockingStructureOrSite(room, x, y) {
  var structures = room.lookForAt(LOOK_STRUCTURES, x, y);
  for (var i = 0; i < structures.length; i++) {
    var s = structures[i];
    if (s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_RAMPART) return true;
  }
  var sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
  return sites && sites.length > 0;
}

function isWalkable(room, x, y) {
  if (x < 1 || x > 48 || y < 1 || y > 48) return false;
  var terrain = room.getTerrain();
  if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;
  if (hasBlockingStructureOrSite(room, x, y)) return false;
  return true;
}

function getStagingAnchor(room) {
  if (!room) return null;
  var cfg = getCombatConfig();
  var replanTicks = cfg.STAGING_REPLAN_TICKS || 1500;
  var mem = getRoomCombatMemory(room.name);
  var existing = mem.stagingAnchor;
  var failedReplanTicks = cfg.STAGING_FAILED_REPLAN_TICKS || 250;
  if (existing && existing.x != null && existing.y != null && existing.roomName === room.name && (Game.time - (existing.t || 0)) <= replanTicks) {
    if (isWalkable(room, existing.x, existing.y)) return new RoomPosition(existing.x, existing.y, room.name);
  }

  if (!existing && mem.nextStagingAnchorPlanTick && Game.time < mem.nextStagingAnchorPlanTick) return null;

  var spawn = getPrimarySpawn(room);
  if (!spawn) return null;

  var minRange = cfg.STAGING_MIN_RANGE_FROM_SPAWN || 5;
  var maxRange = cfg.STAGING_MAX_RANGE_FROM_SPAWN || 9;
  var structures = room.find(FIND_MY_STRUCTURES);
  var sources = room.find(FIND_SOURCES);
  var controller = room.controller;
  var best = null;

  for (var x = Math.max(1, spawn.pos.x - maxRange); x <= Math.min(48, spawn.pos.x + maxRange); x++) {
    for (var y = Math.max(1, spawn.pos.y - maxRange); y <= Math.min(48, spawn.pos.y + maxRange); y++) {
      var pos = new RoomPosition(x, y, room.name);
      var range = pos.getRangeTo(spawn);
      if (range < minRange || range > maxRange) continue;
      if (!isWalkable(room, x, y)) continue;
      if (range <= 1) continue;

      var score = 0;
      var distPenalty = Math.abs(7 - range) * 3;
      score -= distPenalty;
      if (isNearExit(x, y)) score -= 10;
      if (hasRoadAt(room, x, y)) score -= 6;

      for (var i = 0; i < structures.length; i++) {
        var s = structures[i];
        var r = pos.getRangeTo(s);
        if (s.structureType === STRUCTURE_EXTENSION) score -= Math.max(0, 7 - r) * 3;
        if (s.structureType === STRUCTURE_SPAWN) score -= Math.max(0, 7 - r) * 4;
        if (s.structureType === STRUCTURE_TOWER) score -= Math.max(0, 6 - r) * 2;
        if (s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_TERMINAL) score -= Math.max(0, 6 - r) * 2;
        if (s.structureType === STRUCTURE_ROAD) score -= Math.max(0, 2 - r) * 2;
      }

      for (var si = 0; si < sources.length; si++) score -= Math.max(0, 5 - pos.getRangeTo(sources[si])) * 2;
      if (controller) score -= Math.max(0, 5 - pos.getRangeTo(controller)) * 2;

      var openTiles = 0;
      for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          var nx = x + dx;
          var ny = y + dy;
          if (nx < 1 || nx > 48 || ny < 1 || ny > 48) continue;
          if (room.getTerrain().get(nx, ny) !== TERRAIN_MASK_WALL) openTiles++;
        }
      }
      score += openTiles;

      var path = PathFinder.search(spawn.pos, { pos: pos, range: 0 }, { maxRooms: 1, maxOps: 1000 });
      if (path.incomplete) continue;
      score += 8;

      if (!best || score > best.score) best = { x: x, y: y, score: score };
    }
  }

  if (!best) {
    mem.nextStagingAnchorPlanTick = Game.time + failedReplanTicks;
    return null;
  }
  mem.stagingAnchor = { x: best.x, y: best.y, roomName: room.name, t: Game.time };
  delete mem.nextStagingAnchorPlanTick;
  return new RoomPosition(best.x, best.y, room.name);
}

function getStagingSlots(room) {
  if (!room) return [];
  var cfg = getCombatConfig();
  var radius = cfg.STAGING_SLOT_RADIUS || 3;
  var mem = getRoomCombatMemory(room.name);
  var anchor = getStagingAnchor(room);
  if (!anchor) return [];

  var slotsCache = mem.stagingSlots;
  var cacheKey = anchor.x + ':' + anchor.y + ':' + radius;
  if (slotsCache && slotsCache.anchorKey === cacheKey && (Game.time - (slotsCache.t || 0)) <= (cfg.STAGING_REPLAN_TICKS || 1500) && slotsCache.slots && slotsCache.slots.length) {
    var valid = true;
    for (var ci = 0; ci < slotsCache.slots.length; ci++) {
      var cs = slotsCache.slots[ci];
      if (!isWalkable(room, cs.x, cs.y) || hasRoadAt(room, cs.x, cs.y) || isNearExit(cs.x, cs.y)) { valid = false; break; }
    }
    if (valid) return slotsCache.slots;
  }

  var slots = [];
  var sources = room.find(FIND_SOURCES);
  var controller = room.controller;
  for (var x = Math.max(1, anchor.x - radius); x <= Math.min(48, anchor.x + radius); x++) {
    for (var y = Math.max(1, anchor.y - radius); y <= Math.min(48, anchor.y + radius); y++) {
      var pos = new RoomPosition(x, y, room.name);
      var d = pos.getRangeTo(anchor);
      if (d < 1 || d > radius) continue;
      if (!isWalkable(room, x, y) || isNearExit(x, y) || hasRoadAt(room, x, y)) continue;

      var skip = false;
      for (var si = 0; si < sources.length; si++) { if (pos.getRangeTo(sources[si]) <= 1) { skip = true; break; } }
      if (skip) continue;
      if (controller && pos.getRangeTo(controller) <= 2) continue;
      slots.push({ x: x, y: y, roomName: room.name });
    }
  }

  mem.stagingSlots = { t: Game.time, anchorKey: cacheKey, slots: slots };
  return slots;
}

function assignStagingSlot(creep) {
  if (!creep || !creep.room) return null;
  var homeRoomName = getHomeRoomName(creep);
  if (!homeRoomName) return null;
  var room = Game.rooms[homeRoomName] || creep.room;
  var mem = getRoomCombatMemory(homeRoomName);
  if (!mem.stagingAssignments) mem.stagingAssignments = {};

  var assignments = mem.stagingAssignments;
  Object.keys(assignments).forEach(function (name) {
    if (!Game.creeps[name]) delete assignments[name];
  });

  var current = assignments[creep.name];
  if (current && current.x != null && current.y != null) return new RoomPosition(current.x, current.y, current.roomName || homeRoomName);

  var slots = getStagingSlots(room);
  if (!slots.length) return null;

  var used = {};
  Object.keys(assignments).forEach(function (name) {
    var a = assignments[name];
    if (a && a.x != null && a.y != null && Game.creeps[name]) used[a.roomName + ':' + a.x + ':' + a.y] = true;
  });

  var best = null;
  var bestRange = Infinity;
  for (var i = 0; i < slots.length; i++) {
    var slot = slots[i];
    var key = slot.roomName + ':' + slot.x + ':' + slot.y;
    if (used[key]) continue;
    var range = creep.pos.getRangeTo(slot.x, slot.y);
    if (range < bestRange) { best = slot; bestRange = range; }
  }

  if (!best) return null;
  assignments[creep.name] = { x: best.x, y: best.y, roomName: best.roomName, t: Game.time };
  return new RoomPosition(best.x, best.y, best.roomName);
}

function drawStagingVisuals(room) {
  var cfg = getCombatConfig();
  if (!cfg.DEBUG_STAGING_VISUALS || !room || !room.visual) return;
  var anchor = getStagingAnchor(room);
  if (!anchor) return;
  var slots = getStagingSlots(room);
  room.visual.circle(anchor, { radius: 0.45, stroke: '#ffcc00', fill: 'transparent', opacity: 0.8 });
  room.visual.text('S', anchor.x, anchor.y - 0.6, { color: '#ffcc00', font: 0.5 });
  for (var i = 0; i < slots.length; i++) room.visual.circle(slots[i].x, slots[i].y, { radius: 0.2, fill: '#ffaa00', opacity: 0.35, stroke: 'transparent' });
}

function moveToStaging(creep) {
  var cfg = getCombatConfig();
  if (!cfg.IDLE_STAGING_ENABLED || !creep || !creep.room) return ERR_INVALID_ARGS;
  var homeRoomName = getHomeRoomName(creep);
  if (!homeRoomName) return ERR_INVALID_TARGET;

  var room = Game.rooms[homeRoomName] || creep.room;
  drawStagingVisuals(room);

  var slot = assignStagingSlot(creep);
  if (slot) {
    if (creep.pos.roomName === slot.roomName && creep.pos.x === slot.x && creep.pos.y === slot.y) return OK;
    if (typeof MovementManager.request === 'function') {
      return MovementManager.request(creep, slot, MovementManager.PRIORITIES.idle, { range: 0, ignoreCreeps: false, reusePath: 10, intentType: 'idle' });
    }
    return creep.travelTo(slot, { range: 0, ignoreCreeps: false, reusePath: 10 });
  }

  var anchor = getStagingAnchor(room);
  if (!anchor) return ERR_NOT_FOUND;
  if (creep.pos.inRangeTo(anchor, 3)) return OK;
  if (typeof MovementManager.request === 'function') {
    return MovementManager.request(creep, anchor, MovementManager.PRIORITIES.idle, { range: 3, ignoreCreeps: false, reusePath: 10, intentType: 'idle' });
  }
  return creep.travelTo(anchor, { range: 3, ignoreCreeps: false, reusePath: 10 });
}

module.exports = {
  getHomeRoomName: getHomeRoomName,
  getPrimarySpawn: getPrimarySpawn,
  hasRoadAt: hasRoadAt,
  getStagingAnchor: getStagingAnchor,
  getStagingSlots: getStagingSlots,
  assignStagingSlot: assignStagingSlot,
  moveToStaging: moveToStaging,
  drawStagingVisuals: drawStagingVisuals
};
