// role.TaskBaseHarvest.js (refactor, ES5-safe, API-compatible)
// Purpose: Stationary miner that harvests a base room source,
//          sits on a container if present, builds one if not,
//          and offloads energy sanely.
//
// Key improvements:
// - No lodash (pure ES5).
// - Clear harvest/return toggles.
// - Correct courier logic (drop only when *couriers exist* and no container yet).
// - Adjacent container detection is fast and explicit.
// - Assigns sources evenly within the room.

var BeeToolbox = require('BeeToolbox');

var TaskBaseHarvest = {
  run: function (creep) {
    if (creep.spawning) return;

    // ---------- 1) Harvesting state machine ----------
    if (!creep.memory.harvesting && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      creep.memory.harvesting = true;
    }
    if (creep.memory.harvesting && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      creep.memory.harvesting = false;
    }

    // ---------- 2) HARVEST PHASE ----------
    if (creep.memory.harvesting) {
      var sourceId = assignSource(creep);
      if (!sourceId) return; // no sources? nothing to do this tick

      var src = Game.getObjectById(sourceId);
      if (!src) return;

      // Prefer standing ON an adjacent container if it exists
      var cont = getAdjacentContainer(src);
      if (cont) {
        if (!creep.pos.isEqualTo(cont.pos)) {
          // Sit exactly on the container (range 0)
          if (BeeToolbox && BeeToolbox.BeeTravel) BeeToolbox.BeeTravel(creep, cont, { range: 0 });
          else creep.moveTo(cont, { reusePath: 10 });
        } else {
          creep.harvest(src); // mine while sitting on container
        }
        return;
      }

      // No container yet: ensure one gets made, and keep harvesting
      if (BeeToolbox && BeeToolbox.ensureContainerNearSource) {
        BeeToolbox.ensureContainerNearSource(creep, src);
      }
      var rc = creep.harvest(src);
      if (rc === ERR_NOT_IN_RANGE) {
        if (BeeToolbox && BeeToolbox.BeeTravel) BeeToolbox.BeeTravel(creep, src);
        else creep.moveTo(src, { reusePath: 10 });
      }
      return;
    }

    // ---------- 3) OFFLOAD PHASE (not harvesting, carrying some energy) ----------
    // If we are standing next to (or on) a container, prioritize transferring into it.
    var adjContainer = adjacentContainerAt(creep.pos);
    if (adjContainer) {
      var trc = creep.transfer(adjContainer, RESOURCE_ENERGY);
      if (trc === ERR_NOT_IN_RANGE) {
        if (BeeToolbox && BeeToolbox.BeeTravel) BeeToolbox.BeeTravel(creep, adjContainer);
        else creep.moveTo(adjContainer, { reusePath: 10 });
      }
      return;
    }

    // No adjacent container:
    // If couriers exist in this room, drop so they can scoop quickly while container builds.
    if (couriersInRoom(creep.room.name) > 0) {
      creep.drop(RESOURCE_ENERGY);
      return;
    }

    // No couriers: try to shuffle onto a nearby container (range <= 3) if one exists
    var nearCont = creep.pos.findClosestByPath(FIND_STRUCTURES, {
      filter: function (s) { return s.structureType === STRUCTURE_CONTAINER; }
    });
    if (nearCont) {
      if (BeeToolbox && BeeToolbox.BeeTravel) BeeToolbox.BeeTravel(creep, nearCont, { range: 1 });
      else creep.moveTo(nearCont, { reusePath: 10 });
      return;
    }

    // Last resort: hold the energy (don’t wander); container should be created soon by ensureContainerNearSource()
  }
};

module.exports = TaskBaseHarvest;

// ============ Helpers ============

// Returns a container *adjacent* to the position (including same tile), or null.
function adjacentContainerAt(pos) {
  var room = Game.rooms[pos.roomName];
  if (!room) return null;

  // Check current tile first (standing on container)
  var here = room.lookForAt(LOOK_STRUCTURES, pos);
  for (var i = 0; i < here.length; i++) {
    if (here[i].structureType === STRUCTURE_CONTAINER) return here[i];
  }

  // Then check 8 neighbors
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var x = pos.x + dx, y = pos.y + dy;
      if (x < 0 || x > 49 || y < 0 || y > 49) continue;
      var structs = room.lookForAt(LOOK_STRUCTURES, x, y);
      for (var j = 0; j < structs.length; j++) {
        if (structs[j].structureType === STRUCTURE_CONTAINER) return structs[j];
      }
    }
  }
  return null;
}

// Returns a container within range 1 of the source (preferred perch), or null.
function getAdjacentContainer(source) {
  var list = source.pos.findInRange(FIND_STRUCTURES, 1, {
    filter: function (s) { return s.structureType === STRUCTURE_CONTAINER; }
  });
  return list.length ? list[0] : null;
}

// Count active couriers in the same room (task === 'courier').
function couriersInRoom(roomName) {
  var n = 0;
  for (var name in Game.creeps) {
    var c = Game.creeps[name];
    if (c && c.memory && c.memory.task === 'courier' && c.room && c.room.name === roomName) n++;
  }
  return n;
}

// Assign the creep to the least-occupied source in its current room.
// Memoizes `creep.memory.assignedSource`.
function assignSource(creep) {
  if (creep.memory.assignedSource) return creep.memory.assignedSource;

  var sources = creep.room.find(FIND_SOURCES);
  if (!sources.length) return null;

  // Count living baseharvesters per source in this room
  var counts = {};
  for (var i = 0; i < sources.length; i++) counts[sources[i].id] = 0;

  for (var name in Game.creeps) {
    var c = Game.creeps[name];
    if (c && c.memory && c.memory.task === 'baseharvest' && c.room && c.room.name === creep.room.name) {
      var sid = c.memory.assignedSource;
      if (sid && counts.hasOwnProperty(sid)) counts[sid]++;
    }
  }

  // Pick least-occupied source
  var chosen = null, min = Infinity;
  for (var j = 0; j < sources.length; j++) {
    var s = sources[j];
    if (counts[s.id] < min) { min = counts[s.id]; chosen = s; }
  }

  if (chosen) {
    creep.memory.assignedSource = chosen.id;
    return chosen.id;
  }
  return null;
}

module.exports = TaskBaseHarvest;