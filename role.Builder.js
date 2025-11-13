// role.Builder.js — migrated from Task.Builder (with Debug_say & Debug_draw, ES5-safe)
var BeeToolbox = require('BeeToolbox');
try { require('Traveler'); } catch (e) {} // use if available

// ==============================
// Debug UI toggles & styling
// ==============================
var CFG = Object.freeze({
  DEBUG_SAY: false,   // creep.say breadcrumbs
  DEBUG_DRAW: true,  // RoomVisual lines/labels
  DRAW: {
    TRAVEL_COLOR:  "#8ab6ff",
    PICKUP_COLOR:  "#ffe66e",
    WITHDRAW_COLOR:"#ffd16e",
    TOMBSTONE_COLOR:"#e6a6ff",
    RUIN_COLOR:    "#c6b3ff",
    SRC_CONT_COLOR:"#ffa36e",
    STORELIKE_COLOR:"#6ee7ff",
    BUILD_COLOR:   "#e6c16e",
    SINK_COLOR:    "#6effa1",
    IDLE_COLOR:    "#bfbfbf",
    WIDTH: 0.12,
    OPACITY: 0.45,
    FONT: 0.6
  }
});

// ==============================
// Tunables
// ==============================
var ALLOW_HARVEST_FALLBACK = false; // flip true if you really want last-resort mining
var PICKUP_MIN = 50;                // ignore tiny crumbs
var SRC_CONTAINER_MIN = 100;        // minimum energy to bother at source containers

// ==============================
// Debug helpers
// ==============================
function debugSay(creep, msg) {
  if (CFG.DEBUG_SAY && creep && msg) creep.say(msg, true);
}
function _posOf(target) {
  if (!target) return null;
  if (target.pos) return target.pos;
  if (target.x != null && target.y != null && target.roomName) return target;
  return null;
}
function debugDraw(creep, target, color, label) {
  if (!CFG.DEBUG_DRAW || !creep || !target) return;
  var room = creep.room; if (!room || !room.visual) return;
  var tpos = _posOf(target); if (!tpos || tpos.roomName !== room.name) return;

  try {
    room.visual.line(creep.pos, tpos, {
      color: color,
      width: CFG.DRAW.WIDTH,
      opacity: CFG.DRAW.OPACITY,
      lineStyle: "solid"
    });
    if (label) {
      room.visual.text(label, tpos.x, tpos.y - 0.3, {
        color: color,
        opacity: CFG.DRAW.OPACITY,
        font: CFG.DRAW.FONT,
        align: "center"
      });
    }
  } catch (e) {}
}
function debugRing(room, pos, color, text) {
  if (!CFG.DEBUG_DRAW || !room || !room.visual || !pos) return;
  try {
    room.visual.circle(pos, { radius: 0.5, fill: "transparent", stroke: color, opacity: CFG.DRAW.OPACITY, width: CFG.DRAW.WIDTH });
    if (text) room.visual.text(text, pos.x, pos.y - 0.6, { color: color, font: CFG.DRAW.FONT, opacity: CFG.DRAW.OPACITY, align: "center" });
  } catch (e) {}
}

// ==============================
// Tiny movement helper
// ==============================
function go(creep, dest, range, reuse) {
  range = (range != null) ? range : 1;
  reuse = (reuse != null) ? reuse : 25;

  var dpos = (dest && dest.pos) ? dest.pos : dest;
  if (dpos) debugDraw(creep, dpos, CFG.DRAW.TRAVEL_COLOR, "GO");

  try {
    if (BeeToolbox && BeeToolbox.BeeTravel) {
      BeeToolbox.BeeTravel(creep, (dest.pos || dest), { range: range, reusePath: reuse });
      return;
    }
    if (typeof creep.travelTo === 'function') {
      creep.travelTo((dest.pos || dest), { range: range, reusePath: reuse, ignoreCreeps: false, maxOps: 4000 });
      return;
    }
  } catch (e) {}
  if (creep.pos.getRangeTo(dest) > range) creep.moveTo(dest, { reusePath: reuse, maxOps: 1500 });
}

// ==============================
// Energy intake (prefer floor snacks)
// ==============================
function collectEnergy(creep) {
  // 1) Tombstones / Ruins
  var tomb = creep.pos.findClosestByRange(FIND_TOMBSTONES, { filter: function (t) { return (t.store[RESOURCE_ENERGY] | 0) > 0; } });
  if (tomb) {
    debugSay(creep, '🪦');
    debugDraw(creep, tomb, CFG.DRAW.TOMBSTONE_COLOR, "TOMB");
    var tr = creep.withdraw(tomb, RESOURCE_ENERGY);
    if (tr === ERR_NOT_IN_RANGE) go(creep, tomb, 1, 20);
    return true;
  }
  var ruin = creep.pos.findClosestByRange(FIND_RUINS, { filter: function (r) { return (r.store[RESOURCE_ENERGY] | 0) > 0; } });
  if (ruin) {
    debugSay(creep, '🏚️');
    debugDraw(creep, ruin, CFG.DRAW.RUIN_COLOR, "RUIN");
    var rr = creep.withdraw(ruin, RESOURCE_ENERGY);
    if (rr === ERR_NOT_IN_RANGE) go(creep, ruin, 1, 20);
    return true;
  }

  // 2) Dropped
  var dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
    filter: function (r) { return r.resourceType === RESOURCE_ENERGY && (r.amount | 0) >= PICKUP_MIN; }
  });
  if (dropped) {
    debugSay(creep, '🍪');
    debugDraw(creep, dropped, CFG.DRAW.PICKUP_COLOR, "DROP");
    if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) go(creep, dropped, 1, 15);
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
    debugDraw(creep, srcCont, CFG.DRAW.SRC_CONT_COLOR, "SRC•CONT");
    var cr = creep.withdraw(srcCont, RESOURCE_ENERGY);
    if (cr === ERR_NOT_IN_RANGE) go(creep, srcCont, 1, 25);
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
    debugDraw(creep, storeLike, CFG.DRAW.STORELIKE_COLOR, "WITHDRAW");
    var sr = creep.withdraw(storeLike, RESOURCE_ENERGY);
    if (sr === ERR_NOT_IN_RANGE) go(creep, storeLike, 1, 25);
    return true;
  }

  // 5) Optional last resort: harvest
  if (ALLOW_HARVEST_FALLBACK) {
    var src = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
    if (src) {
      debugSay(creep, '⛏️');
      debugDraw(creep, src, CFG.DRAW.SRC_CONT_COLOR, "MINE");
      var hr = creep.harvest(src);
      if (hr === ERR_NOT_IN_RANGE) go(creep, src, 1, 20);
      return true;
    }
  }

  // Idle near something useful
  var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS) || creep.pos;
  if (anchor && anchor.pos) {
    debugSay(creep, '🧘');
    debugDraw(creep, anchor, CFG.DRAW.IDLE_COLOR, "IDLE");
    go(creep, anchor, 2, 20);
  }
  return false;
}

function toggleBuilderState(creep) {
  if (creep.memory.building && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.building = false;
    debugSay(creep, '⤵️REFUEL');
  }
  if (!creep.memory.building && creep.store.getFreeCapacity() === 0) {
    creep.memory.building = true;
    debugSay(creep, '⤴️BUILD');
  }
}

function idleNearAnchor(creep) {
  var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS) || creep.pos;
  if (anchor && anchor.pos) {
    debugSay(creep, '🧘');
    debugDraw(creep, anchor, CFG.DRAW.IDLE_COLOR, "IDLE");
    go(creep, anchor, 2, 20);
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
  debugDraw(creep, sink, CFG.DRAW.SINK_COLOR, "SINK");
  if (creep.transfer(sink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) go(creep, sink, 1, 20);
  return true;
}

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
    debugDraw(creep, site, CFG.DRAW.BUILD_COLOR, "BUILD");
    var r = creep.build(site);
    if (r === ERR_NOT_ENOUGH_RESOURCES) return false;
    if (r === ERR_INVALID_TARGET) { creep.memory.siteId = null; return false; }
    return true;
  }

  debugDraw(creep, site, CFG.DRAW.TRAVEL_COLOR, "TO•SITE");
  go(creep, site, 3, 15);
  return true;
}

// ==============================
// Public API
// ==============================
var roleBuilder = {
  role: 'Builder',
  run: function (creep) {
    toggleBuilderState(creep);

    if (creep.memory.building) {
      runBuildPhase(creep);
      return;
    }

    // Refuel phase (no mining unless allowed)
    collectEnergy(creep);
  }
};

module.exports = roleBuilder;
