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






// Planner.Road.clean.js
// Readable road planner for Screeps
// Plans + drip-places ROAD sites from your home room to remotes,
// AND (new) builds a home-room network to sources using a staged anchor (spawn → storage).

/** Tweakables */
const PLAIN_COST = 2;
const SWAMP_COST = 10;
const ROAD_COST  = 1;
const PLACE_BUDGET_PER_TICK = 10;
const CSITE_SAFETY_LIMIT = 95;
const AUDIT_INTERVAL = 100;
// Optional: include controller in the staged home network
const INCLUDE_CONTROLLER = true;

/** Helpers */
function hasRoadOrRoadSite(pos) {
  const structures = pos.lookFor(LOOK_STRUCTURES);
  for (const s of structures) if (s.structureType === STRUCTURE_ROAD) return true;
  const sites = pos.lookFor(LOOK_CONSTRUCTION_SITES);
  for (const cs of sites) if (cs.structureType === STRUCTURE_ROAD) return true;
  return false;
}

const RoadPlanner = {
  /**
   * Call this once per tick from your main loop.
   * @param {Room} homeRoom
   */
  ensureRemoteRoads(homeRoom) {
    if (!homeRoom || !homeRoom.controller || !homeRoom.controller.my) return;

    const mem = this._memory(homeRoom);

    const spawns = homeRoom.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) return;

    // NEW: stage-aware local network (spawn → storage when available)
    this.ensureStagedHomeNetwork(homeRoom);

    // --- existing remote logic ---
    const activeRemotes = this._getActiveRemoteRoomsFromCreeps();

    for (const remoteName of activeRemotes) {
      const rmem = Memory.rooms[remoteName];
      if (!rmem || !rmem.sources) continue;

      const remoteRoom = Game.rooms[remoteName];
      if (!remoteRoom) continue;

      const sources = remoteRoom.find(FIND_SOURCES);
      for (const src of sources) {
        const key = `${remoteName}:${src.id}`;

        if (!mem.paths[key]) {
          const harvestPos = this._chooseHarvestTile(src);
          const goal = harvestPos ? { pos: harvestPos, range: 0 } : { pos: src.pos, range: 1 };

          const ret = PathFinder.search(this._getAnchorPos(homeRoom), goal, {
            plainCost: PLAIN_COST,
            swampCost: SWAMP_COST,
            roomCallback: (roomName) => this._roomCostMatrix(roomName)
          });

          if (!ret.path || ret.path.length === 0 || ret.incomplete) continue;

          mem.paths[key] = {
            i: 0,
            done: false,
            path: ret.path.map(p => ({ x: p.x, y: p.y, roomName: p.roomName }))
          };
        }

        this._placeAlongPath(homeRoom, key, PLACE_BUDGET_PER_TICK);
        this._auditAndRelaunch(homeRoom, key, 1);
      }
    }
  },

  /** NEW: choose anchor (spawn until storage exists, then storage). */
  _getAnchorPos(homeRoom) {
    if (homeRoom.storage) return homeRoom.storage.pos;
    const spawns = homeRoom.find(FIND_MY_SPAWNS);
    return spawns.length ? spawns[0].pos : null;
  },

  /** NEW: Path + track with a stable key, then drip-place + audit (one-stop helper). */
  _planAndTrack(homeRoom, fromPos, goalPos, key, range = 1) {
    if (!fromPos || !goalPos) return;
    const mem = this._memory(homeRoom);

    if (!mem.paths[key]) {
      const ret = PathFinder.search(fromPos, { pos: goalPos, range }, {
        plainCost: PLAIN_COST,
        swampCost: SWAMP_COST,
        roomCallback: (roomName) => this._roomCostMatrix(roomName)
      });
      if (!ret.path || ret.path.length === 0 || ret.incomplete) return;

      mem.paths[key] = {
        i: 0,
        done: false,
        path: ret.path.map(p => ({ x: p.x, y: p.y, roomName: p.roomName }))
      };
    }

    this._placeAlongPath(homeRoom, key, PLACE_BUDGET_PER_TICK);
    this._auditAndRelaunch(homeRoom, key, 1);
  },

  /** NEW: stage-aware local network to sources (+controller optional) */
  ensureStagedHomeNetwork(homeRoom) {
    const anchor = this._getAnchorPos(homeRoom);
    if (!anchor) return;

    // pave to each home-room source (use harvest tile if we can see it)
    const sources = homeRoom.find(FIND_SOURCES);
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      const harv = this._chooseHarvestTile(src) || src.pos;
      const range = (harv === src.pos) ? 1 : 0;
      const key = `${homeRoom.name}:LOCAL:source${i}:from=${homeRoom.storage ? 'storage' : 'spawn'}`;
      this._planAndTrack(homeRoom, anchor, harv, key, range);
    }

    // optional: pave to controller and storage (nice logistics spine)
    if (INCLUDE_CONTROLLER && homeRoom.controller) {
      const keyC = `${homeRoom.name}:LOCAL:controller:from=${homeRoom.storage ? 'storage' : 'spawn'}`;
      this._planAndTrack(homeRoom, anchor, homeRoom.controller.pos, keyC, 1);
    }
    if (homeRoom.storage) {
      // If we just “graduated” to storage, make sure spawn ↔ storage is paved
      const spawns = homeRoom.find(FIND_MY_SPAWNS);
      if (spawns.length) {
        const keyS = `${homeRoom.name}:LOCAL:spawn0-to-storage`;
        this._planAndTrack(homeRoom, spawns[0].pos, homeRoom.storage.pos, keyS, 1);
      }
    }
  },

  /** Cost matrix builder (shared) */
  _roomCostMatrix(roomName) {
    const room = Game.rooms[roomName];
    if (!room) return;
    const costs = new PathFinder.CostMatrix();

    room.find(FIND_STRUCTURES).forEach(s => {
      if (s.structureType === STRUCTURE_ROAD) {
        costs.set(s.pos.x, s.pos.y, ROAD_COST);
      } else if (
        s.structureType !== STRUCTURE_CONTAINER &&
        (s.structureType !== STRUCTURE_RAMPART || !s.my)
      ) {
        costs.set(s.pos.x, s.pos.y, 0xff);
      }
    });

    room.find(FIND_CONSTRUCTION_SITES).forEach(cs => {
      if (cs.structureType !== STRUCTURE_ROAD) {
        costs.set(cs.pos.x, cs.pos.y, 0xff);
      }
    });

    room.find(FIND_SOURCES).forEach(s => costs.set(s.pos.x, s.pos.y, 0xff));
    const minerals = room.find(FIND_MINERALS) || [];
    minerals.forEach(m => costs.set(m.pos.x, m.pos.y, 0xff));

    return costs;
  },

  /** Drip-placer (unchanged except for minor comment) */
  _placeAlongPath(homeRoom, key, budget) {
    if (Object.keys(Game.constructionSites).length > CSITE_SAFETY_LIMIT) return;

    const mem = this._memory(homeRoom);
    const rec = mem.paths[key];
    if (!rec || rec.done) return;

    let placed = 0;
    let iterations = 0;

    while (rec.i < rec.path.length && placed < budget) {
      if (++iterations > budget + 10) break;

      const step = rec.path[rec.i];
      const roomObj = Game.rooms[step.roomName];
      if (!roomObj) break;

      const terrainVal = roomObj.getTerrain().get(step.x, step.y);
      if (terrainVal !== TERRAIN_MASK_WALL) {
        const pos = new RoomPosition(step.x, step.y, step.roomName);
        if (!hasRoadOrRoadSite(pos)) {
          const res = roomObj.createConstructionSite(pos, STRUCTURE_ROAD);
          if (res === OK) {
            placed++;
          } else if (res === ERR_FULL) {
            break; // global cap
          } // else: silently skip other rc (tile blocked); pointer still advances
        }
      }
      rec.i++;
    }
    if (rec.i >= rec.path.length) rec.done = true;
  },

  /** Memory bucket */
  _memory(homeRoom) {
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[homeRoom.name]) Memory.rooms[homeRoom.name] = {};
    const r = Memory.rooms[homeRoom.name];
    if (!r.roadPlanner) r.roadPlanner = { paths: {} };
    if (!r.roadPlanner.paths) r.roadPlanner.paths = {};
    return r.roadPlanner;
  },

  /** Info helper */
  getActiveRemoteRooms(homeRoom) {
    const mem = this._memory(homeRoom);
    const rooms = new Set();
    for (const key of Object.keys(mem.paths || {})) {
      rooms.add(key.split(':')[0]);
    }
    return [...rooms];
  },

  /** Audit + relaunch if tiles decayed (unchanged) */
  _auditAndRelaunch(homeRoom, key, maxFixes = 1) {
    const mem = this._memory(homeRoom);
    const rec = mem.paths[key];
    if (!rec || !rec.done || !Array.isArray(rec.path) || rec.path.length === 0) return;

    if (Game.time % AUDIT_INTERVAL !== 0 && Math.random() > 0.01) return;

    let fixed = 0;
    for (let idx = 0; idx < rec.path.length && fixed < maxFixes; idx++) {
      const step = rec.path[idx];
      const roomObj = Game.rooms[step.roomName];
      if (!roomObj) continue;

      const terrainVal = roomObj.getTerrain().get(step.x, step.y);
      if (terrainVal === TERRAIN_MASK_WALL) continue;

      const pos = new RoomPosition(step.x, step.y, step.roomName);
      if (!hasRoadOrRoadSite(pos)) {
        const res = roomObj.createConstructionSite(pos, STRUCTURE_ROAD);
        if (res === OK) {
          if (typeof rec.i !== 'number' || rec.i > idx) rec.i = idx;
          rec.done = false;
          fixed++;
        }
      }
    }
  },

  /** Harvest tile chooser (unchanged) */
  _chooseHarvestTile(src) {
    const room = Game.rooms[src.pos.roomName];
    if (!room) return null;

    const terrain = room.getTerrain();
    let best = null;
    let bestScore = -Infinity;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const x = src.pos.x + dx;
        const y = src.pos.y + dy;
        if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;

        const t = terrain.get(x, y);
        if (t === TERRAIN_MASK_WALL) continue;

        const pos = new RoomPosition(x, y, room.name);
        const structs = pos.lookFor(LOOK_STRUCTURES);

        let score = 0;
        if (structs.some(s => s.structureType === STRUCTURE_CONTAINER)) score += 10;
        if (structs.some(s => s.structureType === STRUCTURE_ROAD)) score += 5;
        if (t === TERRAIN_MASK_SWAMP) score -= 2;

        if (score > bestScore) { bestScore = score; best = pos; }
      }
    }
    return best;
  },

  /** Remote room discovery (unchanged) */
  _getActiveRemoteRoomsFromCreeps() {
    const set = new Set();
    for (const name in Game.creeps) {
      const c = Game.creeps[name];
      if (c && c.memory && c.memory.task === 'remoteharvest' && c.memory.targetRoom) {
        set.add(c.memory.targetRoom);
      }
    }
    return [...set];
  }
};

module.exports = RoadPlanner;















//Planner.Room.js
// Single source of truth for room/base planning & construction site placement

const RoomPlanner = {
    // Define limits for each structure type
    structureLimits: {
        STRUCTURE_TOWER: 6,
        STRUCTURE_EXTENSION: 60,
        STRUCTURE_CONTAINER: 10,
        STRUCTURE_RAMPART: 2,
        STRUCTURE_ROAD: 150,
    },

    BASE_OFFSETS:[
        { type: STRUCTURE_STORAGE,   x:  8, y: 0},//1
        { type: STRUCTURE_SPAWN,     x: -5, y: 0},
        { type: STRUCTURE_SPAWN,     x:  5, y: 0},

        //{ type: STRUCTURE_CONTAINER, x: 5, y: 0},

        { type: STRUCTURE_EXTENSION, x: 0, y: 2 },//1
        { type: STRUCTURE_EXTENSION, x: 0, y:-2 },//2
        { type: STRUCTURE_EXTENSION, x: 0, y: 3 },//3
        { type: STRUCTURE_EXTENSION, x: 0, y:-3 },//4
        { type: STRUCTURE_EXTENSION, x:-1, y: 3 },//5
        { type: STRUCTURE_EXTENSION, x:-1, y:-3 },//6
        { type: STRUCTURE_EXTENSION, x: 1, y:-3 },//7
        { type: STRUCTURE_EXTENSION, x: 1, y: 3 },//8
        { type: STRUCTURE_EXTENSION, x:-1, y: 2 },//9
        { type: STRUCTURE_EXTENSION, x:-1, y:-2 },//10
        { type: STRUCTURE_EXTENSION, x: 1, y: 2 },//11
        { type: STRUCTURE_EXTENSION, x: 1, y:-2 },//12 
        { type: STRUCTURE_EXTENSION, x:-2, y:-1 },//13
        { type: STRUCTURE_EXTENSION, x:-2, y: 1 },//14
        { type: STRUCTURE_EXTENSION, x: 2, y:-1 },//15
        { type: STRUCTURE_EXTENSION, x: 2, y: 1 },//16
        { type: STRUCTURE_EXTENSION, x:-3, y: 1 },//17
        { type: STRUCTURE_EXTENSION, x:-3, y:-1 },//18
        { type: STRUCTURE_EXTENSION, x: 3, y: 1 },//19
        { type: STRUCTURE_EXTENSION, x: 3, y:-1 },//20
        { type: STRUCTURE_EXTENSION, x:-3, y: 2 },//21
        { type: STRUCTURE_EXTENSION, x:-3, y:-2 },//22
        { type: STRUCTURE_EXTENSION, x: 3, y: 2 },//23
        { type: STRUCTURE_EXTENSION, x: 3, y:-2 },//24
        { type: STRUCTURE_EXTENSION, x:-4, y: 2 },//25
        { type: STRUCTURE_EXTENSION, x:-4, y:-2 },//26
        { type: STRUCTURE_EXTENSION, x: 4, y: 2 },//27
        { type: STRUCTURE_EXTENSION, x: 4, y:-2 },//28
        { type: STRUCTURE_EXTENSION, x: 4, y: 3 },//29
        { type: STRUCTURE_EXTENSION, x: 4, y:-3 },//30
        { type: STRUCTURE_EXTENSION, x:-4, y: 3 },//31
        { type: STRUCTURE_EXTENSION, x:-4, y:-3 },//32
        { type: STRUCTURE_EXTENSION, x:-4, y: 4 },//33
        { type: STRUCTURE_EXTENSION, x:-4, y:-4 },//34
        { type: STRUCTURE_EXTENSION, x: 4, y: 4 },//35
        { type: STRUCTURE_EXTENSION, x: 4, y:-4 },//36
        { type: STRUCTURE_EXTENSION, x: 3, y: 4 },//37
        { type: STRUCTURE_EXTENSION, x: 3, y:-4 },//38
        { type: STRUCTURE_EXTENSION, x:-3, y: 4 },//39
        { type: STRUCTURE_EXTENSION, x:-3, y:-4 },//40
        { type: STRUCTURE_EXTENSION, x:-2, y: 4 },//41
        { type: STRUCTURE_EXTENSION, x:-2, y:-4 },//42
        { type: STRUCTURE_EXTENSION, x: 2, y: 4 },//43
        { type: STRUCTURE_EXTENSION, x: 2, y:-4 },//44
        { type: STRUCTURE_EXTENSION, x: 2, y: 5 },//45
        { type: STRUCTURE_EXTENSION, x: 2, y:-5 },//46
        { type: STRUCTURE_EXTENSION, x:-2, y:-5 },//47
        { type: STRUCTURE_EXTENSION, x:-2, y: 5 },//48
        { type: STRUCTURE_EXTENSION, x:-1, y:-5 },//49
        { type: STRUCTURE_EXTENSION, x:-1, y: 5 },//50
        { type: STRUCTURE_EXTENSION, x: 1, y: 5 },//51
        { type: STRUCTURE_EXTENSION, x: 1, y:-5 },//52
        { type: STRUCTURE_EXTENSION, x: 0, y: 5 },//53
        { type: STRUCTURE_EXTENSION, x: 0, y:-5 },//54
        { type: STRUCTURE_EXTENSION, x:-4, y: 0 },//55
        { type: STRUCTURE_EXTENSION, x: 4, y: 0 },//56
        { type: STRUCTURE_EXTENSION, x:-5, y: 1 },//57
        { type: STRUCTURE_EXTENSION, x:-5, y:-1 },//58
        { type: STRUCTURE_EXTENSION, x: 5, y: 1 },//59
        { type: STRUCTURE_EXTENSION, x: 5, y:-1 },//60 
        // TOWER LOCATIONS
        //{ type: STRUCTURE_TOWER, x:-5, y:-5 },//1
        //{ type: STRUCTURE_TOWER, x: 5, y: 5 },//2
        //{ type: STRUCTURE_TOWER, x:-5, y: 5 },//3
        //{ type: STRUCTURE_TOWER, x: 5, y:-5 },//4
        //{ type: STRUCTURE_TOWER, x:-1, y: 0 },//5
        //{ type: STRUCTURE_TOWER, x: 1, y: 0 },//6
        { type: STRUCTURE_ROAD, x: 1, y: 1 },
        { type: STRUCTURE_ROAD, x: 0, y: 1 },
        { type: STRUCTURE_ROAD, x:-1, y: 1 },
        { type: STRUCTURE_ROAD, x:-1, y: 0 },
        { type: STRUCTURE_ROAD, x:-1, y:-1 },
        { type: STRUCTURE_ROAD, x: 0, y:-1 },
        { type: STRUCTURE_ROAD, x: 1, y:-1 },
        { type: STRUCTURE_ROAD, x: 1, y: 0 },
        { type: STRUCTURE_ROAD, x: 2, y: 0 },
        { type: STRUCTURE_ROAD, x: 3, y: 0 },
        { type: STRUCTURE_ROAD, x:-2, y: 0 },
        { type: STRUCTURE_ROAD, x:-3, y: 0 },
        { type: STRUCTURE_ROAD, x:-4, y: 1 },
        { type: STRUCTURE_ROAD, x:-4, y:-1 },
        { type: STRUCTURE_ROAD, x: 4, y:-1 },
        { type: STRUCTURE_ROAD, x: 4, y: 1 },
        { type: STRUCTURE_ROAD, x: 2, y: 2 },
        { type: STRUCTURE_ROAD, x: 2, y:-2 },
        { type: STRUCTURE_ROAD, x: 3, y:-3 },
        { type: STRUCTURE_ROAD, x: 3, y: 3 },
        { type: STRUCTURE_ROAD, x:-2, y: 2 },
        { type: STRUCTURE_ROAD, x:-2, y:-2 },
        { type: STRUCTURE_ROAD, x:-3, y:-3 },
        { type: STRUCTURE_ROAD, x:-3, y: 3 },
        { type: STRUCTURE_ROAD, x:-2, y: 3 },
        { type: STRUCTURE_ROAD, x: 2, y: 3 },
        { type: STRUCTURE_ROAD, x:-2, y:-3 },
        { type: STRUCTURE_ROAD, x: 2, y:-3 },
        { type: STRUCTURE_ROAD, x:-1, y: 4 },
        { type: STRUCTURE_ROAD, x: 1, y: 4 },
        { type: STRUCTURE_ROAD, x:-1, y:-4 },
        { type: STRUCTURE_ROAD, x: 1, y:-4 },
        { type: STRUCTURE_ROAD, x: 0, y: 4 },
        { type: STRUCTURE_ROAD, x: 0, y:-4 },
        // Add more structures with their positions
    ],

    ensureSites(room) {
        if (!room || !room.controller || !room.controller.my) return;

        //anchor = first spawn(stable & cheap)
        const spawns = room.find(FIND_MY_SPAWNS);
        if (!spawns.length) return;
        const anchor = spawns[0].pos;

        const mem = RoomPlanner._memory(room);
        if (mem.netPlanTick && Game.time < mem.nextPlanTick) return;

        const MAX_SITES_PER_TICK = 5; // be gentle: site cap is 100 global
        let placed = 0;

        for (const p of RoomPlanner.BASE_OFFSETS) {
            if (placed >= MAX_SITES_PER_TICK) break;

            const tx = anchor.x + p.x;
            const ty = anchor.y + p.y;
            if (tx < 1 || tx > 48 || ty < 1 || ty > 48) continue;

            const target = new RoomPosition(tx, ty, room.name);

            //skip if something already here
            const already =
                target.lookFor(LOOK_STRUCTURES).length ||
                target.lookFor(LOOK_CONSTRUCTION_SITES).length;
            if (already) continue;

            //respect hard limits (existing + sites)
            if (RoomPlanner._isAtLimit(room, p.type)) continue;

            // don't place into walls
            const terr = room.getTerrain().get(tx, ty);
            if (terr === TERRAIN_MASK_WALL) continue;

            if (room.createConstructionSite(target, p.type) === OK) {
                placed++;
            }
        }

        mem.nextPlanTick = Game.time + (placed ? 10 : 25);
    },

    // ---Helpers---
    _memory(room) {
        if (!Memory.rooms) Memory.rooms = {};
        if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
        if (!Memory.rooms[room.name].planner) Memory.rooms[room.name].planner = {};
        return Memory.rooms[room.name].planner;
    },

    _isAtLimit(room, type) {
        const lim = this.structureLimits[type];
        if (!lim) return false;
        const built = room.find(FIND_STRUCTURES, { filter: s => s.structureType === type }).length;
        const sites = room.find(FIND_CONSTRUCTION_STIES, { filter: s => s.structureType === type}).length;
        return (built + sites) >= lim;
    },
};

module.exports = RoomPlanner;

































// BeeHiveMind.js (refactor, ES5-safe)

// -------- Logging --------
var LOG_LEVEL = { NONE: 0, BASIC: 1, DEBUG: 2 };
// Toggle here:
var currentLogLevel = LOG_LEVEL.BASIC;

// -------- Requires --------
var spawnLogic      = require('spawn.logic');
var roleWorker_Bee  = require('role.Worker_Bee');
var TaskBuilder     = require('Task.Builder');
var RoomPlanner     = require('Planner.Room');
var RoadPlanner     = require('Planner.Road');
var TradeEnergy     = require('Trade.Energy');

// Map role name -> run function
var creepRoles = {
  Worker_Bee: roleWorker_Bee.run
};

// Small logger
function log(level, msg) {
  if (currentLogLevel >= level) console.log(msg);
}

var BeeHiveMind = {
  // ---------------- Main tick ----------------
  run: function () {
    BeeHiveMind.initializeMemory();

    // Per-room management
    for (var roomName in Game.rooms) {
      if (!Game.rooms.hasOwnProperty(roomName)) continue;
      var room = Game.rooms[roomName];
      BeeHiveMind.manageRoom(room);
    }

    // Per-creep roles
    for (var name in Game.creeps) {
      if (!Game.creeps.hasOwnProperty(name)) continue;
      var creep = Game.creeps[name];
      BeeHiveMind.assignRole(creep);
    }

    // Spawns
    BeeHiveMind.manageSpawns();

    // Remote ops hook
    BeeHiveMind.manageRemoteOps();
  },

  // ------------- Room loop -------------
  manageRoom: function (room) {
    if (!room) return;

    // Continuous, low-cost site placement
    if (RoomPlanner && RoomPlanner.ensureSites) RoomPlanner.ensureSites(room);
    if (RoadPlanner && RoadPlanner.ensureRemoteRoads) RoadPlanner.ensureRemoteRoads(room);

    // Energy market decisions
    if (TradeEnergy && TradeEnergy.runAll) TradeEnergy.runAll();

    // (Room-specific logic placeholder)
  },

  // ------------- Task defaults -------------
  assignTask: function (creep) {
    if (!creep || creep.memory.task) return;

    // Simple defaults based on role
    var role = creep.memory.role;
    if (role === 'Queen') creep.memory.task = 'queen';
    else if (role === 'Scout') creep.memory.task = 'scout';
    else if (role === 'repair') creep.memory.task = 'repair';
    // else leave undefined; spawner logic will create needed ones
  },

  // ------------- Role dispatch -------------
  assignRole: function (creep) {
    if (!creep) return;
    BeeHiveMind.assignTask(creep);

    var roleName = creep.memory.role;
    var roleFn = creepRoles[roleName];

    if (typeof roleFn === 'function') {
      try {
        roleFn(creep);
      } catch (e) {
        log(LOG_LEVEL.DEBUG, '⚠️ Role error for ' + (creep.name || 'unknown') + ' (' + roleName + '): ' + e);
      }
    } else {
      var cName = creep.name || 'unknown';
      var r = roleName || 'undefined';
      console.log('🐝 Unknown role: ' + r + ' (Creep: ' + cName + ')');
    }
  },

  // ------------- Spawning -------------
  manageSpawns: function () {
    // Helper: need at least one builder if there are local+remote sites
    function NeedBuilder(room) {
      if (!room) return 0;

      var localSites = room.find(FIND_MY_CONSTRUCTION_SITES).length;

      var remoteSites = 0;
      if (RoadPlanner && typeof RoadPlanner.getActiveRemoteRooms === 'function') {
        var remotes = RoadPlanner.getActiveRemoteRooms(room) || [];
        for (var i = 0; i < remotes.length; i++) {
          var rn = remotes[i];
          var r = Game.rooms[rn];
          if (r) remoteSites += r.find(FIND_MY_CONSTRUCTION_SITES).length;
        }
      }

      return (localSites + remoteSites) > 0 ? 1 : 0;
    }

    for (var roomName in Game.rooms) {
      if (!Game.rooms.hasOwnProperty(roomName)) continue;
      var room = Game.rooms[roomName];

      // Quotas per task
      var workerTaskLimits = {
        baseharvest:   2,
        builder:       NeedBuilder(room),
        upgrader:      1,
        repair:        0,
        courier:       1,
        remoteharvest: 6,
        scout:         1,
        queen:         2,
        CombatArcher:  1,
        CombatMelee:   0,
        CombatMedic:   1,
        Dismantler:    0,
        Trucker:       0,
        Claimer:       4,
      };

      // Ghost filter: don’t count creeps that will die very soon
      var DYING_SOON_TTL = 80;
      var roleCounts = {};
      var name;

      for (name in Game.creeps) {
        if (!Game.creeps.hasOwnProperty(name)) continue;
        var c = Game.creeps[name];
        var t = c.memory.task;
        var ttl = c.ticksToLive;

        // Newborns sometimes have undefined TTL for one tick — count them
        if (typeof ttl === 'number' && ttl <= DYING_SOON_TTL) continue;

        roleCounts[t] = (roleCounts[t] || 0) + 1;
      }

      // Each spawn tries to fill one missing task
      for (var spawnName in Game.spawns) {
        if (!Game.spawns.hasOwnProperty(spawnName)) continue;
        var spawner = Game.spawns[spawnName];
        if (spawner.spawning) continue;

        // Iterate workerTaskLimits without Object.entries
        for (var task in workerTaskLimits) {
          if (!workerTaskLimits.hasOwnProperty(task)) continue;

          var limit = workerTaskLimits[task] || 0;
          var count = roleCounts[task] || 0;

          if (count < limit) {
            var spawnResource = spawnLogic.Calculate_Spawn_Resource(spawner);
            var didSpawn = spawnLogic.Spawn_Worker_Bee(spawner, task, spawnResource);
            if (didSpawn) {
              // reflect scheduled spawn in snapshot
              roleCounts[task] = count + 1;
              break; // only one attempt per spawn per tick
            }
          }
        }
      }
    }
  },

  // ------------- Remote ops hook -------------
  manageRemoteOps: function () {
    // assignment, scouting, claiming, etc. (stub)
  },

  // ------------- Memory init -------------
  initializeMemory: function () {
    if (!Memory.rooms) Memory.rooms = {};
    // Ensure each keyed room has an object
    for (var roomName in Memory.rooms) {
      if (!Memory.rooms.hasOwnProperty(roomName)) continue;
      if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
    }
  }
};

module.exports = BeeHiveMind;

























// BeeVisuals.js 🎨🐝
var TaskBuilder = require('./Task.Builder'); // Import Builder Bee role for building tasks
// Handles RoomVisual overlays for displaying debug information and creep data
  // Logging Levels
  const LOG_LEVEL = {NONE: 0,BASIC: 1,DEBUG: 2};
  //if (currentLogLevel >= LOG_LEVEL.DEBUG) {}  
  //const currentLogLevel = LOG_LEVEL.NONE;  // Adjust to LOG_LEVEL.DEBUG for more detailed logs  

const BeeVisuals = {
    // Main function to draw visuals on the screen 0000000000000000000000000000each tick
    drawVisuals: function () {
        const roomName = Memory.firstSpawnRoom; // The room used for displaying visuals (likely the "main" room)
        if (!roomName || !Game.rooms[roomName]) return; // If no valid room, skip drawing
        const room = Game.rooms[roomName]; // Get the room object
        let yOffset = 1; // Start vertical position for text stacking
        // Iterate over all creeps to display their info
        if (currentLogLevel >= LOG_LEVEL.DEBUG) {
        for (const creepName in Game.creeps) {
            const creep = Game.creeps[creepName];
            const text = [
                `${creep.name}: ${creep.ticksToLive}`, // Creep name and remaining life ticks
                creep.memory.assignedSource ? 'A.S.ID:' + creep.memory.assignedSource : '', // Assigned source ID if set
                creep.memory.assignedContainer ? 'C.ID:' + creep.memory.assignedContainer : '', // Assigned container ID if set
                creep.memory.targetRoom ? `T.R:${creep.memory.targetRoom}` : '', // Target room info if set
                creep.memory.sourceId ? `S.ID:${creep.memory.sourceId}` : '' // Assigned source ID if set
            ].filter(Boolean).join(', '); // Filter out empty strings and join with commas

            // Draw the text at a fixed position in the room, incrementing vertical offset for each creep
            new RoomVisual(room.name).text(text, 0, yOffset++, {
                color: 'white', font: 0.5, opacity: 1, align: 'Left'
            });
            }
        }
        // Draw the CPU bucket value (how much CPU reserve you have)
        new RoomVisual(room.name).text(`CPU Bucket: ${Game.cpu.bucket}`, 20, 1, {
            color: 'white', font: 0.6, opacity: 1
        });
        // Calculate CPU usage delta for performance tracking
        const used = Game.cpu.getUsed(); // Current tick's CPU usage
        const delta = used - (Memory.lastCpuUsage || 0); // Difference from last tick's usage
        Memory.lastCpuUsage = used; // Update for next tick

        // Display CPU usage stats on screen
        new RoomVisual(room.name).text(`CPU Used: ${used.toFixed(2)} / Δ ${delta.toFixed(2)}`, 20, 2, {
            color: 'white', font: 0.6, opacity: 1
        });
        // Display a repair counter (likely linked to repair logic updates)
        const counter = Memory.GameTickRepairCounter || 0;
        new RoomVisual(room.name).text(`Repair Tick Count: ${counter}/5`, 20, 3, {
            color: 'white', font: 0.6, opacity: 1
        });
        /////////////////////////////////////////////
        if (currentLogLevel >= LOG_LEVEL.DEBUG) {
        // Draw a visual for the TaskBuilder
        const spawn = Game.spawns[Object.keys(Game.spawns)[0]];
            if (spawn) {
                const visual = new RoomVisual(spawn.room.name);
                const baseX = spawn.pos.x;
                const baseY = spawn.pos.y;

                for (const placement of TaskBuilder.structurePlacements) {
                    const posX = baseX + placement.x;
                    const posY = baseY + placement.y;
                    visual.circle(posX, posY, { radius: 0.4,opacity: .1, stroke: 'cyan' });
                    //visual.text(placement.type.replace('STRUCTURE_', ''), posX, posY, { font: 0.3, color: 'cyan' });
                }
            }
        }
        ////////////////////////////////////////////
    },
    drawEnergyBar: function() {
        const roomName = Memory.firstSpawnRoom; // The room used for displaying visuals (likely the "main" room)
        if (!roomName || !Game.rooms[roomName]) return; // If no valid room, skip drawing
        const room = Game.rooms[roomName]; // Get the room object    

        const visuals = new RoomVisual(roomName);
        const energy = room.energyAvailable;
        const capacity = room.energyCapacityAvailable;
        const percentage = energy / capacity;

        // Bar position and dimensions
        const x = 0; // Adjust as needed
        const y = 19; // Adjust as needed
        const width = 5.2; // Bar width
        const height = 1 ; // Bar height

        // Draw the background bar
        visuals.rect(x, y, width, height, {
            fill: '#000000ff',
            opacity: 0.3,
            stroke: '#000000'
        });

        // Draw the fill bar
        visuals.rect(x, y, width * percentage, height, {
            fill: '#00ff00',
            opacity: 0.5,
            stroke: '#000000'
        });

        // Draw the text
        visuals.text(`${energy}/${capacity}`, x + width / 2, y + height - .15 , {
            color: 'white',
            font: .5,
            align: 'center',
            valign: 'middle',
            opacity: 1,
            stroke: '#000000ff'
        });
    },

    drawWorkerBeeTaskTable: function() {
        const roomName = Memory.firstSpawnRoom;
        if (!roomName || !Game.rooms[roomName]) return;
        const visual = new RoomVisual(roomName);

        // Gather bees and tasks (same as before)
        const workerBees = _.filter(Game.creeps, c => c.memory.role === 'Worker_Bee');
        const totalCount = workerBees.length;
        //const maxTotal = 50;

        const maxTasks = {
            baseharvest: 2,
            builder: 1,
            upgrader: 1,
            repair: 0,
            courier: 1,
            remoteharvest: 2,
            scout: 0,
            queen: 1,
            CombatArcher: 0,
            CombatMelee: 0,
            CombatMedic: 0,
            Dismantler: 0,
            Claimer: 0,
        };
        
        const maxTotal = Object.values(maxTasks).reduce((sum, count) => sum + count, 0);

        const tasks = {};
        for (const creep of workerBees) {
            const task = creep.memory.task || 'idle';
            if (!tasks[task]) tasks[task] = 0;
            tasks[task]++;
        }
        for (let t in maxTasks) if (!tasks[t]) tasks[t] = 0;
        const taskNames = Object.keys(maxTasks);
        const nRows = 1 + taskNames.length;

        // **Customizable column widths!**
        const x0 = 0, y0 = 20;
        const nameW = 4;   // Left (task name) cell width
        const valueW = 1.2;  // Right (count/max) cell width
        const cellH = .7;
        const font = 0.5;
        const fillColor = "#000000ff";
        const strokeColor = "#000000";
        const opacityLvl = .4;

        for (let i = 0; i < nRows; i++) {
            const name = (i === 0) ? "Worker_Bee" : taskNames[i-1];
            const value = (i === 0)
                ? `${totalCount}/${maxTotal}`
                : `${tasks[taskNames[i-1]]}/${maxTasks[taskNames[i-1]]}`;

            // Draw left cell (task name)
            visual.rect(x0, y0 + i*cellH, nameW, cellH, {
                fill: fillColor, 
                stroke: strokeColor, 
                opacity: opacityLvl, 
                radius: 0.05
            });
            // Draw right cell (count/max)
            visual.rect(x0 + nameW, y0 + i*cellH, valueW, cellH, {
                fill: fillColor, 
                stroke: strokeColor, 
                opacity: opacityLvl, 
                radius: 0.05
            });

            // Name text (left cell, left-aligned)
            visual.text(name, x0 + 0.3, y0 + i*cellH + cellH/2 + 0.15, {
                font, 
                color: "#ffffffff", 
                align: 'left', 
                valign: 'middle', 
                opacity: 1
            });
            // Value text (right cell, right-aligned)
            visual.text(value, x0 + nameW + valueW - 0.3, y0 + i*cellH + cellH/2 + 0.15, {
                font, 
                color: "#ffffffff", 
                align: 'right', 
                valign: 'middle', 
                opacity: 1
            });
        }
    },

    };
// Export the BeeVisuals module so other files can use it
module.exports = BeeVisuals;






























// Task.Courier.js — dynamic picker (no static container assignment)
// Chooses the fullest source-container, stays committed (short cooldown),
// scoops any fat dropped piles near that container, then delivers.
//
// Optional dep: BeeToolbox.BeeTravel(creep, target, {range, reusePath})

var BeeToolbox = require('BeeToolbox');

// -----------------------------
// Tunables
// -----------------------------
var RETARGET_COOLDOWN = 10;       // ticks to wait before switching containers
var DROPPED_NEAR_CONTAINER_R = 2; // how close to the container we consider "near"
var DROPPED_ALONG_ROUTE_R = 2;    // opportunistic pickup while en route (short detours)
var DROPPED_BIG_MIN = 150;        // big dropped energy threshold
var CONTAINER_MIN = 50;           // ignore tiny trickles in containers

// -----------------------------
// Small helpers (ES5-safe)
// -----------------------------
function go(creep, dest, range, reuse) {
  range = (range != null) ? range : 1;
  reuse = (reuse != null) ? reuse : 10;
  if (BeeToolbox && BeeToolbox.BeeTravel) {
    BeeToolbox.BeeTravel(creep, dest, { range: range, reusePath: reuse });
  } else if (creep.pos.getRangeTo(dest) > range) {
    creep.moveTo(dest, { reusePath: reuse });
  }
}

function isGoodContainer(c) {
  return c && c.structureType === STRUCTURE_CONTAINER &&
         c.store && (c.store[RESOURCE_ENERGY] || 0) >= CONTAINER_MIN;
}

function isSourceContainer(c) {
  if (!c || c.structureType !== STRUCTURE_CONTAINER) return false;
  return c.pos.findInRange(FIND_SOURCES, 1).length > 0;
}

function findBestSourceContainer(room) {
  var containers = room.find(FIND_STRUCTURES, {
    filter: function(s) {
      return s.structureType === STRUCTURE_CONTAINER &&
             (s.store && (s.store[RESOURCE_ENERGY] || 0) >= CONTAINER_MIN);
    }
  });
  if (!containers.length) return null;

  containers.sort(function(a, b) {
    // Source-adjacent first
    var as = isSourceContainer(a) ? 0 : 1;
    var bs = isSourceContainer(b) ? 0 : 1;
    if (as !== bs) return as - bs;

    // More energy first
    var ea = (a.store && a.store[RESOURCE_ENERGY]) || 0;
    var eb = (b.store && b.store[RESOURCE_ENERGY]) || 0;
    if (eb !== ea) return eb - ea;

    // Tie-breaker: closer to room center (rough heuristic)
    var da = Math.abs(a.pos.x - 25) + Math.abs(a.pos.y - 25);
    var db = Math.abs(b.pos.x - 25) + Math.abs(b.pos.y - 25);
    return da - db;
  });

  return containers[0];
}

function isClearlyBetter(best, current) {
  var be = (best && best.store && best.store[RESOURCE_ENERGY]) || 0;
  var ce = (current && current.store && current.store[RESOURCE_ENERGY]) || 0;
  // Switch if 25% more energy or at least +200
  return be >= ce * 1.25 || (be - ce) >= 200;
}

function selectDropoffTarget(creep) {
  var room = creep.room;

  // Prefer Storage, then Terminal
  if (room.storage && ((room.storage.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0)) {
    return room.storage;
  }
  if (room.terminal && ((room.terminal.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0)) {
    return room.terminal;
  }

  // Any non-source container with free capacity
  var container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: function(s) {
      return s.structureType === STRUCTURE_CONTAINER &&
             !isSourceContainer(s) &&
             ((s.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0);
    }
  });
  if (container) return container;

  return null;
}

// -----------------------------
// Main role
// -----------------------------
var TaskCourier = {
  run: function(creep) {
    // State machine bootstrap
    if (creep.memory.transferring && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.transferring = false;
    }
    if (!creep.memory.transferring && creep.store.getFreeCapacity() === 0) {
      creep.memory.transferring = true;
    }

    // Sticky target fields
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
    var room = creep.room;

    // Decide container (keep sticky unless clearly better and cooldown passed)
    var container = Game.getObjectById(creep.memory.pickupContainerId);
    var now = Game.time | 0;

    if (!isGoodContainer(container) || now >= (creep.memory.retargetAt || 0)) {
      var best = findBestSourceContainer(room);
      if (!container || (best && container.id !== best.id && isClearlyBetter(best, container))) {
        container = best || null;
        creep.memory.pickupContainerId = container ? container.id : null;
        creep.memory.retargetAt = now + RETARGET_COOLDOWN;
      }
    }

    // Opportunistic: big pile near us? grab it
    var nearbyBigArr = creep.pos.findInRange(FIND_DROPPED_RESOURCES, DROPPED_ALONG_ROUTE_R, {
      filter: function(r) { return r.resourceType === RESOURCE_ENERGY && r.amount >= DROPPED_BIG_MIN; }
    });
    var nearbyBig = nearbyBigArr && nearbyBigArr[0];
    if (nearbyBig) {
      if (creep.pickup(nearbyBig) === ERR_NOT_IN_RANGE) go(creep, nearbyBig, 1, 10);
      return;
    }

    // If we have a target container, check drops near it first, then withdraw
    if (container) {
      var drops = container.pos.findInRange(FIND_DROPPED_RESOURCES, DROPPED_NEAR_CONTAINER_R, {
        filter: function(r) { return r.resourceType === RESOURCE_ENERGY && r.amount > 0; }
      });
      if (drops.length) {
        var bestDrop = creep.pos.findClosestByPath(drops) || drops[0];
        var pr = creep.pickup(bestDrop);
        if (pr === ERR_NOT_IN_RANGE) { go(creep, bestDrop, 1, 5); return; }
        // fall through to also try withdrawing if still room
      }

      if (((container.store && container.store[RESOURCE_ENERGY]) || 0) > 0) {
        var wr = creep.withdraw(container, RESOURCE_ENERGY);
        if (wr === ERR_NOT_IN_RANGE) { go(creep, container, 1, 5); return; }
        if (wr === OK) return;
        if (wr === ERR_NOT_ENOUGH_RESOURCES) creep.memory.retargetAt = Game.time; // allow quick retarget
      } else {
        creep.memory.retargetAt = Game.time;
      }
    }

    // Tombstones / ruins
    var grave = creep.pos.findClosestByPath(FIND_TOMBSTONES, {
                  filter: function(t){ return (t.store[RESOURCE_ENERGY] || 0) > 0; }
                }) ||
                creep.pos.findClosestByPath(FIND_RUINS, {
                  filter: function(r){ return (r.store[RESOURCE_ENERGY] || 0) > 0; }
                });
    if (grave) {
      var gw = creep.withdraw(grave, RESOURCE_ENERGY);
      if (gw === ERR_NOT_IN_RANGE) { go(creep, grave, 1, 5); }
      return;
    }

    // Any dropped energy (>=50) as a last-ditch pickup
    var dropped = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
      filter: function(r) { return r.resourceType === RESOURCE_ENERGY && r.amount >= 50; }
    });
    if (dropped) {
      if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) go(creep, dropped, 1, 5);
      return;
    }

    // Final fallback: storage/terminal
    var storeLike = (room.storage && room.storage.store[RESOURCE_ENERGY] > 0) ? room.storage
                  : (room.terminal && room.terminal.store[RESOURCE_ENERGY] > 0) ? room.terminal
                  : null;
    if (storeLike) {
      var sr = creep.withdraw(storeLike, RESOURCE_ENERGY);
      if (sr === ERR_NOT_IN_RANGE) { go(creep, storeLike, 1, 5); }
      return;
    }

    // Idle near anchor for usefulness next tick
    var anchor = room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS);
    if (anchor && !creep.pos.inRangeTo(anchor, 3)) go(creep, anchor, 3, 10);
  },

  // -----------------------------
  // Delivery (internal)
  // -----------------------------
  deliverEnergy: function(creep) {
    var target = selectDropoffTarget(creep);
    if (!target) {
      var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS);
      if (anchor && !creep.pos.inRangeTo(anchor, 3)) go(creep, anchor, 3, 10);
      return;
    }

    var tr = creep.transfer(target, RESOURCE_ENERGY);
    if (tr === ERR_NOT_IN_RANGE) { go(creep, target, 1, 5); return; }
    if (tr === OK && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.transferring = false;
    }
  }
};

module.exports = TaskCourier;











































// role.TaskQueen.js (refactor, API-compatible, ES5-safe)
// - Same export + entry: TaskQueen.run(creep)
// - Priorities:
//   1) BOOTSTRAP: build first EXT/CONTAINER or micro-haul
//   2) When carrying: EXT/SPAWN → TOWER → LINK(spawn) → TERMINAL → STORAGE
//   3) When empty: STORAGE → non-source CONTAINERS → DROPS → harvest fallback
//
// - Per-tick fill reservations prevent two Queens from selecting the same target
// - Sticky target: if still needy, keep filling it to reduce indecision
// - Uses BeeToolbox.BeeTravel if available

var BeeToolbox = require('BeeToolbox');

// ============================
// Movement / Utils
// ============================
function go(creep, dest, range) {
  range = (range != null) ? range : 1;
  if (BeeToolbox && BeeToolbox.BeeTravel) {
    BeeToolbox.BeeTravel(creep, dest, { range: range, reusePath: 15 });
  } else if (creep.pos.getRangeTo(dest) > range) {
    creep.moveTo(dest, { reusePath: 15 });
  }
}

function firstSpawn(room) {
  var spawns = room.find(FIND_MY_SPAWNS);
  return spawns.length ? spawns[0] : null;
}

function isContainerNearSource(structure) {
  return structure.pos.findInRange(FIND_SOURCES, 2).length > 0;
}

function findClosestByPath(creep, type, filterFn) {
  return creep.pos.findClosestByPath(type, { filter: filterFn });
}

function withdrawFrom(creep, target, res) {
  res = res || RESOURCE_ENERGY;
  var rc = creep.withdraw(target, res);
  if (rc === ERR_NOT_IN_RANGE) { go(creep, target); return rc; }
  if (rc === OK) {
    creep.memory.qLastWithdrawId = target.id;
    creep.memory.qLastWithdrawAt = Game.time;
  }
  return rc;
}


function transferTo(creep, target, res) {
  res = res || RESOURCE_ENERGY;
  var rc = creep.transfer(target, res);
  if (rc === ERR_NOT_IN_RANGE) go(creep, target);
  return rc;
}

function harvestFromClosest(creep) {
  var src = findClosestByPath(creep, FIND_SOURCES_ACTIVE);
  if (!src) return ERR_NOT_FOUND;
  var rc = creep.harvest(src);
  if (rc === ERR_NOT_IN_RANGE) go(creep, src);
  return rc;
}

function linkNearSpawn(room) {
  var s = firstSpawn(room);
  if (!s) return null;
  return s.pos.findClosestByRange(FIND_STRUCTURES, {
    filter: function (st) { return st.structureType === STRUCTURE_LINK; }
  });
}

// ============================
// Per-tick Queen fill reservations (ES5-safe)
// structureId -> reserved energy amount (auto-reset each tick)
// ============================
function _qrMap() {
  if (!Memory._queenRes || Memory._queenRes.tick !== Game.time) {
    Memory._queenRes = { tick: Game.time, map: {} };
  }
  return Memory._queenRes.map;
}

function _reservedFor(structId) {
  var map = _qrMap();
  return map[structId] || 0;
}

function _effectiveFree(struct, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;
  var free = (struct.store && struct.store.getFreeCapacity(resourceType)) || 0;
  return Math.max(0, free - _reservedFor(struct.id));
}

// Reserve up to `amount` for this creep; returns amount actually reserved
function reserveFill(creep, target, amount, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;
  var map = _qrMap();
  var free = _effectiveFree(target, resourceType);
  var want = Math.max(0, Math.min(amount, free));
  if (want > 0) {
    map[target.id] = (map[target.id] || 0) + want;
    creep.memory.qTargetId = target.id; // soft sticky target
  }
  return want;
}

// ============================
// Main
// ============================
var TaskQueen = {
  run: function (creep) {
    // ---------------------------------------------------------
    // 0) BOOTSTRAP: before first source-containers exist
    // ---------------------------------------------------------
    var hasSourceContainers = creep.room.find(FIND_STRUCTURES, {
      filter: function (s) {
        return s.structureType === STRUCTURE_CONTAINER &&
               s.pos.findInRange(FIND_SOURCES, 1).length > 0;
      }
    }).length > 0;

    if (!hasSourceContainers) {
      // Build first EXT/CONTAINER if any site exists
      var site = creep.pos.findClosestByPath(FIND_CONSTRUCTION_SITES, {
        filter: function (s) {
          return s.structureType === STRUCTURE_EXTENSION ||
                 s.structureType === STRUCTURE_CONTAINER;
        }
      });

      if (site) {
        if (creep.store[RESOURCE_ENERGY] === 0) {
          // Withdraw from spawn only when room energy is topped up
          var sp = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
          if (sp &&
              sp.store && sp.store[RESOURCE_ENERGY] >= 50 &&
              creep.room.energyAvailable === creep.room.energyCapacityAvailable) {
            withdrawFrom(creep, sp);
          } else {
            harvestFromClosest(creep);
          }
        } else {
          if (creep.build(site) === ERR_NOT_IN_RANGE) go(creep, site);
        }
        return;
      }

      // No relevant site? micro-courier to kickstart economy
      var drop = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function (r) { return r.resourceType === RESOURCE_ENERGY; }
      });
      if (drop && creep.store.getFreeCapacity() > 0) {
        if (creep.pickup(drop) === ERR_NOT_IN_RANGE) go(creep, drop);
        return;
      }

      var needyEarly = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
        filter: function (s) {
          return (s.structureType === STRUCTURE_SPAWN ||
                  s.structureType === STRUCTURE_EXTENSION) &&
                 s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
        }
      });
      if (needyEarly && creep.store[RESOURCE_ENERGY] > 0) {
        transferTo(creep, needyEarly);
        return;
      }
      // Fall through to normal logic if nothing else to do.
    }

    // ---------------------------------------------------------
    // 1) NORMAL PHASE: decide by carry state
    // ---------------------------------------------------------
    var carrying = creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;

    if (carrying) {
      var carryAmt = creep.store.getUsedCapacity(RESOURCE_ENERGY);

      // Sticky target first (if still has effective free)
      if (creep.memory.qTargetId) {
        var sticky = Game.getObjectById(creep.memory.qTargetId);
        if (sticky && _effectiveFree(sticky, RESOURCE_ENERGY) > 0) {
          if (reserveFill(creep, sticky, carryAmt, RESOURCE_ENERGY) > 0) {
            transferTo(creep, sticky);
            return;
          }
        } else {
          // Clear stale sticky if it’s full/gone
          creep.memory.qTargetId = null;
        }
      }

      function firstNeedyTarget(filterFn) {
        var t = creep.pos.findClosestByPath(FIND_STRUCTURES, {
          filter: function(s) {
            if (!filterFn(s)) return false;
            return _effectiveFree(s, RESOURCE_ENERGY) > 0;
          }
        });
        return t || null;
      }

      // Priority: EXT/SPAWN -> TOWER -> LINK(spawn) -> TERMINAL -> STORAGE
      var target =
        firstNeedyTarget(function (s) {
          return (s.structureType === STRUCTURE_EXTENSION ||
                  s.structureType === STRUCTURE_SPAWN) && s.store;
        }) ||
        firstNeedyTarget(function (s) {
          return s.structureType === STRUCTURE_TOWER && s.store;
        });

      if (!target) {
        var link = linkNearSpawn(creep.room);
        if (link && _effectiveFree(link, RESOURCE_ENERGY) > 0) target = link;
      }

      if (!target) {
        target = firstNeedyTarget(function (s) {
          return s.structureType === STRUCTURE_TERMINAL && s.store &&
                 s.id !== creep.memory.qLastWithdrawId;
        });
      }

      if (!target) {
        target = firstNeedyTarget(function (s) {
          return s.structureType === STRUCTURE_STORAGE && s.store &&
                 s.id !== creep.memory.qLastWithdrawId;
        });
      }

      if (target) {
        if (reserveFill(creep, target, carryAmt, RESOURCE_ENERGY) > 0) {
          transferTo(creep, target);
          return;
        }
        // Reservation lost to a race? Re-pick next tick.
      }

      // Nothing needs energy? soft idle near spawn
      var anchor = firstSpawn(creep.room) || creep.room.controller || creep.pos;
      go(creep, (anchor.pos || anchor), 2);
      return;
    } else {
      // Refill: STORAGE → non-source CONTAINERS → DROPS → harvest
      var storage = findClosestByPath(creep, FIND_STRUCTURES, function (s) {
        return s.structureType === STRUCTURE_STORAGE &&
               s.store && s.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
      });
      if (storage) { withdrawFrom(creep, storage); return; }

      var sideContainer = findClosestByPath(creep, FIND_STRUCTURES, function (s) {
        return s.structureType === STRUCTURE_CONTAINER &&
               s.store && s.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
               !isContainerNearSource(s);
      });
      if (sideContainer) { withdrawFrom(creep, sideContainer); return; }

      var drop2 = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function (r) { return r.resourceType === RESOURCE_ENERGY; }
      });
      if (drop2) {
        if (creep.pickup(drop2) === ERR_NOT_IN_RANGE) go(creep, drop2);
        return;
      }

      // Last resort: harvest a little
      harvestFromClosest(creep);
      return;
    }
  }
};

module.exports = TaskQueen;





























var BeeToolbox = require('BeeToolbox');

// ---- SCOUT RING HELPERS ----
const RING_MAX = 20;            // how far out to go before resetting
const REVISIT_DELAY = 1000;    // ticks before revisiting a room is okay
const BLOCK_CHECK_DELAY = 10000;

const DIRS_CLOCKWISE = [RIGHT, BOTTOM, LEFT, TOP]; // E, S, W, N

function okRoomName(rn) {
  const st = Game.map.getRoomStatus(rn);
  return !(st && (st.status === 'novice' || st.status === 'respawn' || st.status === 'closed'));
}

function exitsOrdered(roomName) {
  const ex = Game.map.describeExits(roomName) || {};
  const out = [];
  for (const d of DIRS_CLOCKWISE) if (ex[d]) out.push(ex[d]);
  return out;
}

function stampVisit(roomName) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  var rm = Memory.rooms[roomName];
  if (!rm.scout) rm.scout = {};
  rm.scout.lastVisited = Game.time;
}


function lastVisited(roomName) {
  if (!Memory.rooms) return -Infinity;
  var mr = Memory.rooms[roomName];
  var scout = mr && mr.scout;
  return (scout && typeof scout.lastVisited === 'number') ? scout.lastVisited : -Infinity;
}


function isBlockedRecently(roomName) {
  if (!Memory.rooms) return false;
  var mr = Memory.rooms[roomName];
  var t = mr && mr.blocked;
  return !!(t && (Game.time - t < BLOCK_CHECK_DELAY));
}


function buildRing(homeName, radius) {
  // 1) generate all rooms at radius r, clockwise, deterministically
  var ring = coordinateRing(homeName, radius);

  // 2) filter out novice/respawn/closed
  var ok = [];
  for (var i=0; i<ring.length; i++) {
    var rn = ring[i];
    var st = Game.map.getRoomStatus(rn);
    if (st && (st.status === 'novice' || st.status === 'respawn' || st.status === 'closed')) continue;
    ok.push(rn);
  }
  return ok;
}


function rebuildQueue(mem) {
  var home = mem.home;
  var ring = mem.ring;

  var layer = buildRing(home, ring);
  var candidates = layer.filter(function(rn){ return !isBlockedRecently(rn); });

  var never = [];
  var seenOld = [];
  var seenFresh = [];

  for (var i=0; i<candidates.length; i++) {
    var rn = candidates[i];
    var lv = lastVisited(rn);
    if (lv === -Infinity) {
      never.push(rn);
    } else if (Game.time - lv >= REVISIT_DELAY) {
      seenOld.push({ rn: rn, last: lv });
    } else {
      seenFresh.push({ rn: rn, last: lv });
    }
  }

  seenOld.sort(function(a,b){ return a.last - b.last; });
  seenFresh.sort(function(a,b){ return a.last - b.last; });

  var queue = [];
  var prev = mem.prevRoom || null;

  function pushSkippingPrev(list, pick) {
    for (var k=0; k<list.length; k++) {
      var name = pick ? pick(list[k]) : list[k];
      if (prev && name === prev && list.length > 1) continue;
      queue.push(name);
    }
  }

  // Prefer: never-seen -> old-seen (past delay) -> fresh-seen (within delay)
  pushSkippingPrev(never);
  pushSkippingPrev(seenOld, function(x){return x.rn;});
  pushSkippingPrev(seenFresh, function(x){return x.rn;});

  mem.queue = queue;
}

function ensureScoutMem(creep) {
  if (!creep.memory.scout) creep.memory.scout = {};
  var m = creep.memory.scout;

  if (!m.home) {
    var spawns = Object.keys(Game.spawns).map(function(k){ return Game.spawns[k]; });
    if (spawns.length) {
      var best = spawns[0];
      var bestD = Game.map.getRoomLinearDistance(creep.pos.roomName, best.pos.roomName);
      for (var i = 1; i < spawns.length; i++) {
        var s = spawns[i];
        var d = Game.map.getRoomLinearDistance(creep.pos.roomName, s.pos.roomName);
        if (d < bestD) { best = s; bestD = d; }
      }
      m.home = best.pos.roomName;
    } else {
      m.home = creep.pos.roomName;
    }
  }

  if (!m.ring) m.ring = 1;
  if (!Array.isArray(m.queue)) m.queue = [];
  return m;
}

function go(creep, dest, opts={}) {
  if (typeof BeeToolbox !== 'undefined' && BeeToolbox.BeeTravel) {
    BeeToolbox.BeeTravel(creep, dest, opts);
    return;
  }
  const desired = opts.range != null ? opts.range : 1;
  if (creep.pos.getRangeTo(dest) > desired) {
    creep.moveTo(dest, { reusePath: 15 });
  }
}


function logRoomIntel(room) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
  var rmem = Memory.rooms[room.name];
  if (!rmem.intel) rmem.intel = {};
  var intel = rmem.intel;

  intel.lastVisited = Game.time;
  intel.sources = room.find(FIND_SOURCES).length;

  var hostiles = room.find(FIND_HOSTILE_CREEPS).length;
  var invader = room.find(FIND_HOSTILE_STRUCTURES, {filter:function(s){return s.structureType===STRUCTURE_INVADER_CORE;}}).length;
  intel.hostiles = hostiles;
  intel.invaderCore = invader > 0 ? Game.time : 0;

  var portals = room.find(FIND_STRUCTURES, {filter:function(s){return s.structureType===STRUCTURE_PORTAL;}})
    .map(function(p){
      return {
        x: p.pos.x,
        y: p.pos.y,
        toRoom: (p.destination && p.destination.roomName) || null,
        toShard: (p.destination && p.destination.shard) || null,
        decay: (typeof p.ticksToDecay !== 'undefined' ? p.ticksToDecay : null)
      };
    });
  intel.portals = portals;

  var c = room.controller;
  if (c) {
    intel.owner = (c.owner && c.owner.username) || null;
    intel.reservation = (c.reservation && c.reservation.username) || null;
    intel.rcl = c.level || 0;
    intel.safeMode = c.safeMode || 0;
  }
}

// ---- Room name <-> coordinate helpers (ES5) ----
function parseRoomName(name) {
  // e.g. "W39S47"
  var m = /([WE])(\d+)([NS])(\d+)/.exec(name);
  if (!m) return null;
  var hx = m[1], vx = m[3];
  var x = parseInt(m[2], 10);
  var y = parseInt(m[4], 10);
  // east is +, west is -, south is +, north is -
  if (hx === 'W') x = -x;
  if (vx === 'N') y = -y;
  return { x: x, y: y };
}

function toRoomName(x, y) {
  var hx = x >= 0 ? 'E' : 'W';
  var vx = y >= 0 ? 'S' : 'N';
  var ax = Math.abs(x);
  var ay = Math.abs(y);
  return hx + ax + vx + ay;
}

// Generate a clockwise ring of rooms exactly at manhattan radius r around centerName
function coordinateRing(centerName, r) {
  var c = parseRoomName(centerName);
  if (!c || r < 1) return [];
  var out = [];
  var x, y;

  // Start at EAST edge (c.x + r, c.y), then walk clockwise around the rectangle perimeter
  // Segment 1: East -> South along y increasing
  x = c.x + r; y = c.y - (r - 1);
  for (; y <= c.y + r; y++) out.push(toRoomName(x, y));
  // Segment 2: South -> West along x decreasing
  y = c.y + r - 1; x = c.x + r - 1;
  for (; x >= c.x - r; x--) out.push(toRoomName(x, y));
  // Segment 3: West -> North along y decreasing
  x = c.x - r; y = c.y + r - 1;
  for (; y >= c.y - r; y--) out.push(toRoomName(x, y));
  // Segment 4: North -> East along x increasing
  y = c.y - r; x = c.x - r + 1;
  for (; x <= c.x + r; x++) out.push(toRoomName(x, y));

  // Dedup (corners can double-push if r==1 logic changes)
  var seen = {};
  var dedup = [];
  for (var i = 0; i < out.length; i++) {
    if (!seen[out[i]]) { seen[out[i]] = true; dedup.push(out[i]); }
  }
  return dedup;
}


const TaskScout = {
    isExitBlocked: function (creep, exitDir) {
      const edge = creep.room.find(exitDir);          // all edge tiles for that exit
      if (!edge || !edge.length) return true;         // treat as blocked if none
    
      // scan several samples across the edge instead of just one tile
      const samples = edge.length > 6
        ? [edge[1], edge[Math.floor(edge.length/3)], edge[Math.floor(2*edge.length/3)], edge[edge.length-2]]
        : edge;
    
      for (const p of samples) {
        // terrain at exits won’t be 'wall', but check structures/ramparts
        const structs = p.lookFor(LOOK_STRUCTURES);
        if (structs.some(s =>
          s.structureType === STRUCTURE_WALL ||
          (s.structureType === STRUCTURE_RAMPART && !s.isPublic && (!s.my))
        )) continue; // this sample spot is blocked, try next
    
        // this sample is passable → consider exit not blocked
        return false;
      }
      return true; // all sampled spots were blocked
    },

  run: function (creep) {
    const M = ensureScoutMem(creep);      // { home, ring, queue, lastRoom? }
    if (!creep.memory.lastRoom) creep.memory.lastRoom = creep.room.name;

    // Room entry: stamp intel + lastVisited
    if (creep.memory.lastRoom !== creep.room.name) {
      // store where we came from, then update
      if (!creep.memory.prevRoom) creep.memory.prevRoom = null;
      creep.memory.prevRoom = creep.memory.lastRoom;
      creep.memory.lastRoom = creep.room.name;
      creep.memory.hasAnnouncedRoomVisit = false;
      M.prevRoom = creep.memory.prevRoom || null;

      // log intel + visit stamp
      stampVisit(creep.room.name);
      logRoomIntel(creep.room);

      // Only clear target if we actually arrived at it.
      // If we're transiting through another room (e.g., via home), keep the target.
      if (creep.memory.targetRoom === creep.room.name) {
        creep.memory.targetRoom = null;
        return; // pause 1 tick on arrival to avoid immediate bounce
      }
      // else: keep the target and continue to the rally block
    } else {
      stampVisit(creep.room.name);
      logRoomIntel(creep.room);
    }

    // If we have a target and we're not there yet, go there
    if (creep.memory.targetRoom && creep.room.name !== creep.memory.targetRoom) {
      const dir = creep.room.findExitTo(creep.memory.targetRoom);
      if (dir < 0) { // no path (novice border / map edge)
      // mark it blocked
      if (!Memory.rooms) Memory.rooms = {};
      if (!Memory.rooms[creep.memory.targetRoom]) Memory.rooms[creep.memory.targetRoom] = {};
      Memory.rooms[creep.memory.targetRoom].blocked = Game.time;

      // unconditionally drop this target and pick another next tick
      creep.memory.targetRoom = null;
      return;

      } else {
        if (TaskScout.isExitBlocked(creep, dir)) {
        // mark it blocked
        if (!Memory.rooms) Memory.rooms = {};
        if (!Memory.rooms[creep.memory.targetRoom]) Memory.rooms[creep.memory.targetRoom] = {};
        Memory.rooms[creep.memory.targetRoom].blocked = Game.time;

        // unconditionally drop this target and pick another next tick
        creep.memory.targetRoom = null;
        return;

        } else {
          if (creep.pos.x === 0 && dir === FIND_EXIT_LEFT)   { creep.move(LEFT);  return; }
          if (creep.pos.x === 49 && dir === FIND_EXIT_RIGHT) { creep.move(RIGHT); return; }
          if (creep.pos.y === 0 && dir === FIND_EXIT_TOP)    { creep.move(TOP);   return; }
          if (creep.pos.y === 49 && dir === FIND_EXIT_BOTTOM){ creep.move(BOTTOM);return; }

          // otherwise, path *through* the border by aiming at the center of the target room
          go(creep, new RoomPosition(25, 25, creep.memory.targetRoom), { range: 20 });
          return;
        }
      }
    }

    // We’re in targetRoom or have none — pick next from ring queue
    if (!M.queue.length) {
      rebuildQueue(M); // fill for current ring
      if (!M.queue.length) {
        M.ring = (M.ring && M.ring < RING_MAX) ? M.ring + 1 : 1; // wrap to 1
        rebuildQueue(M);
        if (!M.queue.length) {
          const fallback = exitsOrdered(creep.room.name).filter(okRoomName);
          M.queue = fallback;
        }
      }
    }

    // Pop next target (avoid immediate backtrack to lastRoom if possible)
    // Pop next target (avoid immediate backtrack to the room we just left)
    while (M.queue.length) {
      const next = M.queue.shift();
      if (!okRoomName(next) || isBlockedRecently(next)) continue;
      if (next === (M.prevRoom || null) && M.queue.length) continue; // skip bounce
      creep.memory.targetRoom = next;
      creep.memory.hasAnnouncedRoomVisit = false;
      break;
    }

    // If we still don’t have a target, idle near center and try again next tick
    if (!creep.memory.targetRoom) {
      go(creep, new RoomPosition(25, 25, creep.room.name), { range: 10 });
      return;
    }

    // If already in the target (edge case), clear and pick the next one
    if (creep.room.name === creep.memory.targetRoom) {
      creep.memory.targetRoom = null;
      return;
    }

    // Move toward center of target room (simple rally)
    go(creep, new RoomPosition(25, 25, creep.memory.targetRoom), { range: 20 });
  }
};

module.exports = TaskScout;













// role.TaskBuilder.js (refactor, ES5-safe, API-compatible)
// - Same export/entry: TaskBuilder.run(creep)
// - Fixes:
//   * ES5 only (no const/let/arrows/Object.values/default params).
//   * structureLimits/siteWeights use STRING KEYS ('tower','extension',...) so lookups work.
//   * Global site planner throttled, RCL-aware, terrain-safe.
//   * Cross-room refuel kept, movement unified via go() using BeeTravel if present.

var BeeToolbox = require('BeeToolbox');

// -----------------------------
// Small helpers (ES5-safe)
// -----------------------------
function ensureHome(creep) {
  if (creep.memory.home) return creep.memory.home;

  // pick closest owned spawn by room distance; fallback to current room
  var spawnKeys = Object.keys(Game.spawns);
  if (spawnKeys.length) {
    var best = Game.spawns[spawnKeys[0]];
    var bestDist = Game.map.getRoomLinearDistance(creep.pos.roomName, best.pos.roomName);
    for (var i = 1; i < spawnKeys.length; i++) {
      var sp = Game.spawns[spawnKeys[i]];
      var d = Game.map.getRoomLinearDistance(creep.pos.roomName, sp.pos.roomName);
      if (d < bestDist) { best = sp; bestDist = d; }
    }
    creep.memory.home = best.pos.roomName;
  } else {
    creep.memory.home = creep.pos.roomName;
  }
  return creep.memory.home;
}

function getHomeAnchorPos(homeName) {
  var room = Game.rooms[homeName];
  if (room) {
    if (room.storage) return room.storage.pos;
    var spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length) return spawns[0].pos;
    if (room.controller && room.controller.my) return room.controller.pos;
  }
  return new RoomPosition(25, 25, homeName);
}

function findWithdrawTargetInRoom(room) {
  if (!room) return null;
  var targets = room.find(FIND_STRUCTURES, {
    filter: function(s) {
      return s.store &&
             s.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
             (s.structureType === STRUCTURE_STORAGE  ||
              s.structureType === STRUCTURE_TERMINAL ||
              s.structureType === STRUCTURE_LINK     ||
              s.structureType === STRUCTURE_CONTAINER);
    }
  });
  if (!targets.length) return null;
  targets.sort(function(a, b) {
    return (b.store.getUsedCapacity(RESOURCE_ENERGY) - a.store.getUsedCapacity(RESOURCE_ENERGY));
  });
  return targets[0];
}

function go(creep, dest, opts) {
  opts = opts || {};
  var range = (opts.range != null) ? opts.range : 1;
  if (BeeToolbox && BeeToolbox.BeeTravel) {
    BeeToolbox.BeeTravel(creep, dest, { range: range, reusePath: 20 });
  } else if (creep.pos.getRangeTo(dest) > range) {
    creep.moveTo(dest, { reusePath: 20 });
  }
}

// -----------------------------
// TaskBuilder module
// -----------------------------
var TaskBuilder = {
  // IMPORTANT: string keys match a.structureType values
  structureLimits: {
    'tower':     6,
    'extension': 60,
    'container': 1,
    'rampart':   2,
    'road':      20
  },

  siteWeights: {
    'tower':     5,
    'container': 4,
    'extension': 3,
    'rampart':   2,
    'road':      1
  },

  // Preplanned placements (relative to first spawn). Uses CONSTANT values for type.
  structurePlacements: [
    { type: STRUCTURE_STORAGE,   x:  8, y:  0 },
    { type: STRUCTURE_SPAWN,     x: -5, y:  0 },
    { type: STRUCTURE_SPAWN,     x:  5, y:  0 },

    { type: STRUCTURE_EXTENSION, x:  0, y:  2 },
    { type: STRUCTURE_EXTENSION, x:  0, y: -2 },
    { type: STRUCTURE_EXTENSION, x:  0, y:  3 },
    { type: STRUCTURE_EXTENSION, x:  0, y: -3 },
    { type: STRUCTURE_EXTENSION, x: -1, y:  3 },
    { type: STRUCTURE_EXTENSION, x: -1, y: -3 },
    { type: STRUCTURE_EXTENSION, x:  1, y: -3 },
    { type: STRUCTURE_EXTENSION, x:  1, y:  3 },
    { type: STRUCTURE_EXTENSION, x: -1, y:  2 },
    { type: STRUCTURE_EXTENSION, x: -1, y: -2 },
    { type: STRUCTURE_EXTENSION, x:  1, y:  2 },
    { type: STRUCTURE_EXTENSION, x:  1, y: -2 },
    { type: STRUCTURE_EXTENSION, x: -2, y: -1 },
    { type: STRUCTURE_EXTENSION, x: -2, y:  1 },
    { type: STRUCTURE_EXTENSION, x:  2, y: -1 },
    { type: STRUCTURE_EXTENSION, x:  2, y:  1 },
    { type: STRUCTURE_EXTENSION, x: -3, y:  1 },
    { type: STRUCTURE_EXTENSION, x: -3, y: -1 },
    { type: STRUCTURE_EXTENSION, x:  3, y:  1 },
    { type: STRUCTURE_EXTENSION, x:  3, y: -1 },
    { type: STRUCTURE_EXTENSION, x: -3, y:  2 },
    { type: STRUCTURE_EXTENSION, x: -3, y: -2 },
    { type: STRUCTURE_EXTENSION, x:  3, y:  2 },
    { type: STRUCTURE_EXTENSION, x:  3, y: -2 },
    { type: STRUCTURE_EXTENSION, x: -4, y:  2 },
    { type: STRUCTURE_EXTENSION, x: -4, y: -2 },
    { type: STRUCTURE_EXTENSION, x:  4, y:  2 },
    { type: STRUCTURE_EXTENSION, x:  4, y: -2 },
    { type: STRUCTURE_EXTENSION, x:  4, y:  3 },
    { type: STRUCTURE_EXTENSION, x:  4, y: -3 },
    { type: STRUCTURE_EXTENSION, x: -4, y:  3 },
    { type: STRUCTURE_EXTENSION, x: -4, y: -3 },
    { type: STRUCTURE_EXTENSION, x: -4, y:  4 },
    { type: STRUCTURE_EXTENSION, x: -4, y: -4 },
    { type: STRUCTURE_EXTENSION, x:  4, y:  4 },
    { type: STRUCTURE_EXTENSION, x:  4, y: -4 },
    { type: STRUCTURE_EXTENSION, x:  3, y:  4 },
    { type: STRUCTURE_EXTENSION, x:  3, y: -4 },
    { type: STRUCTURE_EXTENSION, x: -3, y:  4 },
    { type: STRUCTURE_EXTENSION, x: -3, y: -4 },
    { type: STRUCTURE_EXTENSION, x: -2, y:  4 },
    { type: STRUCTURE_EXTENSION, x: -2, y: -4 },
    { type: STRUCTURE_EXTENSION, x:  2, y:  4 },
    { type: STRUCTURE_EXTENSION, x:  2, y: -4 },
    { type: STRUCTURE_EXTENSION, x:  2, y:  5 },
    { type: STRUCTURE_EXTENSION, x:  2, y: -5 },
    { type: STRUCTURE_EXTENSION, x: -2, y: -5 },
    { type: STRUCTURE_EXTENSION, x: -2, y:  5 },
    { type: STRUCTURE_EXTENSION, x: -1, y: -5 },
    { type: STRUCTURE_EXTENSION, x: -1, y:  5 },
    { type: STRUCTURE_EXTENSION, x:  1, y:  5 },
    { type: STRUCTURE_EXTENSION, x:  1, y: -5 },
    { type: STRUCTURE_EXTENSION, x:  0, y:  5 },
    { type: STRUCTURE_EXTENSION, x:  0, y: -5 },
    { type: STRUCTURE_EXTENSION, x: -4, y:  0 },
    { type: STRUCTURE_EXTENSION, x:  4, y:  0 },
    { type: STRUCTURE_EXTENSION, x: -5, y:  1 },
    { type: STRUCTURE_EXTENSION, x: -5, y: -1 },
    { type: STRUCTURE_EXTENSION, x:  5, y:  1 },
    { type: STRUCTURE_EXTENSION, x:  5, y: -1 },

    // Roads
    { type: STRUCTURE_ROAD, x:  1, y:  1 },
    { type: STRUCTURE_ROAD, x:  0, y:  1 },
    { type: STRUCTURE_ROAD, x: -1, y:  1 },
    { type: STRUCTURE_ROAD, x: -1, y:  0 },
    { type: STRUCTURE_ROAD, x: -1, y: -1 },
    { type: STRUCTURE_ROAD, x:  0, y: -1 },
    { type: STRUCTURE_ROAD, x:  1, y: -1 },
    { type: STRUCTURE_ROAD, x:  1, y:  0 },
    { type: STRUCTURE_ROAD, x:  2, y:  0 },
    { type: STRUCTURE_ROAD, x:  3, y:  0 },
    { type: STRUCTURE_ROAD, x: -2, y:  0 },
    { type: STRUCTURE_ROAD, x: -3, y:  0 },
    { type: STRUCTURE_ROAD, x: -4, y:  1 },
    { type: STRUCTURE_ROAD, x: -4, y: -1 },
    { type: STRUCTURE_ROAD, x:  4, y: -1 },
    { type: STRUCTURE_ROAD, x:  4, y:  1 },
    { type: STRUCTURE_ROAD, x:  2, y:  2 },
    { type: STRUCTURE_ROAD, x:  2, y: -2 },
    { type: STRUCTURE_ROAD, x:  3, y: -3 },
    { type: STRUCTURE_ROAD, x:  3, y:  3 },
    { type: STRUCTURE_ROAD, x: -2, y:  2 },
    { type: STRUCTURE_ROAD, x: -2, y: -2 },
    { type: STRUCTURE_ROAD, x: -3, y: -3 },
    { type: STRUCTURE_ROAD, x: -3, y:  3 },
    { type: STRUCTURE_ROAD, x: -2, y:  3 },
    { type: STRUCTURE_ROAD, x:  2, y:  3 },
    { type: STRUCTURE_ROAD, x: -2, y: -3 },
    { type: STRUCTURE_ROAD, x:  2, y: -3 },
    { type: STRUCTURE_ROAD, x: -1, y:  4 },
    { type: STRUCTURE_ROAD, x:  1, y:  4 },
    { type: STRUCTURE_ROAD, x: -1, y: -4 },
    { type: STRUCTURE_ROAD, x:  1, y: -4 },
    { type: STRUCTURE_ROAD, x:  0, y:  4 },
    { type: STRUCTURE_ROAD, x:  0, y: -4 }
  ],

  run: function (creep) {
    // Toggle build state
    if (creep.memory.building && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.building = false;
    }
    if (!creep.memory.building && creep.store.getFreeCapacity() === 0) {
      creep.memory.building = true;
    }

    if (creep.memory.building) {
      // ---- BUILD PHASE ----
      // Gather all construction sites across Game (ES5-safe)
      var allSites = [];
      for (var id in Game.constructionSites) allSites.push(Game.constructionSites[id]);

      // Fallback to current room if global is empty (rare)
      if (!allSites.length) {
        allSites = creep.room.find(FIND_MY_CONSTRUCTION_SITES);
      }

      if (allSites.length) {
        // Choose anchor: storage > first spawn > self
        var home = creep.room;
        var spawns = home.find(FIND_MY_SPAWNS);
        var anchor = (home.storage && home.storage.pos) || (spawns[0] && spawns[0].pos) || creep.pos;

        // Sorting:
        // 1) by siteWeights (higher first)
        // 2) by linear room distance from anchor.roomName (nearer rooms first)
        // 3) by range to anchor inside same room
        var weights = TaskBuilder.siteWeights;
        allSites.sort(function(a, b) {
          var wa = (weights && weights[a.structureType]) || 0;
          var wb = (weights && weights[b.structureType]) || 0;
          if (wb !== wa) return wb - wa;

          var ra = Game.map.getRoomLinearDistance(anchor.roomName, a.pos.roomName);
          var rb = Game.map.getRoomLinearDistance(anchor.roomName, b.pos.roomName);
          if (ra !== rb) return ra - rb;

          var da = (a.pos.roomName === anchor.roomName) ? anchor.getRangeTo(a.pos) : 999;
          var db = (b.pos.roomName === anchor.roomName) ? anchor.getRangeTo(b.pos) : 999;
          return da - db;
        });

        if (creep.build(allSites[0]) === ERR_NOT_IN_RANGE) {
          go(creep, allSites[0], { range: 3 });
        }
        return;
      } else {
        // No sites anywhere → dump energy if any, then recycle (or suicide if no spawn)
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
          var sink = creep.pos.findClosestByPath(FIND_STRUCTURES, {
            filter: function(s) {
              if (!s.store || s.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return false;
              // Prefer storage/terminal > spawn/ext/tower > container/link
              return (s.structureType === STRUCTURE_STORAGE  ||
                      s.structureType === STRUCTURE_TERMINAL ||
                      s.structureType === STRUCTURE_SPAWN    ||
                      s.structureType === STRUCTURE_EXTENSION||
                      s.structureType === STRUCTURE_TOWER    ||
                      s.structureType === STRUCTURE_CONTAINER||
                      s.structureType === STRUCTURE_LINK);
            }
          });
          if (sink) {
            if (creep.transfer(sink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
              go(creep, sink, { range: 1 });
            }
            return; // try recycle next tick once empty
          }
        }

        var spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
        if (spawn) {
          if (creep.pos.getRangeTo(spawn) > 1) {
            go(creep, spawn, { range: 1 });
          } else {
            spawn.recycleCreep(creep);
          }
          return;
        }

        // Absolute edge-case fallback
        creep.suicide();
        return;
      }
    } else {
      // ---- REFUEL PHASE ----
      var homeName = ensureHome(creep);

      // 1) Try current room
      var src = findWithdrawTargetInRoom(creep.room);
      if (src) {
        var r1 = creep.withdraw(src, RESOURCE_ENERGY);
        if (r1 === ERR_NOT_IN_RANGE) go(creep, src, { range: 1 });
        return;
      }

      // 2) Head home if not there
      if (creep.pos.roomName !== homeName) {
        go(creep, getHomeAnchorPos(homeName), { range: 1 });
        return;
      }

      // 3) Try again with home vision
      src = findWithdrawTargetInRoom(creep.room);
      if (src) {
        var r2 = creep.withdraw(src, RESOURCE_ENERGY);
        if (r2 === ERR_NOT_IN_RANGE) go(creep, src, { range: 1 });
        return;
      }

      // 4) Last resort: harvest so we don’t stall
      var source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
      if (source) {
        var r3 = creep.harvest(source);
        if (r3 === ERR_NOT_IN_RANGE) go(creep, source);
        return;
      }

      // 5) Truly nothing? Idle at anchor
      go(creep, getHomeAnchorPos(homeName), { range: 2 });
      return;
    }
  },

  // (Optional utility) Upgrade when appropriate (kept from your original)
  upgradeController: function (creep) {
    var controller = creep.room.controller;
    if (!controller) return;
    if (controller.level === 8 && controller.ticksToDowngrade > 180000) return;
    if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
      go(creep, controller, { range: 3 });
    }
  },

  // Place your predefined blueprint relative to the first spawn
  buildPredefinedStructures: function (creep) {
    var spawns = creep.room.find(FIND_MY_SPAWNS);
    if (!spawns.length) return;
    var base = spawns[0].pos;

    for (var i = 0; i < TaskBuilder.structurePlacements.length; i++) {
      var placement = TaskBuilder.structurePlacements[i];
      var tx = base.x + placement.x;
      var ty = base.y + placement.y;
      if (tx < 0 || tx > 49 || ty < 0 || ty > 49) continue;

      var targetPosition = new RoomPosition(tx, ty, base.roomName);

      if (targetPosition.lookFor(LOOK_STRUCTURES).length > 0) continue;
      if (targetPosition.lookFor(LOOK_CONSTRUCTION_SITES).length > 0) continue;

      TaskBuilder.buildStructures(creep, targetPosition, placement.type);
    }
  },

  buildStructures: function (creep, targetPosition, structureType) {
    // Respect both soft limits and RCL limits
    var softLimit = TaskBuilder.structureLimits[structureType] != null ? TaskBuilder.structureLimits[structureType] : Infinity;
    var rcl = creep.room.controller ? creep.room.controller.level : 0;
    var rclLimit = (CONTROLLER_STRUCTURES[structureType] && CONTROLLER_STRUCTURES[structureType][rcl] != null)
                    ? CONTROLLER_STRUCTURES[structureType][rcl]
                    : Infinity;
    var allowed = Math.min(softLimit, rclLimit);

    if (TaskBuilder.countStructures(creep.room, structureType) >= allowed) return;

    creep.room.createConstructionSite(targetPosition, structureType);
  },

  countStructures: function (room, structureType) {
    var built = room.find(FIND_STRUCTURES, { filter: { structureType: structureType } }).length;
    var sites = room.find(FIND_CONSTRUCTION_SITES, { filter: { structureType: structureType } }).length;
    return built + sites;
  },

  // Plan construction sites periodically (no Builder required)
  ensureSites: function(room) {
    if (!room || !room.controller || !room.controller.my) return;

    var spawns = room.find(FIND_MY_SPAWNS);
    if (!spawns.length) return;
    var center = spawns[0].pos;

    var MAX_SITES_PER_TICK = 5;
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
    var mem = Memory.rooms[room.name];

    var next = mem.nextPlanTick || 0;
    if (Game.time < next) return;

    var placed = 0;

    for (var i = 0; i < TaskBuilder.structurePlacements.length; i++) {
      if (placed >= MAX_SITES_PER_TICK) break;

      var p = TaskBuilder.structurePlacements[i];
      var tx = center.x + p.x, ty = center.y + p.y;
      if (tx < 0 || tx > 49 || ty < 0 || ty > 49) continue;

      var target = new RoomPosition(tx, ty, room.name);

      if (target.lookFor(LOOK_STRUCTURES).length > 0) continue;
      if (target.lookFor(LOOK_CONSTRUCTION_SITES).length > 0) continue;

      var rcl = room.controller.level;
      var rclLimit = (CONTROLLER_STRUCTURES[p.type] && CONTROLLER_STRUCTURES[p.type][rcl] != null)
                      ? CONTROLLER_STRUCTURES[p.type][rcl]
                      : Infinity;
      var softLimit = (TaskBuilder.structureLimits && TaskBuilder.structureLimits[p.type] != null)
                      ? TaskBuilder.structureLimits[p.type]
                      : Infinity;
      var allowed = Math.min(rclLimit, softLimit);

      var have = TaskBuilder.countStructures(room, p.type);
      if (have >= allowed) continue;

      var terr = room.getTerrain().get(target.x, target.y);
      if (terr === TERRAIN_MASK_WALL) continue;

      var res = room.createConstructionSite(target, p.type);
      if (res === OK) placed++;
    }

    mem.nextPlanTick = Game.time + (placed ? 10 : 25);
  }
};

module.exports = TaskBuilder;
