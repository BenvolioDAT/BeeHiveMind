'use strict';

var BeeHelper = require('role.BeeHelper');
var CFG = BeeHelper.config;
var debugSay = BeeHelper.debugSay;
var debugDrawLine = BeeHelper.debugDrawLine;
var debugRing = BeeHelper.debugRing;

var roleBuilder = (function () {
  // -----------------------------
  // A) Config + state helpers
  // -----------------------------
  // ==============================
  // Tunables
  // ==============================
  var ALLOW_HARVEST_FALLBACK = true; // flip true if you really want last-resort mining
  var PICKUP_MIN = 50;                // ignore tiny crumbs
  var SRC_CONTAINER_MIN = 100;        // minimum energy to bother at source containers

  // ==============================
  // Tiny movement helper
  // ==============================
  // ==============================
  // Energy intake (prefer floor snacks)
  // ==============================
  function ensureBuilderIdentity(creep) {
    if (!creep || !creep.memory) return;
    creep.memory.role = 'Builder';
    if (!creep.memory.task) creep.memory.task = 'builder';
  }

  // Memory keys:
  // - siteId: sticky construction target we are working on

  function determineBuilderState(creep) {
    ensureBuilderIdentity(creep);
    if (creep.memory.building && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.building = false;
      debugSay(creep, '⤵️REFUEL');
    } else if (!creep.memory.building && creep.store.getFreeCapacity() === 0) {
      creep.memory.building = true;
      debugSay(creep, '⤴️BUILD');
    }
    creep.memory.state = creep.memory.building ? 'BUILD' : 'COLLECT';
    return creep.memory.state;
  }

  // -----------------------------
  // B) Energy collection helpers
  // -----------------------------
  function collectEnergy(creep) {
    // 1) Tombstones / Ruins
    var tomb = creep.pos.findClosestByRange(FIND_TOMBSTONES, { filter: function (t) { return (t.store[RESOURCE_ENERGY] | 0) > 0; } });
    if (tomb) {
      debugSay(creep, '🪦');
      debugDrawLine(creep, tomb, CFG.DRAW.TOMBSTONE_COLOR, "TOMB");
      var tr = creep.withdraw(tomb, RESOURCE_ENERGY);
      if (tr === ERR_NOT_IN_RANGE) {
        creep.travelTo(tomb, { range: 1, reusePath: 20 });
      }
      return true;
    }
    var ruin = creep.pos.findClosestByRange(FIND_RUINS, { filter: function (r) { return (r.store[RESOURCE_ENERGY] | 0) > 0; } });
    if (ruin) {
      debugSay(creep, '🏚️');
      debugDrawLine(creep, ruin, CFG.DRAW.RUIN_COLOR, "RUIN");
      var rr = creep.withdraw(ruin, RESOURCE_ENERGY);
      if (rr === ERR_NOT_IN_RANGE) {
        creep.travelTo(ruin, { range: 1, reusePath: 20 });
      }
      return true;
    }

    // 2) Dropped
    var dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
      filter: function (r) { return r.resourceType === RESOURCE_ENERGY && (r.amount | 0) >= PICKUP_MIN; }
    });
    if (dropped) {
      debugSay(creep, '🍪');
      debugDrawLine(creep, dropped, CFG.DRAW.PICKUP_COLOR, "DROP");
      if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
        creep.travelTo(dropped, { range: 1, reusePath: 15 });
      }
      return true;
    }

    // 3) Source-adjacent container
    var srcCont = creep.pos.findClosestByRange(FIND_STRUCTURES, {
      filter: function (s) {
        if (s.structureType !== STRUCTURE_CONTAINER || !s.store) return false;
        if (s.pos.findInRange(FIND_SOURCES, 1).length === 0) return false;
        return (s.store[RESOURCE_ENERGY] | 0) >= SRC_CONTAINER_MIN;
      }
    });
    if (srcCont) {
      debugSay(creep, '📦');
      debugDrawLine(creep, srcCont, CFG.DRAW.SRC_CONT_COLOR, "SRC•CONT");
      var cr = creep.withdraw(srcCont, RESOURCE_ENERGY);
      if (cr === ERR_NOT_IN_RANGE) {
        creep.travelTo(srcCont, { range: 1, reusePath: 25 });
      }
      return true;
    }

    // 4) Any store (container/link/storage/terminal)
    var storeLike = creep.pos.findClosestByRange(FIND_STRUCTURES, {
      filter: function (s) {
        if (!s.store) return false;
        var t = s.structureType;
        if (t !== STRUCTURE_CONTAINER && t !== STRUCTURE_LINK && t !== STRUCTURE_STORAGE && t !== STRUCTURE_TERMINAL) return false;
        return (s.store[RESOURCE_ENERGY] | 0) > 0;
      }
    });
    if (storeLike) {
      debugSay(creep, '🏦');
      debugDrawLine(creep, storeLike, CFG.DRAW.STORELIKE_COLOR, "WITHDRAW");
      var sr = creep.withdraw(storeLike, RESOURCE_ENERGY);
      if (sr === ERR_NOT_IN_RANGE) {
        creep.travelTo(storeLike, { range: 1, reusePath: 25 });
      }
      return true;
    }

    // 5) Optional last resort: harvest
    if (ALLOW_HARVEST_FALLBACK) {
      var src = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
      if (src) {
        debugSay(creep, '⛏️');
        debugDrawLine(creep, src, CFG.DRAW.SRC_CONT_COLOR, "MINE");
        var hr = creep.harvest(src);
        if (hr === ERR_NOT_IN_RANGE) {
          creep.travelTo(src, { range: 1, reusePath: 20 });
        }
        return true;
      }
    }

    // Idle near something useful
    var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS) || creep.pos;
    if (anchor && anchor.pos) {
      debugSay(creep, '🧘');
      debugDrawLine(creep, anchor, CFG.DRAW.IDLE_COLOR, "IDLE");
      creep.travelTo(anchor, { range: 2, reusePath: 20 });
    }
    return false;
  }

  function idleNearAnchor(creep) {
    var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS) || creep.pos;
    if (anchor && anchor.pos) {
      debugSay(creep, '🧘');
      debugDrawLine(creep, anchor, CFG.DRAW.IDLE_COLOR, "IDLE");
      creep.travelTo(anchor, { range: 2, reusePath: 20 });
    }
  }

  function dumpEnergyToSink(creep) {
    if ((creep.store[RESOURCE_ENERGY] | 0) <= 0) return false;
    var sink = creep.pos.findClosestByRange(FIND_STRUCTURES, {
      filter: function (s) {
        if (!s.store) return false;
        return (s.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0 &&
               (s.structureType === STRUCTURE_STORAGE   ||
                s.structureType === STRUCTURE_TERMINAL  ||
                s.structureType === STRUCTURE_SPAWN     ||
                s.structureType === STRUCTURE_EXTENSION ||
                s.structureType === STRUCTURE_TOWER     ||
                s.structureType === STRUCTURE_CONTAINER ||
                s.structureType === STRUCTURE_LINK);
      }
    });
    if (!sink) return false;
    debugSay(creep, '➡️SINK');
    debugDrawLine(creep, sink, CFG.DRAW.SINK_COLOR, "SINK");
    if (creep.transfer(sink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.travelTo(sink, { range: 1, reusePath: 20 });
    }
    return true;
  }

  // -----------------------------
  // C) Build phase helpers
  // -----------------------------
  function runBuildPhase(creep) {
    var site = pickBuildSite(creep);
    if (site) {
      if (doBuild(creep, site)) return;
      if ((creep.store[RESOURCE_ENERGY] | 0) === 0) creep.memory.building = false;
      else creep.memory.siteId = null;
      return;
    }

    if (dumpEnergyToSink(creep)) return;
    idleNearAnchor(creep);
  }

  // ==============================
  // Pick a build target (simple + sticky)
  // ==============================
  function pickBuildSite(creep) {
    // sticky
    var id = creep.memory.siteId;
    if (id) {
      var stick = Game.constructionSites[id];
      if (stick) {
        debugRing(creep.room, stick.pos, CFG.DRAW.BUILD_COLOR, "STICK");
        return stick;
      }
      creep.memory.siteId = null;
    }

    // prefer current room
    var local = creep.room.find(FIND_CONSTRUCTION_SITES);
    if (local.length) {
      // light priority: spawn/ext/tower first, else nearest
      var prio = { 'spawn': 5, 'extension': 4, 'tower': 3, 'container': 2, 'road': 1 };
      var best = null, bestScore = -1, bestD = 1e9;
      for (var i = 0; i < local.length; i++) {
        var s = local[i], sc = (prio[s.structureType] | 0), d = creep.pos.getRangeTo(s.pos);
        if (sc > bestScore || (sc === bestScore && d < bestD)) { best = s; bestScore = sc; bestD = d; }
      }
      if (best) {
        creep.memory.siteId = best.id;
        debugRing(creep.room, best.pos, CFG.DRAW.BUILD_COLOR, best.structureType.toUpperCase());
        return best;
      }
    }

    // otherwise, nearest room with a site (visible or not)
    var any = null, bestDist = 1e9;
    for (var sid in Game.constructionSites) {
      if (!Game.constructionSites.hasOwnProperty(sid)) continue;
      var s2 = Game.constructionSites[sid];
      var d2 = Game.map.getRoomLinearDistance(creep.pos.roomName, s2.pos.roomName);
      if (d2 < bestDist) { bestDist = d2; any = s2; }
    }
    if (any) { creep.memory.siteId = any.id; debugRing(creep.room, any.pos, CFG.DRAW.BUILD_COLOR, "NEAR"); return any; }

    return null;
  }

  // ==============================
  // Build work
  // ==============================
  function doBuild(creep, site) {
    if (!site) return false;

    if (creep.pos.inRangeTo(site.pos, 3)) {
      debugSay(creep, '🔨');
      debugDrawLine(creep, site, CFG.DRAW.BUILD_COLOR, "BUILD");
      var r = creep.build(site);
      if (r === ERR_NOT_ENOUGH_RESOURCES) return false;
      if (r === ERR_INVALID_TARGET) { creep.memory.siteId = null; return false; }
      return true;
    }

    debugDrawLine(creep, site, CFG.DRAW.TRAVEL_COLOR, "TO•SITE");
    creep.travelTo(site, { range: 3, reusePath: 15 });
    return true;
  }

  // ==============================
  // Public API
  // ==============================
  var roleBuilder = {
    role: 'Builder',
    run: function (creep) {
      var state = determineBuilderState(creep);

      if (state === 'BUILD') {
        runBuildPhase(creep);
        return;
      }

      collectEnergy(creep);
    }
  };

  return roleBuilder;
})();

module.exports = roleBuilder;
