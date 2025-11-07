'use strict';

/**
 * Planner.SpawnPlacement
 * ----------------------
 * Purpose: Choose a safe tile near a freshly-claimed controller for the very first spawn.
 * Method: Scan a manhattan-diamond ring around the controller (distance 3-5) and place a
 *         spawn construction site on the first open, non-wall tile that is not occupied.
 */

// Config: limit the search ring so builders do not wander too far from the controller.
var CFG = {
  MIN_RANGE: 3,
  MAX_RANGE: 5
};

function hasExistingSpawnOrSite(room) {
  // Guard: never duplicate work if the room already has a spawn or a pending site.
  var built = room.find(FIND_MY_STRUCTURES, {
    filter: function (s) { return s.structureType === STRUCTURE_SPAWN; }
  });
  if (built && built.length > 0) return true;
  var sites = room.find(FIND_MY_CONSTRUCTION_SITES, {
    filter: function (s) { return s.structureType === STRUCTURE_SPAWN; }
  });
  if (sites && sites.length > 0) return true;
  return false;
}

function isTileAvailable(room, x, y) {
  if (x <= 0 || x >= 49 || y <= 0 || y >= 49) return false;
  var terrain = room.getTerrain();
  if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;

  // Look at everything on the tile once so we can reject blockers quickly.
  var look = room.lookAt(x, y);
  for (var i = 0; i < look.length; i++) {
    var item = look[i];
    if (item.type === LOOK_TERRAIN && item.terrain === 'wall') return false;
    if (item.type === LOOK_STRUCTURES) {
      var type = item.structure.structureType;
      if (type !== STRUCTURE_ROAD && type !== STRUCTURE_RAMPART) return false;
    }
    if (item.type === LOOK_CONSTRUCTION_SITES) return false;
    if (item.type === LOOK_SOURCES) return false;
    if (item.type === LOOK_MINERALS) return false;
    if (item.type === LOOK_CREEPS) return false;
  }

  return true;
}

function placeInitialSpawnSite(room) {
  if (!room || !room.controller) return false;
  if (!room.controller.my) return false;
  if (hasExistingSpawnOrSite(room)) return false;

  var ctrlPos = room.controller.pos;
  // Try each diamond ring moving outward so we pick the closest legal tile first.
  for (var range = CFG.MIN_RANGE; range <= CFG.MAX_RANGE; range++) {
    for (var dx = -range; dx <= range; dx++) {
      for (var dy = -range; dy <= range; dy++) {
        if (Math.abs(dx) + Math.abs(dy) !== range) continue;
        var x = ctrlPos.x + dx;
        var y = ctrlPos.y + dy;
        if (x === ctrlPos.x && y === ctrlPos.y) continue;
        if (!isTileAvailable(room, x, y)) continue;
        var result = room.createConstructionSite(x, y, STRUCTURE_SPAWN);
        if (result === OK) return true;
        if (result === ERR_INVALID_TARGET || result === ERR_FULL || result === ERR_RCL_NOT_ENOUGH) {
          continue;
        }
      }
    }
  }
  return false;
}

module.exports = {
  placeInitialSpawnSite: placeInitialSpawnSite
};
