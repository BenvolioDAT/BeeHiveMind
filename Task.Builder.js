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
