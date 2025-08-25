/*var BeeToolbox = require('BeeToolbox'); // Import utility functions for bees

const RETARGET_COOLDOWN = 10; //ticks to wait before switching containers
const DROPPED_NEAR_CONTAINER_R = 2; //how close to the container we consider"near"
const DROPPED_ALONG_ROUTE_R = 2;//opportunistic pickup while en route (shourt detours)
const DROPPED_BIG_MIN = 150; //"a lot of dropped energy" threshold
const CONTAINER_MIN = 50; //ignore tiny tricles in containers

const TaskCourier = {
  // Main logic loop for the TaskCourier
  /*
  run: function (creep) {
     // Skip logic if creep is still spawning
    BeeToolbox.assignContainerFromMemory(creep); // Assign a nearby container to the courier if none assigned
    // Update transfer state based on energy storage
    if (creep.memory.transferring && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.transferring = false; // Switch to collecting if out of energy
    }                                            
    if (!creep.memory.transferring && creep.store[RESOURCE_ENERGY] > 0) {
      creep.memory.transferring = true; // Switch to transferring when full
    }
    // Run collect or deliver logic based on state
    if (creep.memory.transferring) {
      TaskCourier.deliverEnergy(creep);
    } else {
      TaskCourier.collectEnergy(creep);
    }
  },

  // 🐝 Energy collection logic: from containers, dropped energy, or fallback
  collectEnergy: function (creep) {
    // If no container assigned, attempt to assign one
    if (!creep.memory.assignedContainer) {
      const containers = creep.room.find(FIND_STRUCTURES, {filter: (s) => s.structureType === STRUCTURE_CONTAINER && s.pos.findInRange(FIND_SOURCES, 1).length > 0});

      if (containers.length > 0) {
        // Count how many Couriers are already assigned to each container
        const containerUsage = _.countBy(
          _.filter(Game.creeps, c => c.memory.task === 'courier' && c.memory.assignedContainer),
          c => c.memory.assignedContainer
        );
        // Sort containers by fewest Couriers assigned (balance load)
        containers.sort((a, b) =>
          (containerUsage[a.id] || 0) - (containerUsage[b.id] || 0)
        );

        // Assign the least-used container to this Courier
        creep.memory.assignedContainer = containers[0].id;
        console.log(`🐝 Courier ${creep.name} assigned to container ${containers[0].id}`);
      }
    }
    // If a container is assigned, interact with it
    if (creep.memory.assignedContainer) {
      const container = Game.getObjectById(creep.memory.assignedContainer);
      if (container) {
        // Look for dropped energy near the container (within 1 tile)
        const dropped = container.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
          filter: r => r.resourceType === RESOURCE_ENERGY
        });
        if (dropped.length > 0) {
          // Pick up the largest dropped energy pile
          const target = _.max(dropped, r => r.amount);
          if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
            BeeToolbox.BeeTravel(creep, target);
            //creep.moveTo(target, {reusePath: 10, visualizePathStyle:{opacity: .8 ,stroke: '#00d4f5',lineStyle: 'dashed'}});
          }
          return; // Skip to next tick
        }
        // If no dropped energy, try withdrawing from the container itself
        if (container.store[RESOURCE_ENERGY] > 0) {
          if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            BeeToolbox.BeeTravel(creep, container)
            //creep.moveTo(container, {reusePath: 10, visualizePathStyle:{opacity: .8 ,stroke: '#00d4f5',lineStyle: 'dashed'}});
          }
          return; // Done for this tick
        }
      }
    }
    // If no container/dropped energy, fallback to general energy collection
    //BeeToolbox.collectEnergy(creep);
    //pickupDroppedEnergy(creep);
    const droppedEnergy = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
    filter: r => r.resourceType === RESOURCE_ENERGY
      });

      if (droppedEnergy) {
          if (creep.pickup(droppedEnergy) === ERR_NOT_IN_RANGE) {
              BeeToolbox.BeeTravel(creep,droppedEnergy)
          }
      }
  },
  
  // Smarter energy pickup logic
pickupDroppedEnergy: function (creep) {
  const droppedEnergy = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
    filter: r => r.resourceType === RESOURCE_ENERGY
      });

      if (droppedEnergy) {
          if (creep.pickup(droppedEnergy) === ERR_NOT_IN_RANGE) {
              BeeToolbox.BeeTravel(creep,droppedEnergy)
          }
        return true; // Found and targeted energy
      }
      return false; // No dropped energy nearby
  },
  // 📦 Deliver energy to structures based on priority
  deliverEnergy: function (creep) {
    BeeToolbox.deliverEnergy(creep, [
      STRUCTURE_STORAGE,
      STRUCTURE_EXTENSION,
      STRUCTURE_SPAWN,
      STRUCTURE_TOWER,
      STRUCTURE_CONTAINER
    ]);
  }
};

module.exports = TaskCourier; 
*/
// Task.Courier.js — dynamic picker (no static container assignment)
// Chooses the fullest source-container, stays committed to it (with a short cooldown),
// scoops any fat dropped piles near that container, then delivers.
//
// Depends on (optional): BeeToolbox.BeeTravel
// Note: Delivery is now internal here to avoid external "room" refs.

var BeeToolbox = require('BeeToolbox');

const RETARGET_COOLDOWN = 10;       // ticks to wait before switching containers
const DROPPED_NEAR_CONTAINER_R = 2; // how close to the container we consider "near"
const DROPPED_ALONG_ROUTE_R = 2;    // opportunistic pickup while en route (short detours only)
const DROPPED_BIG_MIN = 150;        // "a lot of dropped energy" threshold
const CONTAINER_MIN = 50;           // ignore tiny trickles in containers

const TaskCourier = {
  // Main logic loop
  run: function(creep) {
    // bootstrap memory
    if (creep.memory.transferring && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.transferring = false;
    }
    if (!creep.memory.transferring && creep.store.getFreeCapacity() === 0) {
      creep.memory.transferring = true;
    }

    // ensure sticky target fields exist
    if (creep.memory.pickupContainerId === undefined) creep.memory.pickupContainerId = null;
    if (creep.memory.retargetAt === undefined) creep.memory.retargetAt = 0;

    if (creep.memory.transferring) {
      TaskCourier.deliverEnergy(creep);
    } else {
      TaskCourier.collectEnergy(creep);
    }
  },

  // -----------------------------
  // Energy collection
  // -----------------------------
  collectEnergy: function(creep) {
    const room = creep.room;

    // choose/keep a target container (by absolute energy desc)
    let container = Game.getObjectById(creep.memory.pickupContainerId);
    const now = Game.time | 0;

    if (!isGoodContainer(container) || now >= (creep.memory.retargetAt || 0)) {
      const best = findBestSourceContainer(room);
      // retarget only if (a) no current OR (b) clearly better
      if (!container || (best && container.id !== best.id && isClearlyBetter(best, container))) {
        container = best || null;
        creep.memory.pickupContainerId = container ? container.id : null;
        creep.memory.retargetAt = now + RETARGET_COOLDOWN;
      }
    }

    // Opportunistic: big pile right next to us? (fast pickup)
    const nearbyBig = creep.pos.findInRange(FIND_DROPPED_RESOURCES, DROPPED_ALONG_ROUTE_R, {
      filter: r => r.resourceType === RESOURCE_ENERGY && r.amount >= DROPPED_BIG_MIN
    })[0];
    if (nearbyBig) {
      if (creep.pickup(nearbyBig) === ERR_NOT_IN_RANGE) {
        return BeeToolbox.BeeTravel ? BeeToolbox.BeeTravel(creep, nearbyBig, 1, 10) : creep.moveTo(nearbyBig);
      }
      return; // picked this tick or moved
    }

    // If we have a target container, prefer dropped piles NEAR THAT container first
    if (container) {
      // dropped energy within radius of the container
      const dropsNearContainer = container.pos.findInRange(FIND_DROPPED_RESOURCES, DROPPED_NEAR_CONTAINER_R, {
        filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 0
      });
      if (dropsNearContainer.length) {
        const bestDrop = creep.pos.findClosestByPath(dropsNearContainer) || dropsNearContainer[0];
        const res = creep.pickup(bestDrop);
        if (res === ERR_NOT_IN_RANGE) {
          return BeeToolbox.BeeTravel ? BeeToolbox.BeeTravel(creep, bestDrop, 1, 10) : creep.moveTo(bestDrop, {reusePath: 5});
        }
        // after pickup, if we still have room, fall through to also withdraw from the container
      }

      // Withdraw from the container if it has enough juice
      if ((container.store[RESOURCE_ENERGY] || 0) > 0) {
        const wr = creep.withdraw(container, RESOURCE_ENERGY);
        if (wr === ERR_NOT_IN_RANGE) {
          return BeeToolbox.BeeTravel ? BeeToolbox.BeeTravel(creep, container, 1, 10) : creep.moveTo(container, {reusePath: 5});
        } else if (wr === OK) {
          return;
        } else if (wr === ERR_NOT_ENOUGH_RESOURCES) {
          // container emptied; allow faster retarget next tick
          creep.memory.retargetAt = Game.time;
        }
      } else {
        // container empty; allow faster retarget
        creep.memory.retargetAt = Game.time;
      }
    }

    // Fallbacks: tombstones/ruins with energy
    const grave = creep.pos.findClosestByPath(FIND_TOMBSTONES, { filter: t => (t.store[RESOURCE_ENERGY] || 0) > 0 })
              || creep.pos.findClosestByPath(FIND_RUINS,      { filter: r => (r.store[RESOURCE_ENERGY] || 0) > 0 });
    if (grave) {
      const wr = creep.withdraw(grave, RESOURCE_ENERGY);
      if (wr === ERR_NOT_IN_RANGE) {
        return BeeToolbox.BeeTravel ? BeeToolbox.BeeTravel(creep, grave, 1, 10) : creep.moveTo(grave, {reusePath: 5});
      }
      return;
    }

    // Fallback: any dropped energy above small threshold anywhere
    const dropped = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
      filter: r => r.resourceType === RESOURCE_ENERGY && r.amount >= 50
    });
    if (dropped) {
      if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
        return BeeToolbox.BeeTravel ? BeeToolbox.BeeTravel(creep, dropped, 1, 10) : creep.moveTo(dropped, {reusePath: 5});
      }
      return;
    }

    // Final fallback: storage/terminal (if any)
    const storeLike = room.storage && room.storage.store[RESOURCE_ENERGY] > 0 ? room.storage
                    : room.terminal && room.terminal.store[RESOURCE_ENERGY] > 0 ? room.terminal
                    : null;
    if (storeLike) {
      const wr = creep.withdraw(storeLike, RESOURCE_ENERGY);
      if (wr === ERR_NOT_IN_RANGE) {
        return BeeToolbox.BeeTravel ? BeeToolbox.BeeTravel(creep, storeLike, 1, 10) : creep.moveTo(storeLike, {reusePath: 5});
      }
      return;
    }

    // If absolutely nothing to do, drift toward storage/spawn to be useful next tick.
    const anchor = room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS);
    if (anchor && !creep.pos.inRangeTo(anchor, 3)) {
      return BeeToolbox.BeeTravel ? BeeToolbox.BeeTravel(creep, anchor, 3, 10) : creep.moveTo(anchor, {reusePath: 10});
    }
  },

  // -----------------------------
  // Delivery — internal (no BeeToolbox dependency to avoid "room" leaks)
  // -----------------------------
  deliverEnergy: function(creep) {
    const target = selectDropoffTarget(creep);
    if (!target) {
      // nothing needs it — hover near storage/spawn
      const anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS);
      if (anchor && !creep.pos.inRangeTo(anchor, 3)) {
        return BeeToolbox.BeeTravel ? BeeToolbox.BeeTravel(creep, anchor, 3, 10) : creep.moveTo(anchor, {reusePath: 10});
      }
      return;
    }

    const tr = creep.transfer(target, RESOURCE_ENERGY);
    if (tr === ERR_NOT_IN_RANGE) {
      return BeeToolbox.BeeTravel ? BeeToolbox.BeeTravel(creep, target, 1, 10) : creep.moveTo(target, {reusePath: 5});
    }
    if (tr === OK && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.transferring = false;
    }
  }
};

module.exports = TaskCourier;

// ---------- helpers ----------
function isGoodContainer(c) {
  return c && c.structureType === STRUCTURE_CONTAINER && (c.store && c.store[RESOURCE_ENERGY] >= CONTAINER_MIN);
}

function isSourceContainer(c) {
  if (!c || c.structureType !== STRUCTURE_CONTAINER) return false;
  // consider it a source-container if within 1 of a Source
  return c.pos.findInRange(FIND_SOURCES, 1).length > 0;
}

function findBestSourceContainer(room) {
  const containers = room.find(FIND_STRUCTURES, {
    filter: s => s.structureType === STRUCTURE_CONTAINER && (s.store[RESOURCE_ENERGY] || 0) >= CONTAINER_MIN
  });
  if (containers.length === 0) return null;

  // Prefer source-adjacent containers first, then by absolute energy desc, then by proximity
  containers.sort((a, b) => {
    const as = isSourceContainer(a) ? 0 : 1;
    const bs = isSourceContainer(b) ? 0 : 1;
    if (as !== bs) return as - bs;
    const ea = a.store[RESOURCE_ENERGY] || 0;
    const eb = b.store[RESOURCE_ENERGY] || 0;
    if (eb !== ea) return eb - ea;
    // tie-breaker: closer to room center (rough heuristic)
    const da = Math.abs(a.pos.x - 25) + Math.abs(a.pos.y - 25);
    const db = Math.abs(b.pos.x - 25) + Math.abs(b.pos.y - 25);
    return da - db;
  });
  return containers[0];
}

function isClearlyBetter(best, current) {
  const be = (best.store && best.store[RESOURCE_ENERGY]) || 0;
  const ce = (current.store && current.store[RESOURCE_ENERGY]) || 0;
  // switch if 25% more energy or at least +200
  return be >= ce * 1.25 || be - ce >= 200;
}

function selectDropoffTarget(creep) {
  const room = creep.room;
/*
  // (1) Spawns / Extensions that need energy
  const spawnOrExt = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: s => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
                 (s.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0,
  });
  if (spawnOrExt) return spawnOrExt;

  // (2) Towers below threshold (800 or half capacity, whichever is lower)
  const towers = room.find(FIND_STRUCTURES, {
    filter: s => s.structureType === STRUCTURE_TOWER &&
                 (s.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0 &&
                 ((s.store[RESOURCE_ENERGY] || 0) < Math.min(800, (s.store.getCapacity && s.store.getCapacity(RESOURCE_ENERGY)) || 1000))
  });
  if (towers.length) return creep.pos.findClosestByPath(towers);
*/
  // (3) Storage preferred, then Terminal
  if (room.storage && (room.storage.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0) return room.storage;
  if (room.terminal && (room.terminal.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0) return room.terminal;

  // (4) Any non-source container with free capacity
  const container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: s => s.structureType === STRUCTURE_CONTAINER && !isSourceContainer(s) &&
                 (s.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0,
  });
  if (container) return container;

  return null;
}

