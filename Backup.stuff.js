/*
 * Module code goes here. Use 'module.exports' to export things:
 * module.exports.thing = 'a thing';
 *
 * You can import it from another modules like this:
 * var mod = require('Backup.stuff');
 * mod.thing == 'a thing'; // true
 */

module.exports = {

};var BeeToolbox = require('BeeToolbox');

var CONFIG = {
  maxHarvestersPerSource: 1, // set to 1 if you always want one miner per source
  avoidTicksAfterYield: 20   // how long to avoid a source we just yielded
};


// === Conflict Helpers ===========================================

// Return true if *another* allied creep is already occupying the exact pos.
function isTileOccupiedByAlly(pos, myName) {
  var creeps = pos.lookFor(LOOK_CREEPS);
  for (var i = 0; i < creeps.length; i++) {
    var c = creeps[i];
    if (c.my && c.name !== myName) return true;
  }
  return false;
}

// Yield rule: If multiple harvesters target the same source and are adjacent,
// pick a deterministic winner (lexicographically smallest creep.name).
// Losers clear assignment and back off so they can reassign.
function resolveSourceConflict(creep, source) {
  // Find allied harvesters hugging the source (range 1) on the same task/id.
  var neighbors = source.pos.findInRange(FIND_MY_CREEPS, 1, {
    filter: function(c) {
      return c.name !== creep.name &&
             c.memory.task === 'baseharvest' &&
             c.memory.assignedSource === source.id;
    }
  });

  if (neighbors.length === 0) return false; // no conflict

  // Winner = smallest name ensures stable, no-flap resolution.
  var all = neighbors.concat([creep]);
  var winner = all[0];
  for (var i = 1; i < all.length; i++) {
    if (all[i].name < winner.name) winner = all[i];
  }

    if (winner.name !== creep.name) {
      creep.memory._avoidSourceId = source.id;
      creep.memory._avoidUntil    = Game.time + CONFIG.avoidTicksAfterYield;
    
      creep.memory.assignedSource = null;
      creep.memory._reassignCooldown = Game.time + 5;
    
      creep.say('yield 🐝');
      return true;
    }// handled (I yielded)
  return false; // I'm winner; proceed
}

// Safer "least loaded" chooser that also prefers sources with a free seat.
// A "seat" = walkable tile around the source (walls excluded).
function countWalkableSeatsAround(pos) {
  var terrain = new Room.Terrain(pos.roomName);
  var seats = 0;
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var x = pos.x + dx, y = pos.y + dy;
      if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
      if (terrain.get(x, y) !== TERRAIN_MASK_WALL) seats++;
    }
  }
  return seats;
}

function countAssignedHarvesters(roomName, sourceId) {
  // Count current “claims” in code, not memory rooms, to avoid stale data.
  var n = 0;
  for (var name in Game.creeps) {
    var c = Game.creeps[name];
    if (c.memory && c.memory.task === 'baseharvest' &&
        c.memory.assignedSource === sourceId &&
        c.room && c.room.name === roomName) {
      n++;
    }
  }
  return n;
}

const TaskBaseHarvest = {
  run: function(creep) { 
        // Handle harvesting logic
        if (!creep.memory.harvesting && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
          creep.memory.harvesting = true;
        }
        if (creep.memory.harvesting && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
          creep.memory.harvesting = false;
        }
        if (creep.memory.harvesting) {
          var assignedSourceId = assignSource(creep);
          if (!assignedSourceId) return;
          var targetSource = Game.getObjectById(assignedSourceId);
          if (!targetSource) {
              // Source object missing (vision glitch, destroyed container logic, etc.)
              creep.memory.assignedSource = null;
              return;
            }
          if (targetSource) {
            // 1) If a container exists AND another ally is already standing on it → yield & reassign
            var container = getAdjacentContainer(targetSource);
            if (container && isTileOccupiedByAlly(container.pos, creep.name) && !creep.pos.isEqualTo(container.pos)) {
              // Someone owns the seat; let conflict resolver handle reassignment if needed
              if (resolveSourceConflict(creep, targetSource)) return; // I yielded
            } else {
              // 2) If multiple harvesters are crowding the source (range 1), resolve
              if (resolveSourceConflict(creep, targetSource)) return; // I yielded
            }
        
            // 3) Proceed with normal seat logic
            if (container) {
              if (!creep.pos.isEqualTo(container.pos)) {
                // If your BeeTravel uses an options object, do: { range: 0 }
                BeeToolbox.BeeTravel(creep, container, 0);
              } else {
                creep.harvest(targetSource);
              }
            } else {
              BeeToolbox.ensureContainerNearSource(creep, targetSource);
              if (creep.harvest(targetSource) === ERR_NOT_IN_RANGE) {
                BeeToolbox.BeeTravel(creep, targetSource);
              }
            }
          }
        } else {
          // Check if the creep is near a container and transfer energy if possible
          if (hasAdjacentContainer(creep.pos) && creep.store.getFreeCapacity() === 0) {
            const adjacentContainer = creep.pos.findClosestByPath(FIND_STRUCTURES, {
              filter: (structure) =>
                structure.structureType === STRUCTURE_CONTAINER &&
                structure.pos.isNearTo(creep.pos),
            });
            if (adjacentContainer && creep.transfer(adjacentContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
              BeeToolbox.BeeTravel(creep, adjacentContainer);
              return;
            }
          }
          // Drop energy if no Couriers are available
          const Courier = _.filter(Game.creeps, (creep) => creep.memory.task === 'courier');
          if (Courier.length > 0) {
            creep.drop(RESOURCE_ENERGY);
            return;
          }
        }
      }
    };
// Utility function to check if there's a container adjacent to the given position
const hasAdjacentContainer = function (pos) {
  const room = Game.rooms[pos.roomName];
  // Iterate over adjacent positions
  for (let xOffset = -1; xOffset <= 1; xOffset++) {
    for (let yOffset = -1; yOffset <= 1; yOffset++) {
      if (xOffset === 0 && yOffset === 0) continue; // Skip the current position
      const x = pos.x + xOffset;
      const y = pos.y + yOffset;
      // Check for a container structure at the adjacent position
      const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
      for (const structure of structures) {
        if (structure.structureType === STRUCTURE_CONTAINER) {
          return true;
        }
      }
    }
  }
  return false;
};

function getAdjacentContainer(source) {  
    const containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: (structure) => structure.structureType === STRUCTURE_CONTAINER,
      });
    return containers.length > 0 ? containers[0] : null;  
  }

function assignSource(creep) {
  if (creep.spawning) return;

  // Cooldown: keep current (or none) during cooloff
  if (creep.memory._reassignCooldown && Game.time < creep.memory._reassignCooldown) {
    return creep.memory.assignedSource || null;
  }

  // Already assigned? keep it.
  if (creep.memory.assignedSource) return creep.memory.assignedSource;

  var sources = creep.room.find(FIND_SOURCES);
  if (!sources || sources.length === 0) return null;

  var best = null;
  var bestScore = -Infinity;

  for (var i = 0; i < sources.length; i++) {
    var s = sources[i];

    // Avoid the source we just yielded from for a short window
    if (creep.memory._avoidSourceId === s.id && creep.memory._avoidUntil && Game.time < creep.memory._avoidUntil) {
      continue;
    }

    // Capacity seats (optionally clamp to 1 if you want solo miners)
    var seats = countWalkableSeatsAround(s.pos);
    if (CONFIG.maxHarvestersPerSource > 0) {
      seats = Math.min(seats, CONFIG.maxHarvestersPerSource);
    }

    var used = countAssignedHarvesters(creep.room.name, s.id);
    var free = seats - used;

    // **Key fix**: do not consider sources with no free seats
    if (free <= 0) continue;

    // Score: more free seats good, closer is better
    var range = creep.pos.getRangeTo(s);
    var score = (free * 100) - range;

    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }

  if (best) {
    creep.memory.assignedSource = best.id;
    return best.id;
  }
  return null;
}



module.exports = TaskBaseHarvest;