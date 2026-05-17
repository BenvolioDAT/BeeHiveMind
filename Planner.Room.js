var CoreConfig = require('core.config');
var PlannerStamps = require('Planner.Stamps');
var PlannerVisuals = require('Planner.Visuals');
var PlannerLayout = require('Planner.Layout');
var PlannerReservations = require('Planner.Reservations');
var PlannerRamparts = require('Planner.Ramparts');

// Teaching note: this planner intentionally keeps its knobs in one object
// so novice contributors can tweak behavior without spelunking the code.
// Teaching note: top-level planner config lives here so new contributors can
// see the cadence knobs in one place. Keep this ES5-friendly (var + objects).
var CFG = Object.freeze({
  maxSitesPerTick: 5,
  csiteSafetyLimit: 40,
  tickModulo: 2,
  noPlacementCooldownPlaced: 4,
  noPlacementCooldownNone: 10
});

// Hard caps (upper bounds). Still clamped by CONTROLLER_STRUCTURES per RCL.
const STRUCTURE_LIMITS = (() => {
  const limits = {};
  limits[STRUCTURE_TOWER] = 6;
  limits[STRUCTURE_EXTENSION] = 60;
  limits[STRUCTURE_CONTAINER] = 10;
  limits[STRUCTURE_RAMPART] = 2;
  limits[STRUCTURE_ROAD] = 150;
  return limits;
})();

// Base layout blueprint: offsets around the anchor spawn. Keeping the
// array flat makes it easy to tweak or visualize.
const BASE_OFFSETS = [
  { type: STRUCTURE_TOWER,     x:  2, y:  0 },
  { type: STRUCTURE_STORAGE,   x:  8, y:  0 },
  { type: STRUCTURE_LINK,      x:  7, y:  0 },
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
  { type: STRUCTURE_EXTENSION, x:  5, y: -1 }
];

function isOwnedRoom(room) {
  return room && room.controller && room.controller.my;
}

function shouldSkipTick(room) {
  if (CFG.tickModulo <= 1) return false;
  // Spread planner work across rooms by summing the room name characters.
  var offset = 0;
  var name = room.name;
  for (var i = 0; i < name.length; i++) {
    offset += name.charCodeAt(i);
  }
  offset = offset % CFG.tickModulo;
  return ((Game.time + offset) % CFG.tickModulo) !== 0;
}

function plannerMemory(room) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
  if (!Memory.rooms[room.name].planner) Memory.rooms[room.name].planner = {};
  return Memory.rooms[room.name].planner;
}

function pickAnchor(room) {
  const spawns = room.find(FIND_MY_SPAWNS);
  return spawns.length ? spawns[0].pos : null;
}

/** Snapshot the room once so we do not repeatedly scan structures/sites. */


function isRampartPreviewActiveForRoom(room, cfg) {
  if (!room || !cfg) return false;
  return !!(cfg.plannerRampartPreviewEnabled &&
    (!cfg.plannerRampartPreviewRoom || cfg.plannerRampartPreviewRoom === room.name));
}

function resolvePlannerStampAnchor(room, fallbackAnchor, stamp, cfg, opts) {
  if (!room || !fallbackAnchor || !stamp || !cfg) return null;
  var o = opts || {};
  var chosen = PlannerLayout.getChosenAnchor(room, stamp, {
    scanStep: o.scanStep || cfg.plannerStampCandidateScanStep,
    maxChecks: o.maxChecks || cfg.plannerStampCandidateMaxChecks,
    replanTicks: o.replanTicks || cfg.plannerStampCandidateReplanTicks,
    showScores: (o.showScores != null) ? o.showScores : cfg.plannerStampCandidateShowScores
  });
  var anchor = (chosen && chosen.pos) ? chosen.pos : fallbackAnchor;
  return {
    stamp: stamp,
    anchor: anchor,
    chosen: chosen || null,
    source: (chosen && chosen.pos) ? 'layout' : 'fallback'
  };
}

function maybeDrawPlannerPreviews(room, anchor) {
  if (!room || !anchor) return;
  if (typeof RoomVisual === 'undefined') return;
  if (!CoreConfig || !CoreConfig.settings || !CoreConfig.settings.visuals) return;

  var vc = CoreConfig.settings.visuals;
  var stampId = vc.plannerStampPreviewStampId || 'core_v1';
  var stamp = PlannerStamps.getStampById(stampId) || PlannerStamps.getDefaultCoreStamp();
  var resolved = resolvePlannerStampAnchor(room, anchor, stamp, vc);
  if (!resolved || !resolved.stamp || !resolved.anchor) return;

  var stampPreviewAllowed = !!(vc.plannerStampPreviewEnabled &&
    (!vc.plannerStampPreviewRoom || vc.plannerStampPreviewRoom === room.name));

  if (stampPreviewAllowed) {
    PlannerVisuals.drawStampPreview(room, resolved.stamp, resolved.anchor, {
      rcl: (room.controller && room.controller.level) || 0,
      showFutureRcl: vc.plannerStampPreviewShowFutureRcl !== false
    });

    // Candidate preview only gates debug visuals (not anchor selection).
    if (vc.plannerStampCandidatePreviewEnabled && resolved.chosen && resolved.chosen.pos) {
      PlannerVisuals.drawChosenAnchor(room, resolved.chosen.pos, resolved.chosen.score, {
        showScores: vc.plannerStampCandidateShowScores
      });
    }
  }

  var rampartPreviewAllowed = isRampartPreviewActiveForRoom(room, vc);
  if (rampartPreviewAllowed) {
    var rampartReservations = null;
    if (vc.plannerRampartPreviewUseReservations) rampartReservations = PlannerReservations.buildReservations(room, vc);
    var rampartPlan = PlannerRamparts.buildRampartPreview(room, resolved.stamp, resolved.anchor, rampartReservations, {
      useReservations: vc.plannerRampartPreviewUseReservations !== false,
      range: vc.plannerRampartPreviewRange,
      maxTiles: vc.plannerRampartPreviewMaxTiles,
      showLabels: vc.plannerRampartPreviewShowLabels === true,
      rcl: vc.plannerRampartPreviewRcl,
      anchorSource: resolved.source
    });
    PlannerRamparts.drawRampartPreview(room, rampartPlan, {
      showLabels: vc.plannerRampartPreviewShowLabels === true
    });
  } else {
    PlannerRamparts.clearRampartPreview(room);
  }
}

function scanRoomState(room) {
  const built = Object.create(null);
  const sites = Object.create(null);
  const terrain = room.getTerrain();

  const arrStructs = room.find(FIND_STRUCTURES);
  for (let i = 0; i < arrStructs.length; i++) {
    const stype = arrStructs[i].structureType;
    built[stype] = (built[stype] || 0) + 1;
  }

  const arrSites = room.find(FIND_CONSTRUCTION_SITES);
  for (let j = 0; j < arrSites.length; j++) {
    const sType = arrSites[j].structureType;
    sites[sType] = (sites[sType] || 0) + 1;
  }

  return { built, sites, terrain };
}

function allowedCount(type, room) {
  const hard = (STRUCTURE_LIMITS[type] !== undefined) ? STRUCTURE_LIMITS[type] : Infinity;
  let controllerLimit = Infinity;
  if (room.controller && typeof CONTROLLER_STRUCTURES !== 'undefined') {
    const table = CONTROLLER_STRUCTURES[type];
    if (table) {
      const lvl = room.controller.level || 0;
      controllerLimit = (table[lvl] != null) ? table[lvl] : 0;
    } else {
      controllerLimit = 0;
    }
  }
  return (hard < controllerLimit) ? hard : controllerLimit;
}

function planPriorityForRcl(rcl) {
  // RCL-aware priorities:
  // 2 => extension rush, 3 => first tower, 4 => storage pivot, 5 => links.
  if (rcl <= 1) return [STRUCTURE_EXTENSION];
  if (rcl === 2) return [STRUCTURE_EXTENSION];
  if (rcl === 3) return [STRUCTURE_TOWER, STRUCTURE_EXTENSION];
  if (rcl === 4) return [STRUCTURE_STORAGE, STRUCTURE_EXTENSION, STRUCTURE_TOWER];
  if (rcl >= 5) return [STRUCTURE_LINK, STRUCTURE_STORAGE, STRUCTURE_TOWER, STRUCTURE_EXTENSION];
  return [STRUCTURE_EXTENSION];
}

function stampBuildConfig() {
  return (CoreConfig && CoreConfig.settings && CoreConfig.settings.visuals) || {};
}

function shouldUseStampBuild(room) {
  if (!room) return false;
  var cfg = stampBuildConfig();
  if (!cfg.plannerStampBuildEnabled) return false;
  if (cfg.plannerStampBuildRoom && cfg.plannerStampBuildRoom !== room.name) return false;
  return true;
}

function isRampartBuildActiveForRoom(room, cfg) {
  if (!room || !cfg) return false;
  if (!cfg.plannerRampartBuildEnabled) return false;
  if (cfg.plannerRampartBuildRoom && cfg.plannerRampartBuildRoom !== room.name) return false;
  var minRcl = Math.max(0, Number(cfg.plannerRampartBuildMinRcl || 0));
  var rcl = (room.controller && room.controller.level) || 0;
  if (rcl < minRcl) return false;
  if (cfg.plannerRampartBuildRequirePreviewEnabled && !isRampartPreviewActiveForRoom(room, cfg)) return false;
  return true;
}

function isStampBuildTypeAllowed(type, rcl) {
  var lvl = Number(rcl) || 0;
  if (type === STRUCTURE_EXTENSION) return lvl >= 2;
  if (type === STRUCTURE_TOWER) return lvl >= 3;
  if (type === STRUCTURE_STORAGE) return lvl >= 4;
  if (type === STRUCTURE_LINK) return lvl >= 5;
  return false;
}

function countExistingOrSiteAt(room, x, y, type) {
  var structs = room.lookForAt(LOOK_STRUCTURES, x, y);
  for (var i = 0; i < structs.length; i++) {
    if (structs[i].structureType === type) return 1;
  }
  var sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
  for (var j = 0; j < sites.length; j++) {
    if (sites[j].structureType === type) return 1;
  }
  return 0;
}

function canPlaceStampStructure(room, snapshot, x, y, type, reservations, opts) {
  if (x < 1 || x > 48 || y < 1 || y > 48) return false;
  if (snapshot.terrain.get(x, y) === TERRAIN_MASK_WALL) return false;
  if (countExistingOrSiteAt(room, x, y, type) > 0) return false;

  // Keep roads intact; stamp build should never overwrite travel lanes.
  var structs = room.lookForAt(LOOK_STRUCTURES, x, y);
  for (var i = 0; i < structs.length; i++) {
    var st = structs[i];
    if (st.structureType === STRUCTURE_RAMPART && st.my) continue;
    return false;
  }
  var sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
  for (var j = 0; j < sites.length; j++) {
    if (sites[j].structureType !== type) return false;
  }

  var sources = room.find(FIND_SOURCES);
  for (var s = 0; s < sources.length; s++) {
    if (sources[s].pos.x === x && sources[s].pos.y === y) return false;
  }
  var mins = room.find(FIND_MINERALS);
  for (var m = 0; m < mins.length; m++) {
    if (mins[m].pos.x === x && mins[m].pos.y === y) return false;
  }
  if (room.controller && room.controller.pos.x === x && room.controller.pos.y === y) return false;
  if (opts && opts.plannerReservationsEnabled && opts.plannerReservationsAffectStampBuild &&
    type !== STRUCTURE_ROAD && type !== STRUCTURE_RAMPART &&
    PlannerReservations.isReserved(reservations, x, y)) return false;
  return true;
}

function ensureStampLayoutSites(room, anchor, stamp, snapshot, allowedFn, rcl, slotsLeft, globalCapLeft, reservations, opts) {
  var placed = 0;
  var skippedBlocked = 0;
  var skippedCap = 0;
  var skippedType = 0;
  var skippedReserved = 0;
  if (!room || !anchor || !stamp) return { placed: 0, skippedBlocked: 0, skippedCap: 0, skippedType: 0 };
  if (slotsLeft <= 0 || globalCapLeft <= 0) return { placed: 0, skippedBlocked: 0, skippedCap: 0, skippedType: 0 };

  var absTiles = PlannerStamps.getAbsoluteStampTiles(stamp, anchor);
  // Priority order follows stamp metadata: lower RCL first, then lower p first.
  absTiles.sort(function (a, b) {
    var ar = a.rcl || 0;
    var br = b.rcl || 0;
    if (ar !== br) return ar - br;
    var ap = a.p || 0;
    var bp = b.p || 0;
    return ap - bp;
  });

  for (var i = 0; i < absTiles.length; i++) {
    if (slotsLeft <= 0 || globalCapLeft <= 0) break;
    var t = absTiles[i];
    if ((t.rcl || 0) > (rcl || 0)) continue;

    if (!isStampBuildTypeAllowed(t.type, rcl)) {
      skippedType++;
      continue;
    }

    var have = (snapshot.built[t.type] || 0) + (snapshot.sites[t.type] || 0);
    var cap = allowedFn(t.type);
    if (have >= cap) {
      skippedCap++;
      continue;
    }

    if (!canPlaceStampStructure(room, snapshot, t.x, t.y, t.type, reservations, opts)) {
      if (opts && opts.plannerReservationsEnabled && opts.plannerReservationsAffectStampBuild &&
        t.type !== STRUCTURE_ROAD && t.type !== STRUCTURE_RAMPART &&
        PlannerReservations.isReserved(reservations, t.x, t.y)) skippedReserved++;
      skippedBlocked++;
      continue;
    }

    var rc = room.createConstructionSite(t.x, t.y, t.type);
    if (rc === OK) {
      placed++;
      slotsLeft--;
      globalCapLeft--;
      snapshot.sites[t.type] = (snapshot.sites[t.type] || 0) + 1;
    } else if (rc === ERR_FULL) {
      skippedCap++;
      break;
    } else {
      skippedBlocked++;
    }
  }

  return { placed: placed, skippedBlocked: skippedBlocked, skippedCap: skippedCap, skippedType: skippedType, skippedReserved: skippedReserved };
}

function canPlaceRampartSite(room, x, y, reservations, opts) {
  if (!room) return { ok: false, reason: 'blocked' };
  if (x < 2 || x > 47 || y < 2 || y > 47) return { ok: false, reason: 'blocked' };
  if (room.getTerrain().get(x, y) === TERRAIN_MASK_WALL) return { ok: false, reason: 'blocked' };
  if (opts && opts.useReservations && PlannerReservations.isReserved(reservations, x, y)) return { ok: false, reason: 'reserved' };

  var sources = room.find(FIND_SOURCES);
  for (var s = 0; s < sources.length; s++) {
    if (sources[s].pos.x === x && sources[s].pos.y === y) return { ok: false, reason: 'blocked' };
  }
  var mins = room.find(FIND_MINERALS);
  for (var m = 0; m < mins.length; m++) {
    if (mins[m].pos.x === x && mins[m].pos.y === y) return { ok: false, reason: 'blocked' };
  }
  if (room.controller && room.controller.pos.x === x && room.controller.pos.y === y) return { ok: false, reason: 'blocked' };

  var structs = room.lookForAt(LOOK_STRUCTURES, x, y);
  for (var i = 0; i < structs.length; i++) {
    if (structs[i].structureType === STRUCTURE_RAMPART && structs[i].my) return { ok: false, reason: 'existing' };
    if (structs[i].structureType === STRUCTURE_ROAD || structs[i].structureType === STRUCTURE_CONTAINER) continue;
    return { ok: false, reason: 'blocked' };
  }
  var sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
  for (var j = 0; j < sites.length; j++) {
    if (sites[j].structureType === STRUCTURE_RAMPART) return { ok: false, reason: 'existing' };
    return { ok: false, reason: 'blocked' };
  }

  return { ok: true };
}

function ensureRampartSites(room, plan, reservations, opts, slotsLeft, globalCapLeft) {
  var placed = 0;
  var skippedExisting = 0;
  var skippedBlocked = 0;
  var skippedReserved = 0;
  var skippedCap = 0;
  if (!room || !plan || !Array.isArray(plan.tiles)) return { placed: 0, skippedExisting: 0, skippedBlocked: 0, skippedReserved: 0, skippedCap: 0, previewTiles: 0 };

  for (var i = 0; i < plan.tiles.length; i++) {
    if (slotsLeft <= 0 || globalCapLeft <= 0) { skippedCap += (plan.tiles.length - i); break; }
    var t = plan.tiles[i];
    var can = canPlaceRampartSite(room, t.x, t.y, reservations, opts);
    if (!can.ok) {
      if (can.reason === 'existing') skippedExisting++;
      else if (can.reason === 'reserved') skippedReserved++;
      else skippedBlocked++;
      continue;
    }

    var rc = room.createConstructionSite(t.x, t.y, STRUCTURE_RAMPART);
    if (rc === OK) {
      placed++;
      slotsLeft--;
      globalCapLeft--;
    } else if (rc === ERR_FULL) {
      skippedCap += (plan.tiles.length - i);
      break;
    } else {
      skippedBlocked++;
    }
  }
  return { placed: placed, skippedExisting: skippedExisting, skippedBlocked: skippedBlocked, skippedReserved: skippedReserved, skippedCap: skippedCap, previewTiles: plan.tiles.length };
}

function orderedBaseOffsetsForRcl(rcl) {
  var priority = planPriorityForRcl(rcl);
  var ordered = [];
  var used = Object.create(null);

  for (var p = 0; p < priority.length; p++) {
    var wanted = priority[p];
    for (var i = 0; i < BASE_OFFSETS.length; i++) {
      if (BASE_OFFSETS[i].type !== wanted) continue;
      ordered.push(BASE_OFFSETS[i]);
      used[i] = true;
    }
  }
  for (var j = 0; j < BASE_OFFSETS.length; j++) {
    if (used[j]) continue;
    ordered.push(BASE_OFFSETS[j]);
  }
  return ordered;
}

/**
 * High level orchestration:
 *  1. Skip work unless this is our tick slice (smooth CPU).
 *  2. Bail early if global construction sites are near the limit.
 *  3. Place one container per owned source before touching the core base.
 *  4. Lay out the base blueprint offsets as the final drip.
 */
function ensureSites(room) {
  // Teaching note: This is the planner entry point. We bail out aggressively
  // so heavy scans only run when they are most useful (interval + triggers).
  if (!isOwnedRoom(room)) return;

  // Phase 2B stamp planner: draw preview every tick when enabled.
  // Preview is pure visuals and never places construction sites.
  var anchor = pickAnchor(room);
  maybeDrawPlannerPreviews(room, anchor);

  if (shouldSkipTick(room)) return;

  var mem = plannerMemory(room);
  if (mem.nextPlanTick && Game.time < mem.nextPlanTick) return;

  // Trigger: rerun immediately when RCL increases so new limits are applied.
  var rcl = (room.controller && room.controller.level) || 0;
  if (mem.lastPlannedRcl == null) mem.lastPlannedRcl = rcl;
  if (rcl > mem.lastPlannedRcl) {
    mem.nextPlanTick = Game.time; // force a fresh pass right now
    mem.lastPlannedRcl = rcl;
  }

  if (!anchor) return;

  var globalCount = Object.keys(Game.constructionSites).length;
  if (globalCount >= CFG.csiteSafetyLimit) {
    mem.nextPlanTick = Game.time + CFG.noPlacementCooldownNone;
    return;
  }

  var snapshot = scanRoomState(room);
  var allowedFn = function (type) { return allowedCount(type, room); };
  var buildCfg = stampBuildConfig();
  var shouldBuildReservations = !!(
    buildCfg.plannerReservationsEnabled ||
    buildCfg.plannerReservationVisualsEnabled ||
    (isRampartPreviewActiveForRoom(room, buildCfg) && buildCfg.plannerRampartPreviewUseReservations) ||
    (isRampartBuildActiveForRoom(room, buildCfg) && buildCfg.plannerRampartBuildUseReservations !== false)
  );
  var reservations = shouldBuildReservations ? PlannerReservations.buildReservations(room, buildCfg) : null;
  if (shouldBuildReservations) {
    mem.lastReservations = {
      t: Game.time,
      count: reservations.count,
      byReason: reservations.byReason
    };
    if (buildCfg.plannerReservationVisualsEnabled &&
      (!buildCfg.plannerReservationVisualRoom || buildCfg.plannerReservationVisualRoom === room.name)) {
      PlannerReservations.drawReservations(room, reservations, buildCfg);
    }
  }
  var placed = 0;
  var cCount = globalCount;

  // Phase 1: shore up source containers so harvesters always have parking.
  const containerDelta = ensureSourceContainers(
    room,
    snapshot.terrain,
    snapshot.built,
    snapshot.sites,
    allowedFn,
    CFG.maxSitesPerTick - placed,
    CFG.csiteSafetyLimit - cCount
  );
  placed += containerDelta.placed;
  cCount += containerDelta.placed;

  if (placed >= CFG.maxSitesPerTick || cCount >= CFG.csiteSafetyLimit) {
    mem.nextPlanTick = Game.time + CFG.noPlacementCooldownPlaced;
    return;
  }

  var stampBuildActive = shouldUseStampBuild(room);
  if (stampBuildActive) {
    var stamp = PlannerStamps.getDefaultCoreStamp();
    var resolvedStamp = stamp ? resolvePlannerStampAnchor(room, anchor, stamp, buildCfg) : null;
    var stampAnchor = resolvedStamp && resolvedStamp.anchor ? resolvedStamp.anchor : null;
    var memStamp = plannerMemory(room);
    if (stampAnchor && stamp) {
      var stampMaxRcl = Number(buildCfg.plannerStampBuildRclMax || 3);
      var stampRcl = Math.min(rcl || 0, stampMaxRcl);
      var stampPerTick = Math.max(0, Number(buildCfg.plannerStampBuildMaxSitesPerTick || 0));
      var stampResult = ensureStampLayoutSites(
        room,
        stampAnchor,
        stamp,
        snapshot,
        allowedFn,
        stampRcl,
        Math.min(CFG.maxSitesPerTick - placed, stampPerTick),
        CFG.csiteSafetyLimit - cCount,
        reservations,
        buildCfg
      );
      placed += stampResult.placed;
      cCount += stampResult.placed;
      memStamp.lastStampBuild = {
        t: Game.time,
        stampId: stamp.id,
        anchor: { x: stampAnchor.x, y: stampAnchor.y, roomName: stampAnchor.roomName },
        anchorSource: resolvedStamp ? resolvedStamp.source : 'fallback',
        stampRcl: stampRcl,
        placed: stampResult.placed,
        skippedBlocked: stampResult.skippedBlocked,
        skippedReserved: stampResult.skippedReserved,
        skippedCap: stampResult.skippedCap,
        skippedType: stampResult.skippedType,
        reservationCount: reservations ? reservations.count : 0,
        reservationReasons: reservations ? reservations.byReason : {},
        allowedTypes: {
          extension: isStampBuildTypeAllowed(STRUCTURE_EXTENSION, stampRcl),
          tower: isStampBuildTypeAllowed(STRUCTURE_TOWER, stampRcl),
          storage: isStampBuildTypeAllowed(STRUCTURE_STORAGE, stampRcl),
          link: isStampBuildTypeAllowed(STRUCTURE_LINK, stampRcl)
        }
      };
    } else {
      memStamp.lastStampBuild = {
        t: Game.time,
        stampId: stamp ? stamp.id : null,
        anchor: null,
        placed: 0,
        skippedBlocked: 0,
        skippedReserved: 0,
        skippedCap: 0,
        skippedType: 0,
        skippedNoAnchor: 1,
        reservationCount: reservations ? reservations.count : 0,
        reservationReasons: reservations ? reservations.byReason : {}
      };
    }
  }

  var rampartBuildActive = isRampartBuildActiveForRoom(room, buildCfg);
  if (rampartBuildActive && placed < CFG.maxSitesPerTick && cCount < CFG.csiteSafetyLimit) {
    var rampartStamp = PlannerStamps.getDefaultCoreStamp();
    var resolvedRampart = resolvePlannerStampAnchor(room, anchor, rampartStamp, buildCfg);
    var rampartAnchor = resolvedRampart && resolvedRampart.anchor ? resolvedRampart.anchor : null;
    if (rampartStamp && rampartAnchor) {
      var useReservations = buildCfg.plannerRampartBuildUseReservations !== false;
      var rampartPlan = PlannerRamparts.buildRampartPreview(room, rampartStamp, rampartAnchor, reservations, {
        useReservations: useReservations,
        range: buildCfg.plannerRampartPreviewRange,
        maxTiles: buildCfg.plannerRampartPreviewMaxTiles,
        showLabels: false,
        rcl: buildCfg.plannerRampartPreviewRcl,
        anchorSource: resolvedRampart ? resolvedRampart.source : 'fallback'
      });
      var rampartPerTick = Math.max(0, Number(buildCfg.plannerRampartBuildMaxSitesPerTick || 0));
      var rampartResult = ensureRampartSites(
        room,
        rampartPlan,
        reservations,
        { useReservations: useReservations },
        Math.min(CFG.maxSitesPerTick - placed, rampartPerTick),
        CFG.csiteSafetyLimit - cCount
      );
      placed += rampartResult.placed;
      cCount += rampartResult.placed;
      mem.lastRampartBuild = {
        t: Game.time,
        placed: rampartResult.placed,
        skippedExisting: rampartResult.skippedExisting,
        skippedBlocked: rampartResult.skippedBlocked,
        skippedReserved: rampartResult.skippedReserved,
        skippedCap: rampartResult.skippedCap,
        previewTiles: rampartResult.previewTiles,
        minRcl: Math.max(0, Number(buildCfg.plannerRampartBuildMinRcl || 0)),
        anchorSource: resolvedRampart ? resolvedRampart.source : 'fallback',
        anchor: { x: rampartAnchor.x, y: rampartAnchor.y, roomName: rampartAnchor.roomName },
        stampId: rampartStamp.id
      };
    } else {
      mem.lastRampartBuild = {
        t: Game.time,
        placed: 0,
        skippedExisting: 0,
        skippedBlocked: 0,
        skippedReserved: 0,
        skippedCap: 0,
        skippedNoAnchor: 1,
        previewTiles: 0,
        minRcl: Math.max(0, Number(buildCfg.plannerRampartBuildMinRcl || 0)),
        anchor: null,
        stampId: rampartStamp ? rampartStamp.id : null
      };
    }
  }

  var skipLegacy = stampBuildActive && buildCfg.plannerStampBuildSkipLegacyBaseLayout === true;
  if (!skipLegacy) {
    // Phase 2/3: follow the legacy base offsets as long as we have placements left.
    const basePlaced = ensureBaseLayout(
      room,
      anchor,
      snapshot,
      allowedFn,
      rcl,
      CFG.maxSitesPerTick - placed,
      CFG.csiteSafetyLimit - cCount,
      reservations,
      buildCfg
    );
    placed += basePlaced;
    cCount += basePlaced;
  }

  mem.nextPlanTick = Game.time + (placed ? CFG.noPlacementCooldownPlaced : CFG.noPlacementCooldownNone);
}

/**
 * Given the anchor spawn/storage, iterate the BASE_OFFSETS blueprint and
 * place whatever is still missing. Everything is kept tiny and linear so
 * new contributors can trace the decision making.
 */
function ensureBaseLayout(room, anchor, snapshot, allowedFn, rcl, slotsLeft, globalCapLeft, reservations, opts) {
  if (!anchor) return 0;
  if (slotsLeft <= 0 || globalCapLeft <= 0) return 0;
  let placed = 0;
  var offsets = orderedBaseOffsetsForRcl(rcl || 0);
  var hasStorage = (snapshot.built[STRUCTURE_STORAGE] || 0) + (snapshot.sites[STRUCTURE_STORAGE] || 0) > 0;
  var hasTower = (snapshot.built[STRUCTURE_TOWER] || 0) + (snapshot.sites[STRUCTURE_TOWER] || 0) > 0;

  for (let i = 0; i < offsets.length; i++) {
    if (slotsLeft <= 0 || globalCapLeft <= 0) break;

    const plan = offsets[i];
    // RCL goal gates keep the planner focused and avoid csite spam.
    if (plan.type === STRUCTURE_TOWER && (rcl || 0) < 3) continue;
    if (plan.type === STRUCTURE_STORAGE && (rcl || 0) < 4) continue;
    if (plan.type === STRUCTURE_LINK && (rcl || 0) < 5) continue;
    if (plan.type === STRUCTURE_EXTENSION && (rcl || 0) >= 4 && !hasStorage) continue;
    if (plan.type === STRUCTURE_EXTENSION && (rcl || 0) >= 3 && !hasTower) continue;
    const tx = anchor.x + plan.x;
    const ty = anchor.y + plan.y;

    if (tx < 1 || tx > 48 || ty < 1 || ty > 48) continue;
    if (snapshot.terrain.get(tx, ty) === TERRAIN_MASK_WALL) continue;
    if (room.lookForAt(LOOK_STRUCTURES, tx, ty).length) continue;
    if (room.lookForAt(LOOK_CONSTRUCTION_SITES, tx, ty).length) continue;
    if (opts && opts.plannerReservationsEnabled && opts.plannerReservationsAffectLegacyBaseLayout &&
      plan.type !== STRUCTURE_ROAD && plan.type !== STRUCTURE_RAMPART &&
      PlannerReservations.isReserved(reservations, tx, ty)) continue;

    const have = (snapshot.built[plan.type] || 0) + (snapshot.sites[plan.type] || 0);
    const cap = allowedFn(plan.type);
    if (have >= cap) continue;

    const rc = room.createConstructionSite(tx, ty, plan.type);
    if (rc === OK) {
      placed++;
      slotsLeft--;
      globalCapLeft--;
      snapshot.sites[plan.type] = (snapshot.sites[plan.type] || 0) + 1;
      if (plan.type === STRUCTURE_STORAGE) hasStorage = true;
      if (plan.type === STRUCTURE_TOWER) hasTower = true;
    }
  }

  return placed;
}

/**
 * Place exactly one container per source in an owned room that has a spawn.
 * Updates Memory.rooms[roomName].sources[sourceId].container = {status, x, y, id/siteId}
 *
 * Status values:
 *  - "Good"    : container exists and is healthy
 *  - "Repair"  : container exists but needs TLC
 *  - "Building": csite exists within range 1 of the source
 *  - "Need"    : no container/csite; we will attempt to place (respecting caps)
 */
function ensureSourceContainers(room, terrain, built, sites, allowedFn, slotsLeft, globalCapLeft) {
  let placed = 0;

  if (!room) return { placed: 0 };
  if (slotsLeft <= 0 || globalCapLeft <= 0) return { placed: 0 };

  const capContainers = allowedFn(STRUCTURE_CONTAINER);
  let haveContainers = (built[STRUCTURE_CONTAINER] || 0) + (sites[STRUCTURE_CONTAINER] || 0);
  if (haveContainers >= capContainers) return { placed: 0 };

  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
  if (!Memory.rooms[room.name].sources) Memory.rooms[room.name].sources = {};
  const sourcesMem = Memory.rooms[room.name].sources;
  const sources = room.find(FIND_SOURCES);

  for (let s = 0; s < sources.length; s++) {
    const src = sources[s];
    const sid = src.id;
    if (!sourcesMem[sid]) sourcesMem[sid] = {};
    if (!sourcesMem[sid].container) sourcesMem[sid].container = {};
    const cmem = sourcesMem[sid].container;

    const structs = src.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: (o) => o.structureType === STRUCTURE_CONTAINER
    });
    if (structs.length) {
      const cont = structs[0];
      cmem.x = cont.pos.x;
      cmem.y = cont.pos.y;
      cmem.id = cont.id;
      cmem.siteId = undefined;
      const healthy = (cont.hits != null && cont.hitsMax != null) ? (cont.hits / cont.hitsMax) : 1;
      cmem.status = (healthy < 0.60) ? 'Repair' : 'Good';
      continue;
    }

    const cs = src.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
      filter: (c) => c.structureType === STRUCTURE_CONTAINER
    });
    if (cs.length) {
      cmem.x = cs[0].pos.x;
      cmem.y = cs[0].pos.y;
      cmem.id = undefined;
      cmem.siteId = cs[0].id;
      cmem.status = 'Building';
      continue;
    }

    cmem.status = 'Need';
    if (slotsLeft <= 0 || globalCapLeft <= 0) continue;
    if (haveContainers >= capContainers) continue;

    let placedHere = false;
    for (let dx = -1; dx <= 1 && !placedHere; dx++) {
      for (let dy = -1; dy <= 1 && !placedHere; dy++) {
        if (dx === 0 && dy === 0) continue;
        const tx = src.pos.x + dx;
        const ty = src.pos.y + dy;
        if (tx < 1 || tx > 48 || ty < 1 || ty > 48) continue;
        if (terrain.get(tx, ty) === TERRAIN_MASK_WALL) continue;

        // Keep the placement check readable: only roads, containers, and our ramparts are allowed on the tile.
        const structuresAt = room.lookForAt(LOOK_STRUCTURES, tx, ty);
        let blocked = false;
        for (let i = 0; i < structuresAt.length; i++) {
          const st = structuresAt[i].structureType;
          if (st === STRUCTURE_ROAD) continue;
          if (st === STRUCTURE_CONTAINER) continue;
          if (st === STRUCTURE_RAMPART && structuresAt[i].my) continue;
          blocked = true;
          break;
        }
        if (blocked) continue;
        if (room.lookForAt(LOOK_CONSTRUCTION_SITES, tx, ty).length) continue;

        const rc = room.createConstructionSite(tx, ty, STRUCTURE_CONTAINER);
        if (rc === OK) {
          cmem.x = tx;
          cmem.y = ty;
          cmem.id = undefined;
          cmem.status = 'Building';
          const lookup = room.lookForAt(LOOK_CONSTRUCTION_SITES, tx, ty);
          cmem.siteId = (lookup && lookup.length) ? lookup[0].id : undefined;

          placed++;
          slotsLeft--;
          globalCapLeft--;
          haveContainers++;
          sites[STRUCTURE_CONTAINER] = (sites[STRUCTURE_CONTAINER] || 0) + 1;
          placedHere = true;
        }
      }
    }
  }

  return { placed };
}

const RoomPlanner = {
  structureLimits: STRUCTURE_LIMITS,
  BASE_OFFSETS,
  ensureSites,
  _ensureSourceContainers: ensureSourceContainers,
  _memory: plannerMemory
};

module.exports = RoomPlanner;
