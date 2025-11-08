var CFG = Object.freeze({
  maxSitesPerTick: 5,            // gentle drip; global cap is 100
  csiteSafetyLimit: 40,          // stop early if we’re near the global cap
  tickModulo: 2,                 // stagger planners across rooms; set to 1 to run every tick
  noPlacementCooldownPlaced: 4,  // ticks to wait after we successfully place >=1 site
  noPlacementCooldownNone: 10    // ticks to wait when nothing placed
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
    /*
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
     */
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

    // ============================================================
    // 1) PRIORITY: ensure ONE container near each owned-room source
    // ============================================================
    var delta = RoomPlanner._ensureSourceContainers(
      room, anchor, terrain, built, sites, allowed,
      CFG.maxSitesPerTick - placed,
      CFG.csiteSafetyLimit - cCount
    );
    placed += delta.placed;
    cCount += delta.placed; // one site per placement

    // Stop early if we hit limits during source-container placement
    if (placed >= CFG.maxSitesPerTick || cCount >= CFG.csiteSafetyLimit) {
      mem.nextPlanTick = Game.time + CFG.noPlacementCooldownPlaced;
      return;
    }

    // ============================================================
    // 2) BASE LAYOUT (existing behavior)
    // ============================================================
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

  /**
   * Place exactly one container per source in an owned room that has a spawn.
   * Updates Memory.rooms[roomName].sources[sourceId].container = {status, x, y, id/siteId}
   *
   * Status values:
   *  - "Good"    : container exists and is healthy
   *  - "Repair"  : container exists but is damaged (hits < 60% of max)
   *  - "Building": csite exists within range 1 of source
   *  - "Need"    : no container/csite; will attempt to place (respecting caps)
   */
  _ensureSourceContainers: function (room, anchor, terrain, built, sites, allowedFn, slotsLeft, globalCapLeft) {
    var placed = 0;

    if (!room) return { placed: 0 };
    if (!anchor) return { placed: 0 };

    // respect overall container cap for the room
    var haveContainers = (built[STRUCTURE_CONTAINER] | 0) + (sites[STRUCTURE_CONTAINER] | 0);
    var capContainers  = allowedFn(STRUCTURE_CONTAINER);
    if (haveContainers >= capContainers) return { placed: 0 };

    // ensure memory path exists
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
    if (!Memory.rooms[room.name].sources) Memory.rooms[room.name].sources = {};
    var sourcesMem = Memory.rooms[room.name].sources;

    // utility: check if tile is passable for a creep to stand (no walls/solid structs/sites)
    function isPassable(x, y) {
      if (x < 1 || x > 48 || y < 1 || y > 48) return false;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;

      var ss = room.lookForAt(LOOK_STRUCTURES, x, y);
      for (var i = 0; i < ss.length; i++) {
        var st = ss[i].structureType;
        // allow roads, containers, my ramparts; block others (walls, extensions, spawns, etc.)
        if (st === STRUCTURE_ROAD) continue;
        if (st === STRUCTURE_CONTAINER) continue;
        if (st === STRUCTURE_RAMPART && ss[i].my) continue;
        return false;
      }
      // also avoid placing where another site already sits
      if (room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length) return false;
      return true;
    }

    var sources = room.find(FIND_SOURCES);
    for (var s = 0; s < sources.length; s++) {
      var src = sources[s];
      var sid = src.id;
      if (!sourcesMem[sid]) sourcesMem[sid] = {};
      if (!sourcesMem[sid].container) sourcesMem[sid].container = {};
      var cmem = sourcesMem[sid].container;

      // 1) If a container already exists within 1, mark Good/Repair and record coords/id.
      var structs = src.pos.findInRange(FIND_STRUCTURES, 1, {
        filter: function (o) { return o.structureType === STRUCTURE_CONTAINER; }
      });
      if (structs.length) {
        var cont = structs[0];
        cmem.x = cont.pos.x; cmem.y = cont.pos.y; cmem.id = cont.id; cmem.siteId = undefined;
        var healthy = (cont.hits != null && cont.hitsMax != null) ? (cont.hits / cont.hitsMax) : 1;
        cmem.status = (healthy < 0.60) ? 'Repair' : 'Good';
        continue;
      }

      // 2) If a csite (container) already exists within 1, mark Building and record pos/siteId.
      var cs = src.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
        filter: function (c) { return c.structureType === STRUCTURE_CONTAINER; }
      });
      if (cs.length) {
        cmem.x = cs[0].pos.x; cmem.y = cs[0].pos.y; cmem.id = undefined; cmem.siteId = cs[0].id;
        cmem.status = 'Building';
        continue;
      }

      // 3) Otherwise we Need one. Try to place (respecting per-tick/global caps).
      cmem.status = 'Need';
      if (slotsLeft <= 0 || globalCapLeft <= 0) continue;
      if (haveContainers >= capContainers) continue;

      // Pick first good neighbor tile (8-neighborhood)
      var placedHere = false;
      for (var dx = -1; dx <= 1 && !placedHere; dx++) {
        for (var dy = -1; dy <= 1 && !placedHere; dy++) {
          if (dx === 0 && dy === 0) continue;
          var tx = src.pos.x + dx;
          var ty = src.pos.y + dy;
          if (!isPassable(tx, ty)) continue;

          // final safety: don't double-place if somehow occupied (already checked above)
          var rc = room.createConstructionSite(tx, ty, STRUCTURE_CONTAINER);
          if (rc === OK) {
            // record in memory
            cmem.x = tx; cmem.y = ty; cmem.id = undefined; cmem.status = 'Building';
            // try to fetch site id we just created (cheap local look)
            var lookup = room.lookForAt(LOOK_CONSTRUCTION_SITES, tx, ty);
            cmem.siteId = (lookup && lookup.length) ? lookup[0].id : undefined;

            // bump counters and caps
            placed += 1;
            slotsLeft -= 1;
            globalCapLeft -= 1;
            haveContainers += 1;
            sites[STRUCTURE_CONTAINER] = (sites[STRUCTURE_CONTAINER] | 0) + 1;

            // optional debug breadcrumb (comment out if noisy)
            // console.log('[Planner] placed container site near source', sid, 'at', room.name, tx + ',' + ty);

            placedHere = true;
          }
          // else: ERR_* -> ignore; try another neighbor
        }
      }
      // if we could not place at any neighbor, we keep status = 'Need' and try next tick
    }

    return { placed: placed };
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
