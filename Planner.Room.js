
var CFG = Object.freeze({
  maxSitesPerTick: 5,            // gentle drip; global cap is 100
  csiteSafetyLimit: 10,          // stop early if we’re near the global cap
  tickModulo: 5,                 // stagger planners across rooms; set to 1 to run every tick
  noPlacementCooldownPlaced: 10, // ticks to wait after we successfully place >=1 site
  noPlacementCooldownNone: 25    // ticks to wait when nothing placed
});

var RoomPlanner = {
  // Hard caps (upper bounds). Also clamped by CONTROLLER_STRUCTURES per RCL.
  structureLimits: (function () {
    var o = {};
    o[STRUCTURE_TOWER]     = 6;
    o[STRUCTURE_EXTENSION] = 60;
    o[STRUCTURE_CONTAINER] = 10;
    o[STRUCTURE_RAMPART]   = 2;
    o[STRUCTURE_ROAD]      = 150;
    return o;
  })(),

  BASE_OFFSETS: [
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

    // roads
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

  ensureSites: function (room) {
    if (!room || !room.controller || !room.controller.my) return;

    // stagger per room to flatten CPU spikes
    if (CFG.tickModulo > 1) {
      var h = 0, n = room.name;
      for (var iHash = 0; iHash < n.length; iHash++) h = (h * 31 + n.charCodeAt(iHash)) | 0;
      if (((Game.time + (h & 3)) % CFG.tickModulo) !== 0) return;
    }

    var mem = RoomPlanner._memory(room);
    if (mem.nextPlanTick && Game.time < mem.nextPlanTick) return;

    // anchor = first spawn (stable & cheap)
    var spawns = room.find(FIND_MY_SPAWNS);
    if (!spawns.length) return;
    var anchor = spawns[0].pos;

    // global csite count once, bail if near cap
    var globalCsiteCount = Object.keys(Game.constructionSites).length;
    if (globalCsiteCount >= CFG.csiteSafetyLimit) {
      mem.nextPlanTick = Game.time + CFG.noPlacementCooldownNone;
      return;
    }

    // pre-scan structures & sites once (CPU saver)
    var built = Object.create(null);
    var sites = Object.create(null);
    var terrain = room.getTerrain();

    var arrStructs = room.find(FIND_STRUCTURES);
    for (var i = 0; i < arrStructs.length; i++) {
      var stype = arrStructs[i].structureType;
      built[stype] = (built[stype] | 0) + 1;
    }

    var arrSites = room.find(FIND_CONSTRUCTION_SITES);
    for (var j = 0; j < arrSites.length; j++) {
      var sType = arrSites[j].structureType;
      sites[sType] = (sites[sType] | 0) + 1;
    }

    function allowed(type) {
      var hard = (RoomPlanner.structureLimits && RoomPlanner.structureLimits[type] !== undefined)
        ? RoomPlanner.structureLimits[type] : Infinity;
      var ctrl = Infinity;
      if (room.controller && typeof CONTROLLER_STRUCTURES !== 'undefined') {
        var table = CONTROLLER_STRUCTURES[type];
        if (table) {
          var lvl = room.controller.level | 0;
          ctrl = (table[lvl] != null) ? table[lvl] : 0;
        } else {
          ctrl = 0;
        }
      }
      return (hard < ctrl) ? hard : ctrl;
    }

    var placed = 0;
    var cCount = globalCsiteCount;

    function hasAnythingAt(x, y) {
      if (room.lookForAt(LOOK_STRUCTURES, x, y).length) return true;
      if (room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length) return true;
      return false;
    }

    for (var k = 0; k < RoomPlanner.BASE_OFFSETS.length; k++) {
      if (placed >= CFG.maxSitesPerTick) break;
      if (cCount >= CFG.csiteSafetyLimit) break;

      var p = RoomPlanner.BASE_OFFSETS[k];
      var tx = anchor.x + p.x;
      var ty = anchor.y + p.y;

      // bounds + terrain check (walls are out)
      if (tx < 1 || tx > 48 || ty < 1 || ty > 48) continue;
      if (terrain.get(tx, ty) === TERRAIN_MASK_WALL) continue;

      // skip if already occupied (built or site)
      if (hasAnythingAt(tx, ty)) continue;

      // respect limits now (built + sites < allowed)
      var t = p.type;
      var have = (built[t] | 0) + (sites[t] | 0);
      var cap = allowed(t);
      if (have >= cap) continue;

      // try to place (x,y,type) zero-allocation call
      var rc = room.createConstructionSite(tx, ty, t);
      if (rc === OK) {
        placed++;
        cCount++;
        sites[t] = (sites[t] | 0) + 1;
        if (cCount >= CFG.csiteSafetyLimit) break;
      }
      // else ignore errors; will retry on a later pass
    }

    mem.nextPlanTick = Game.time + (placed ? CFG.noPlacementCooldownPlaced : CFG.noPlacementCooldownNone);
  },

  // --- Helpers ---
  _memory: function (room) {
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
    if (!Memory.rooms[room.name].planner) Memory.rooms[room.name].planner = {};
    return Memory.rooms[room.name].planner;
  }
};

module.exports = RoomPlanner;
