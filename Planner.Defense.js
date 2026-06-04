'use strict';

// -----------------------------------------------------------------------------
// Planner.Defense.js - safe, staged rampart planner for owned rooms
// Owns:
// * Memory.rooms[roomName].defense, including the cached rampart plan, build
//   cursor, plan cadence, and the staged repair target for planned ramparts.
// Usually called by:
// * BeeHiveMind.manageRoom(room), after the room and road planners have had a
//   chance to place their own sites.
// Design notes:
// * This module is intentionally conservative. It plans rarely, places only a
//   few sites at a time, and treats roads/logistics paths as gates unless there
//   is no better exit tile in that local stretch.
// * Ramparts on important structures are intentional. Ramparts on exit roads are
//   avoided unless every useful tile in that stretch is already road-like.
// -----------------------------------------------------------------------------

var CoreConfig = require('core.config');
var MemoryUtils = require('core.memory');
var CpuBudget = require('core.cpuBudget');

var PLAN_VERSION = 1;

function numberOr(value, fallback) {
  var n = Number(value);
  if (isNaN(n)) return fallback;
  return n;
}

function intAtLeast(value, fallback, min) {
  var n = Math.floor(numberOr(value, fallback));
  if (n < min) return min;
  return n;
}

function getRawSettings() {
  var settings = CoreConfig && CoreConfig.settings;
  return settings && settings.defensePlanner ? settings.defensePlanner : {};
}

function getConfig() {
  // Keep all knobs in one resolved object so the rest of the code reads like
  // decisions, not config plumbing.
  var s = getRawSettings();
  return {
    enabled: s.enabled !== false,
    minRcl: intAtLeast(s.minRcl, 2, 1),
    planRefreshTicks: intAtLeast(s.planRefreshTicks, 1500, 1),
    lowBucketPlanRefreshTicks: intAtLeast(s.lowBucketPlanRefreshTicks, 3000, 1),
    planningSkippedRetryTicks: intAtLeast(s.planningSkippedRetryTicks, 50, 1),
    minBucketForPlanning: intAtLeast(s.minBucketForPlanning, 1500, 0),
    maxCpuUsedBeforePlanning: intAtLeast(s.maxCpuUsedBeforePlanning, 16, 0),

    sitePlacementInterval: intAtLeast(s.sitePlacementInterval, 3, 1),
    maxSitesPerTick: intAtLeast(s.maxSitesPerTick, 2, 0),
    maxPlacementChecksPerTick: intAtLeast(s.maxPlacementChecksPerTick, 25, 1),
    roomSiteSafetyLimit: intAtLeast(s.roomSiteSafetyLimit, 40, 1),
    globalSiteSafetyLimit: intAtLeast(s.globalSiteSafetyLimit, 95, 1),

    controllerContainerRange: intAtLeast(s.controllerContainerRange, 3, 1),
    protectedLinkRange: intAtLeast(s.protectedLinkRange, 3, 1),

    exitInset: intAtLeast(s.exitInset, 2, 1),
    exitFullCoverMaxWidth: intAtLeast(s.exitFullCoverMaxWidth, 9, 1),
    exitMaxRampartsPerSegment: intAtLeast(s.exitMaxRampartsPerSegment, 8, 1),
    exitMaxRampartsPerRoom: intAtLeast(s.exitMaxRampartsPerRoom, 60, 0),
    exitGateMinWidth: intAtLeast(s.exitGateMinWidth, 4, 1),
    maxPlannedRoadTilesChecked: intAtLeast(s.maxPlannedRoadTilesChecked, 600, 0),

    debugVisuals: s.debugVisuals === true,
    debugVisualRoom: s.debugVisualRoom || null,
    debugVisualModulo: intAtLeast(s.debugVisualModulo, 1, 1)
  };
}

function keyFor(x, y) {
  return x + ':' + y;
}

function posKey(pos) {
  return keyFor(pos.x, pos.y);
}

function inBuildBounds(x, y) {
  // Avoid edge tiles. Exit ramparts are placed inward, and important structures
  // should never live directly on the room edge.
  return x >= 1 && x <= 48 && y >= 1 && y <= 48;
}

function getRcl(room) {
  return room && room.controller ? (room.controller.level || 0) : 0;
}

function isOwnedRoom(room) {
  return !!(room && room.controller && room.controller.my);
}

function getAllowedRamparts(room) {
  var rcl = getRcl(room);
  if (typeof CONTROLLER_STRUCTURES !== 'undefined' && CONTROLLER_STRUCTURES[STRUCTURE_RAMPART]) {
    return CONTROLLER_STRUCTURES[STRUCTURE_RAMPART][rcl] || 0;
  }
  return rcl >= 2 ? 300 : 0;
}

function canBuildRamparts(room, cfg) {
  if (!isOwnedRoom(room)) return false;
  if (getRcl(room) < cfg.minRcl) return false;
  return getAllowedRamparts(room) > 0;
}

function getRampartTargetHits(roomOrRcl) {
  // Public helper used by maintenance and Repair. It makes the target HP
  // configurable without coupling those systems to this module's build plan.
  var rcl;
  var s = getRawSettings();
  var byRcl = s.rampartHitsByRcl || {};

  if (typeof roomOrRcl === 'number') {
    rcl = roomOrRcl;
  } else {
    rcl = getRcl(roomOrRcl);
  }

  if (rcl <= 3) return numberOr(byRcl[String(rcl)], 10000);
  if (rcl <= 5) return numberOr(byRcl[String(rcl)], 50000);
  if (rcl <= 7) return numberOr(byRcl[String(rcl)], 250000);
  return numberOr(byRcl[String(rcl)], 1000000);
}

function getPlanInterval(cfg) {
  return CpuBudget.intervalByBucket(
    cfg.planRefreshTicks,
    cfg.lowBucketPlanRefreshTicks,
    cfg.minBucketForPlanning
  );
}

function getDefenseMemory(room) {
  return MemoryUtils.ensureRoomChild(room.name, 'defense');
}

function countGlobalConstructionSitesOnce() {
  if (!global.__BHM_DEFENSE) {
    global.__BHM_DEFENSE = { siteTick: -1, siteCount: 0 };
  }
  if (global.__BHM_DEFENSE.siteTick === Game.time) return global.__BHM_DEFENSE.siteCount;
  global.__BHM_DEFENSE.siteTick = Game.time;
  global.__BHM_DEFENSE.siteCount = Object.keys(Game.constructionSites || {}).length;
  return global.__BHM_DEFENSE.siteCount;
}

function buildPlannedRoadSet(room, cfg) {
  // RoadPlanner owns Memory.rooms[room].roadPlanner.paths. We only read it to
  // avoid dropping exit rampart sites on planned logistics lanes.
  var out = {};
  var roomMem = Memory.rooms && Memory.rooms[room.name];
  var planner = roomMem && roomMem.roadPlanner;
  var paths = planner && planner.paths;
  var checked = 0;

  if (!paths) return out;
  for (var pathKey in paths) {
    if (!Object.prototype.hasOwnProperty.call(paths, pathKey)) continue;
    var rec = paths[pathKey];
    if (!rec || !Array.isArray(rec.path)) continue;
    for (var i = 0; i < rec.path.length; i++) {
      if (cfg.maxPlannedRoadTilesChecked > 0 && checked >= cfg.maxPlannedRoadTilesChecked) return out;
      var step = rec.path[i];
      if (step && step.roomName === room.name) {
        out[keyFor(step.x, step.y)] = true;
        checked++;
      }
    }
  }
  return out;
}

function makeSnapshot(room, cfg) {
  // One scan gives every planning helper a shared view. Avoiding repeated
  // room.find calls matters more than micro-optimizing individual loops.
  var structures = room.find(FIND_STRUCTURES) || [];
  var sites = room.find(FIND_CONSTRUCTION_SITES) || [];
  var terrain = Game.map && typeof Game.map.getRoomTerrain === 'function'
    ? Game.map.getRoomTerrain(room.name)
    : room.getTerrain();
  var snap = {
    structures: structures,
    sites: sites,
    terrain: terrain,
    ramparts: {},
    rampartSites: {},
    roads: {},
    roadSites: {},
    containers: {},
    blocking: {},
    plannedRoads: buildPlannedRoadSet(room, cfg),
    rampartCount: 0,
    rampartSiteCount: 0,
    roomSiteCount: sites.length
  };

  for (var i = 0; i < structures.length; i++) {
    var s = structures[i];
    if (!s || !s.pos) continue;
    var k = posKey(s.pos);
    if (s.structureType === STRUCTURE_RAMPART) {
      snap.ramparts[k] = true;
      snap.rampartCount++;
    } else if (s.structureType === STRUCTURE_ROAD) {
      snap.roads[k] = true;
    } else if (s.structureType === STRUCTURE_CONTAINER) {
      snap.containers[k] = true;
    } else {
      // Exit defenses should not be placed on ordinary structures. Protected
      // structure ramparts are added separately and are intentional.
      snap.blocking[k] = true;
    }
  }

  for (var j = 0; j < sites.length; j++) {
    var site = sites[j];
    if (!site || !site.pos) continue;
    var sk = posKey(site.pos);
    if (site.structureType === STRUCTURE_RAMPART) {
      snap.rampartSites[sk] = true;
      snap.rampartSiteCount++;
    } else if (site.structureType === STRUCTURE_ROAD) {
      snap.roadSites[sk] = true;
    }
  }

  return snap;
}

function isRoadLike(snapshot, x, y) {
  var k = keyFor(x, y);
  return !!(snapshot.roads[k] || snapshot.roadSites[k] || snapshot.plannedRoads[k]);
}

function addPlanTile(room, snapshot, plan, seen, stats, x, y, kind, allowRoad) {
  var k = keyFor(x, y);
  if (seen[k]) {
    stats.skippedDuplicate++;
    return false;
  }
  if (!inBuildBounds(x, y)) {
    stats.skippedEdge++;
    return false;
  }
  if (snapshot.terrain.get(x, y) === TERRAIN_MASK_WALL) {
    stats.skippedWall++;
    return false;
  }

  seen[k] = true;
  plan.push({
    x: x,
    y: y,
    kind: kind,
    allowRoad: allowRoad === true ? true : false
  });
  stats.planned++;
  if (kind && kind.indexOf('exit_') === 0) stats.exitPlanned++;
  else stats.protectedPlanned++;
  return true;
}

function rangeBetween(a, b) {
  var dx = Math.abs(a.x - b.x);
  var dy = Math.abs(a.y - b.y);
  return dx > dy ? dx : dy;
}

function addProtectedStructureRamparts(room, snapshot, plan, seen, stats, cfg) {
  var anchors = [];
  var links = [];
  var controllerContainers = [];

  for (var i = 0; i < snapshot.structures.length; i++) {
    var s = snapshot.structures[i];
    if (!s || !s.pos) continue;

    if (s.structureType === STRUCTURE_SPAWN) {
      anchors.push(s);
      addPlanTile(room, snapshot, plan, seen, stats, s.pos.x, s.pos.y, 'protected_spawn', true);
    } else if (s.structureType === STRUCTURE_STORAGE) {
      anchors.push(s);
      addPlanTile(room, snapshot, plan, seen, stats, s.pos.x, s.pos.y, 'protected_storage', true);
    } else if (s.structureType === STRUCTURE_TERMINAL) {
      addPlanTile(room, snapshot, plan, seen, stats, s.pos.x, s.pos.y, 'protected_terminal', true);
    } else if (s.structureType === STRUCTURE_TOWER) {
      addPlanTile(room, snapshot, plan, seen, stats, s.pos.x, s.pos.y, 'protected_tower', true);
    } else if (s.structureType === STRUCTURE_LINK) {
      links.push(s);
    } else if (s.structureType === STRUCTURE_CONTAINER && room.controller) {
      if (rangeBetween(s.pos, room.controller.pos) <= cfg.controllerContainerRange) {
        controllerContainers.push(s);
      }
    }
  }

  if (controllerContainers.length > 1 && room.controller) {
    controllerContainers.sort(function (a, b) {
      return rangeBetween(a.pos, room.controller.pos) - rangeBetween(b.pos, room.controller.pos);
    });
  }
  if (controllerContainers.length) {
    var cc = controllerContainers[0];
    addPlanTile(room, snapshot, plan, seen, stats, cc.pos.x, cc.pos.y, 'protected_controller_container', true);
  }

  for (var j = 0; j < links.length; j++) {
    var link = links[j];
    var nearCore = false;
    for (var a = 0; a < anchors.length; a++) {
      if (rangeBetween(link.pos, anchors[a].pos) <= cfg.protectedLinkRange) {
        nearCore = true;
        break;
      }
    }
    if (nearCore) {
      addPlanTile(room, snapshot, plan, seen, stats, link.pos.x, link.pos.y, 'protected_core_link', true);
    }
  }
}

function getExitSides(cfg) {
  var inset = cfg.exitInset;
  return [
    { name: 'top', find: FIND_EXIT_TOP, axis: 'x', cx: null, cy: inset, ix: 0, iy: 1 },
    { name: 'right', find: FIND_EXIT_RIGHT, axis: 'y', cx: 49 - inset, cy: null, ix: -1, iy: 0 },
    { name: 'bottom', find: FIND_EXIT_BOTTOM, axis: 'x', cx: null, cy: 49 - inset, ix: 0, iy: -1 },
    { name: 'left', find: FIND_EXIT_LEFT, axis: 'y', cx: inset, cy: null, ix: 1, iy: 0 }
  ];
}

function sortExitPositions(side, exits) {
  exits.sort(function (a, b) {
    if (side.axis === 'x') return a.x - b.x;
    return a.y - b.y;
  });
}

function coordinateForSide(side, pos) {
  return side.axis === 'x' ? pos.x : pos.y;
}

function candidateForExit(side, pos) {
  return {
    x: side.cx === null ? pos.x : side.cx,
    y: side.cy === null ? pos.y : side.cy
  };
}

function exitApproachIsOpen(terrain, side, pos, cfg) {
  // The candidate tile is two steps inward by default. Check the steps between
  // the edge and the candidate so we do not plan behind a natural wall.
  var x = pos.x;
  var y = pos.y;
  for (var step = 1; step <= cfg.exitInset; step++) {
    x += side.ix;
    y += side.iy;
    if (x < 0 || x > 49 || y < 0 || y > 49) return false;
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;
  }
  return true;
}

function chooseGateIndex(stretch, cfg) {
  if (!stretch || stretch.length < cfg.exitGateMinWidth) return -1;
  var center = Math.floor(stretch.length / 2);
  var best = -1;
  var bestDist = 999;

  // Prefer using a road or planned road as the opening. That preserves traffic
  // and naturally avoids spending rampart sites on roads.
  for (var i = 0; i < stretch.length; i++) {
    if (!stretch[i].road) continue;
    var dist = Math.abs(i - center);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  if (best >= 0) return best;
  return center;
}

function countAdjacentWalkable(terrain, x, y) {
  var count = 0;
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var ax = x + dx;
      var ay = y + dy;
      if (ax < 1 || ax > 48 || ay < 1 || ay > 48) continue;
      if (terrain.get(ax, ay) !== TERRAIN_MASK_WALL) count++;
    }
  }
  return count;
}

function addExitStretchRamparts(room, snapshot, plan, seen, stats, cfg, stretch) {
  if (!stretch || !stretch.length) return;
  if (cfg.exitMaxRampartsPerRoom > 0 && stats.exitPlanned >= cfg.exitMaxRampartsPerRoom) return;

  var gateIndex = chooseGateIndex(stretch, cfg);
  var nonRoadCount = 0;
  for (var i = 0; i < stretch.length; i++) {
    if (!stretch[i].road) nonRoadCount++;
  }

  if (stretch.length <= cfg.exitFullCoverMaxWidth) {
    // Narrow exits are real choke points, so cover most non-road tiles and use
    // the gate/road tile as the intentional opening.
    for (var n = 0; n < stretch.length; n++) {
      if (n === gateIndex) {
        stats.skippedGate++;
        continue;
      }
      if (stretch[n].road && nonRoadCount > 0) {
        stats.skippedRoad++;
        continue;
      }
      if (cfg.exitMaxRampartsPerRoom > 0 && stats.exitPlanned >= cfg.exitMaxRampartsPerRoom) return;
      addPlanTile(room, snapshot, plan, seen, stats, stretch[n].x, stretch[n].y, 'exit_' + stretch[n].side, nonRoadCount === 0);
    }
    return;
  }

  // Wide open exits are expensive to wall fully. Pick the best limited set:
  // tiles near natural ends first, then tiles with fewer walkable neighbors.
  var pool = [];
  for (var p = 0; p < stretch.length; p++) {
    if (p === gateIndex) {
      stats.skippedGate++;
      continue;
    }
    if (stretch[p].road && nonRoadCount > 0) {
      stats.skippedRoad++;
      continue;
    }
    stretch[p].edgeDistance = Math.min(p, stretch.length - 1 - p);
    stretch[p].walkableNeighbors = countAdjacentWalkable(snapshot.terrain, stretch[p].x, stretch[p].y);
    pool.push(stretch[p]);
  }

  pool.sort(function (a, b) {
    if (a.edgeDistance !== b.edgeDistance) return a.edgeDistance - b.edgeDistance;
    if (a.walkableNeighbors !== b.walkableNeighbors) return a.walkableNeighbors - b.walkableNeighbors;
    if (a.road !== b.road) return a.road ? 1 : -1;
    if (a.x !== b.x) return a.x - b.x;
    return a.y - b.y;
  });

  var limit = Math.min(pool.length, cfg.exitMaxRampartsPerSegment);
  for (var c = 0; c < limit; c++) {
    if (cfg.exitMaxRampartsPerRoom > 0 && stats.exitPlanned >= cfg.exitMaxRampartsPerRoom) return;
    addPlanTile(room, snapshot, plan, seen, stats, pool[c].x, pool[c].y, 'exit_' + pool[c].side, nonRoadCount === 0);
  }
}

function flushExitStretch(room, snapshot, plan, seen, stats, cfg, stretch) {
  if (!stretch.length) return;
  addExitStretchRamparts(room, snapshot, plan, seen, stats, cfg, stretch);
  stretch.length = 0;
}

function addExitRamparts(room, snapshot, plan, seen, stats, cfg) {
  var sides = getExitSides(cfg);
  for (var s = 0; s < sides.length; s++) {
    var side = sides[s];
    var exits = room.find(side.find) || [];
    if (!exits.length) continue;
    sortExitPositions(side, exits);

    var lastCoord = null;
    var stretch = [];
    for (var i = 0; i < exits.length; i++) {
      var pos = exits[i];
      var coord = coordinateForSide(side, pos);
      if (lastCoord !== null && coord !== lastCoord + 1) {
        flushExitStretch(room, snapshot, plan, seen, stats, cfg, stretch);
      }
      lastCoord = coord;

      if (!exitApproachIsOpen(snapshot.terrain, side, pos, cfg)) {
        flushExitStretch(room, snapshot, plan, seen, stats, cfg, stretch);
        stats.skippedWall++;
        continue;
      }

      var c = candidateForExit(side, pos);
      var k = keyFor(c.x, c.y);
      if (!inBuildBounds(c.x, c.y) || snapshot.terrain.get(c.x, c.y) === TERRAIN_MASK_WALL) {
        flushExitStretch(room, snapshot, plan, seen, stats, cfg, stretch);
        stats.skippedWall++;
        continue;
      }
      if (snapshot.containers[k] || snapshot.blocking[k]) {
        flushExitStretch(room, snapshot, plan, seen, stats, cfg, stretch);
        stats.skippedBlocked++;
        continue;
      }

      stretch.push({
        x: c.x,
        y: c.y,
        side: side.name,
        road: isRoadLike(snapshot, c.x, c.y)
      });
    }
    flushExitStretch(room, snapshot, plan, seen, stats, cfg, stretch);
  }
}

function makeEmptyStats() {
  return {
    planned: 0,
    protectedPlanned: 0,
    exitPlanned: 0,
    skippedDuplicate: 0,
    skippedWall: 0,
    skippedEdge: 0,
    skippedRoad: 0,
    skippedGate: 0,
    skippedBlocked: 0
  };
}

function buildPlannedByKey(plan, targetHits) {
  var out = {};
  for (var i = 0; i < plan.length; i++) {
    var t = plan[i];
    out[keyFor(t.x, t.y)] = {
      kind: t.kind,
      targetHits: targetHits
    };
  }
  return out;
}

function rebuildPlan(room, mem, cfg) {
  var snapshot = makeSnapshot(room, cfg);
  var plan = [];
  var seen = {};
  var stats = makeEmptyStats();
  var targetHits = getRampartTargetHits(room);

  addProtectedStructureRamparts(room, snapshot, plan, seen, stats, cfg);
  addExitRamparts(room, snapshot, plan, seen, stats, cfg);

  mem.version = PLAN_VERSION;
  mem.lastPlanTick = Game.time;
  mem.nextPlanTick = Game.time + getPlanInterval(cfg);
  mem.rcl = getRcl(room);
  mem.rampartTargetHits = targetHits;
  mem.plannedRamparts = plan;
  mem.plannedByKey = buildPlannedByKey(plan, targetHits);
  mem.nextBuildIndex = 0;
  mem.buildPassPlaced = 0;
  mem.completedAt = plan.length ? null : Game.time;
  mem.stats = stats;

  return snapshot;
}

function planNeedsRebuild(room, mem) {
  if (!mem) return true;
  if (mem.version !== PLAN_VERSION) return true;
  if (!Array.isArray(mem.plannedRamparts)) return true;
  if (mem.rcl !== getRcl(room)) return true;
  if (mem.rampartTargetHits !== getRampartTargetHits(room)) return true;
  return Game.time >= (mem.nextPlanTick || 0);
}

function setRetry(mem, cfg) {
  mem.nextPlanTick = Game.time + cfg.planningSkippedRetryTicks;
}

function isProtectedKind(kind) {
  return !!(kind && kind.indexOf('protected_') === 0);
}

function canPlaceRampartSite(room, snapshot, tile) {
  var x = tile.x;
  var y = tile.y;
  var k = keyFor(x, y);
  var roadLike = false;

  if (!inBuildBounds(x, y)) return { ok: false, reason: 'edge' };
  if (snapshot.terrain.get(x, y) === TERRAIN_MASK_WALL) return { ok: false, reason: 'wall' };
  if (snapshot.ramparts[k] || snapshot.rampartSites[k]) return { ok: false, reason: 'existing' };

  var structs = room.lookForAt(LOOK_STRUCTURES, x, y) || [];
  for (var i = 0; i < structs.length; i++) {
    var s = structs[i];
    if (s.structureType === STRUCTURE_RAMPART) return { ok: false, reason: 'existing' };
    if (s.structureType === STRUCTURE_ROAD) {
      roadLike = true;
      continue;
    }
    if (s.structureType === STRUCTURE_CONTAINER && tile.kind === 'protected_controller_container') continue;
    if (isProtectedKind(tile.kind)) continue;
    return { ok: false, reason: 'blocked' };
  }

  var sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y) || [];
  for (var j = 0; j < sites.length; j++) {
    if (sites[j].structureType === STRUCTURE_RAMPART) return { ok: false, reason: 'existing' };
    return { ok: false, reason: 'blocked' };
  }

  if (!isProtectedKind(tile.kind)) {
    roadLike = roadLike || snapshot.roads[k] || snapshot.roadSites[k] || snapshot.plannedRoads[k];
    if (roadLike && tile.allowRoad !== true) return { ok: false, reason: 'road' };
  }

  return { ok: true };
}

function countRampartsAndSites(snapshot) {
  return snapshot.rampartCount + snapshot.rampartSiteCount;
}

function shouldPlaceThisTick(room, mem, cfg) {
  if (cfg.maxSitesPerTick <= 0) return false;
  if (mem.nextSiteTick && Game.time < mem.nextSiteTick) return false;
  if (!CpuBudget.isTickForKey(room.name + ':defensePlace', cfg.sitePlacementInterval)) return false;
  return true;
}

function placeRampartSites(room, mem, snapshot, cfg) {
  var plan = mem && mem.plannedRamparts;
  if (!Array.isArray(plan) || !plan.length) return { placed: 0, checked: 0 };

  var globalSites = countGlobalConstructionSitesOnce();
  if (globalSites >= cfg.globalSiteSafetyLimit) return { placed: 0, checked: 0, blockedBySites: true };
  if (snapshot.roomSiteCount >= cfg.roomSiteSafetyLimit) return { placed: 0, checked: 0, blockedBySites: true };

  var allowedRamparts = getAllowedRamparts(room);
  var rampartCapLeft = allowedRamparts - countRampartsAndSites(snapshot);
  if (rampartCapLeft <= 0) return { placed: 0, checked: 0, blockedByRampartCap: true };

  var placed = 0;
  var checked = 0;
  var startIndex = intAtLeast(mem.nextBuildIndex, 0, 0);
  if (startIndex >= plan.length) startIndex = 0;

  for (var i = startIndex; i < plan.length; i++) {
    if (placed >= cfg.maxSitesPerTick) {
      mem.nextBuildIndex = i;
      break;
    }
    if (checked >= cfg.maxPlacementChecksPerTick) {
      mem.nextBuildIndex = i;
      break;
    }
    if (globalSites + placed >= cfg.globalSiteSafetyLimit) {
      mem.nextBuildIndex = i;
      break;
    }
    if (snapshot.roomSiteCount + placed >= cfg.roomSiteSafetyLimit) {
      mem.nextBuildIndex = i;
      break;
    }
    if (rampartCapLeft - placed <= 0) {
      mem.nextBuildIndex = i;
      break;
    }

    checked++;
    var tile = plan[i];
    var can = canPlaceRampartSite(room, snapshot, tile);
    if (!can.ok) continue;

    var rc = room.createConstructionSite(tile.x, tile.y, STRUCTURE_RAMPART);
    if (rc === OK) {
      placed++;
      mem.buildPassPlaced = (mem.buildPassPlaced || 0) + 1;
      snapshot.rampartSites[keyFor(tile.x, tile.y)] = true;
      snapshot.rampartSiteCount++;
      snapshot.roomSiteCount++;
    } else if (rc === ERR_FULL) {
      mem.nextBuildIndex = i;
      break;
    }
  }

  if (startIndex + checked >= plan.length || mem.nextBuildIndex >= plan.length) {
    if ((mem.buildPassPlaced || 0) <= 0) mem.completedAt = Game.time;
    mem.nextBuildIndex = 0;
    mem.buildPassPlaced = 0;
  } else if (mem.nextBuildIndex == null) {
    mem.nextBuildIndex = startIndex + checked;
  }

  mem.lastSiteTick = Game.time;
  mem.nextSiteTick = Game.time + cfg.sitePlacementInterval;
  mem.lastPlaceResult = { placed: placed, checked: checked };
  return { placed: placed, checked: checked };
}

function drawDefenseVisuals(room, mem, cfg) {
  if (!cfg.debugVisuals) return;
  if (cfg.debugVisualRoom && cfg.debugVisualRoom !== room.name) return;
  if (cfg.debugVisualModulo > 1 && (Game.time % cfg.debugVisualModulo) !== 0) return;
  if (!room.visual || !mem || !Array.isArray(mem.plannedRamparts)) return;

  var plan = mem.plannedRamparts;
  for (var i = 0; i < plan.length; i++) {
    room.visual.circle(plan[i].x, plan[i].y, {
      radius: 0.23,
      fill: 'transparent',
      stroke: '#00c2ff',
      strokeWidth: 0.06,
      opacity: 0.75
    });
  }

  var ramparts = room.find(FIND_STRUCTURES, {
    filter: function (s) { return s.structureType === STRUCTURE_RAMPART; }
  }) || [];
  for (var r = 0; r < ramparts.length; r++) {
    room.visual.rect(ramparts[r].pos.x - 0.32, ramparts[r].pos.y - 0.32, 0.64, 0.64, {
      fill: 'transparent',
      stroke: '#66ff99',
      strokeWidth: 0.05,
      opacity: 0.75
    });
  }
}

function runDefensePlanner(room) {
  var cfg = getConfig();
  if (!cfg.enabled) return;
  if (!canBuildRamparts(room, cfg)) return;

  var mem = getDefenseMemory(room);
  if (!mem) return;

  var snapshot = null;
  if (planNeedsRebuild(room, mem)) {
    if (!CpuBudget.canSpend({
      minBucket: cfg.minBucketForPlanning,
      maxCpuUsed: cfg.maxCpuUsedBeforePlanning
    })) {
      setRetry(mem, cfg);
      return;
    }
    snapshot = rebuildPlan(room, mem, cfg);
  }

  drawDefenseVisuals(room, mem, cfg);

  if (mem.completedAt && Game.time < (mem.nextPlanTick || 0)) return;
  if (!shouldPlaceThisTick(room, mem, cfg)) return;

  if (!snapshot) snapshot = makeSnapshot(room, cfg);
  placeRampartSites(room, mem, snapshot, cfg);
}

module.exports = {
  runDefensePlanner: runDefensePlanner,
  getDefenseMemory: getDefenseMemory,
  getRampartTargetHits: getRampartTargetHits,
  drawDefenseVisuals: drawDefenseVisuals,
  _rebuildPlan: rebuildPlan,
  _makeSnapshot: makeSnapshot
};
