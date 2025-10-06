"use strict";

var INFRA_SCAN_INTERVAL = 25;
var ROAD_SEGMENT_LIMIT = 5;
var ROAD_PATH_MAXOPS = 4000;
var ROAD_SWAMP_COST = 5;
var ROAD_PLAIN_COST = 2;
var ROAD_LENGTH_THRESHOLD = 15;
var ROAD_SWAMP_THRESHOLD = 1;

var __state = Object.create(null);

function ensureState(roomName) {
  if (!__state[roomName]) {
    __state[roomName] = {
      nextInfraScan: 0,
      buildPlans: [],
      linkPlan: null
    };
  }
  return __state[roomName];
}

function chooseAnchor(room) {
  if (room.storage) return room.storage.pos;
  var spawns = room.find(FIND_MY_SPAWNS);
  if (spawns && spawns.length) return spawns[0].pos;
  if (room.controller) return room.controller.pos;
  return null;
}

function hasContainerNearby(room, pos) {
  var structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
  for (var i = 0; i < structures.length; i++) {
    if (structures[i].structureType === STRUCTURE_CONTAINER) return true;
  }
  var sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y);
  for (var j = 0; j < sites.length; j++) {
    if (sites[j].structureType === STRUCTURE_CONTAINER) return true;
  }
  return false;
}

function pickContainerTile(room, source) {
  var terrain = room.getTerrain();
  var best = null;
  var bestScore = -9999;
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var x = source.pos.x + dx;
      var y = source.pos.y + dy;
      if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
      var tile = terrain.get(x, y);
      if (tile === TERRAIN_MASK_WALL) continue;
      var pos = { x: x, y: y, roomName: room.name };
      if (hasContainerNearby(room, pos)) continue;
      var score = -Math.abs(dx) - Math.abs(dy);
      if (tile === TERRAIN_MASK_SWAMP) score -= 1;
      var look = room.lookForAt(LOOK_STRUCTURES, x, y);
      for (var i = 0; i < look.length; i++) {
        if (look[i].structureType === STRUCTURE_ROAD) score += 2;
      }
      if (score > bestScore) {
        bestScore = score;
        best = pos;
      }
    }
  }
  return best;
}

function planContainer(room, source) {
  if (!source) return null;
  var terrain = room.getTerrain();
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var x = source.pos.x + dx;
      var y = source.pos.y + dy;
      if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      var has = hasContainerNearby(room, { x: x, y: y, roomName: room.name });
      if (has) return null;
    }
  }
  var tile = pickContainerTile(room, source);
  if (!tile) return null;
  return {
    type: 'container',
    pos: tile,
    reason: 'ROI: container@' + source.id
  };
}

function shouldProposeRoad(pathInfo, swampCount) {
  if (!pathInfo || !pathInfo.path) return false;
  if (pathInfo.path.length >= ROAD_LENGTH_THRESHOLD) return true;
  if (swampCount >= ROAD_SWAMP_THRESHOLD) return true;
  return false;
}

function hasRoad(room, pos) {
  var structs = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
  for (var i = 0; i < structs.length; i++) {
    if (structs[i].structureType === STRUCTURE_ROAD) return true;
  }
  var sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y);
  for (var j = 0; j < sites.length; j++) {
    if (sites[j].structureType === STRUCTURE_ROAD) return true;
  }
  return false;
}

function planRoadSegments(room, source, anchorPos) {
  if (!anchorPos) return [];
  var terrain = room.getTerrain();
  var search = PathFinder.search(anchorPos, { pos: source.pos, range: 1 }, {
    plainCost: ROAD_PLAIN_COST,
    swampCost: ROAD_SWAMP_COST,
    maxOps: ROAD_PATH_MAXOPS,
    roomCallback: function () {
      return null;
    }
  });
  if (!search || !search.path || !search.path.length) return [];
  var swampCount = 0;
  for (var i = 0; i < search.path.length; i++) {
    var step = search.path[i];
    if (terrain.get(step.x, step.y) === TERRAIN_MASK_SWAMP) swampCount += 1;
  }
  if (!shouldProposeRoad(search, swampCount)) return [];
  var plans = [];
  for (var idx = 0; idx < search.path.length && plans.length < ROAD_SEGMENT_LIMIT; idx += 2) {
    var tile = search.path[idx];
    if (!tile) continue;
    if (tile.roomName !== room.name) continue; // local roads only
    var pos = { x: tile.x, y: tile.y, roomName: tile.roomName };
    if (hasRoad(room, pos)) continue;
    plans.push({ type: 'road', pos: pos, reason: 'ROI: haul' });
  }
  return plans;
}

function gatherLinkPlan(room) {
  if (!room.controller || room.controller.level < 5) return null;
  var links = room.find(FIND_MY_STRUCTURES, {
    filter: function (s) {
      return s.structureType === STRUCTURE_LINK;
    }
  });
  var linkCap = CONTROLLER_STRUCTURES[STRUCTURE_LINK][room.controller.level] || 0;
  var remaining = linkCap - links.length;
  var sources = room.find(FIND_SOURCES);
  var sourceCandidates = [];
  for (var i = 0; i < sources.length; i++) {
    var src = sources[i];
    var hasLink = false;
    for (var j = 0; j < links.length; j++) {
      if (links[j].pos.getRangeTo(src.pos) <= 2) {
        hasLink = true;
        break;
      }
    }
    if (!hasLink) {
      if (remaining > 0) {
        sourceCandidates.push(src.id);
        remaining -= 1;
      }
    }
  }
  var sinkIds = [];
  for (var k = 0; k < links.length; k++) {
    var link = links[k];
    if (room.storage && link.pos.getRangeTo(room.storage.pos) <= 2) {
      sinkIds.push(link.id);
      continue;
    }
    if (room.controller && link.pos.getRangeTo(room.controller.pos) <= 4) {
      sinkIds.push(link.id);
    }
  }
  if (!sourceCandidates.length && !sinkIds.length) return null;
  return {
    sourceIds: sourceCandidates,
    sinkIds: sinkIds
  };
}

function refreshInfrastructure(room, state) {
  var plans = [];
  var anchor = chooseAnchor(room);
  var sources = room.find(FIND_SOURCES);
  for (var i = 0; i < sources.length; i++) {
    var src = sources[i];
    var containerPlan = planContainer(room, src);
    if (containerPlan) plans.push(containerPlan);
    var roadPlans = planRoadSegments(room, src, anchor);
    for (var r = 0; r < roadPlans.length; r++) {
      plans.push(roadPlans[r]);
    }
  }
  state.buildPlans = plans;
  state.linkPlan = gatherLinkPlan(room);
  state.nextInfraScan = Game.time + INFRA_SCAN_INTERVAL;
}

function decideSpawnWeights(room, kpis) {
  var weights = Object.create(null);
  if (!kpis) return weights;
  var energyCap = kpis.spawnEnergyCap || (room ? room.energyCapacityAvailable : 0) || 0;
  var energyAvail = kpis.spawnEnergyAvail || (room ? room.energyAvailable : 0) || 0;
  var ratio = energyCap > 0 ? (energyAvail / energyCap) : 1;
  var income = kpis.energyIncomePer100 || 0;
  var spend = kpis.energySpendingPer100 || 0;
  var storagePct = kpis.storageFillPct || 0;
  if (ratio < 0.5 && income < spend) {
    weights.courier = 2.5;
    weights.baseharvest = 1.4;
    weights.upgrader = 0.5;
    weights.builder = 0.6;
  }
  if (storagePct < 0.2) {
    weights.courier = Math.max(weights.courier || 0, 2.2);
    weights.upgrader = Math.min(weights.upgrader || 0.6, 0.6);
  }
  if (storagePct > 0.8) {
    weights.upgrader = Math.max(weights.upgrader || 1, 1.4);
  }
  return weights;
}

var EconomyAI = {
  /**
   * Produce economic proposals for an owned room.
   * @param {Room} room Owned room under evaluation.
   * @param {object} kpis KPI snapshot from the blackboard.
   * @returns {object} Proposal bundle (spawn weights, build plans, link targets).
   * @cpu Heavy infra refresh every INFRA_SCAN_INTERVAL ticks; light otherwise.
   */
  decideEconomy: function (room, kpis) {
    if (!room || !room.controller || !room.controller.my) {
      return { spawnWeights: {}, buildPlans: [], linkPlan: null };
    }
    var state = ensureState(room.name);
    if (Game.time >= state.nextInfraScan) {
      refreshInfrastructure(room, state);
    }
    return {
      spawnWeights: decideSpawnWeights(room, kpis),
      buildPlans: state.buildPlans || [],
      linkPlan: state.linkPlan
    };
  }
};

module.exports = EconomyAI;
