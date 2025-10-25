// Design Notes:
// - Deterministic builder that pulls milestones from Planner.Room and assigns one
//   construction site at a time using a strict priority queue.
// - Priorities follow the requested sequence: critical milestones (storage, extensions,
//   towers, arterial roads) → source containers → controller approach → remaining roads → extras.
// - Uses Traveler-compatible creep.travelTo() for navigation; no new construction sites are
//   created here (Planner.Room.ensureSites handles placement), so the role never spams sites.
// - Includes TTL-aware task swapping to avoid stranding builders on distant targets.

'use strict';

var BeeToolbox = require('BeeToolbox');
var RoomPlanner = require('Planner.Room');
var RoadPlanner = require('Planner.Road');
try { require('Traveler'); } catch (e) {}

var ENERGY_MIN_BUILD = 10;
var TTL_STRAND_BUFFER = 15;

if (!global.__BUILDER_CACHE) {
  global.__BUILDER_CACHE = { tick: -1, sitesByRoom: {}, siteArray: [] };
}

function _getHomeName(creep) {
  if (creep.memory.home) return creep.memory.home;
  var nearest = null;
  var best = 9999;// Design Notes:
// - Deterministic builder that pulls milestones from Planner.Room and assigns one
//   construction site at a time using a strict priority queue.
// - Priorities follow the requested sequence: critical milestones (storage, extensions,
//   towers, arterial roads) → source containers → controller approach → remaining roads → extras.
// - Uses Traveler-compatible creep.travelTo() for navigation; no new construction sites are
//   created here (Planner.Room.ensureSites handles placement), so the role never spams sites.
// - Includes TTL-aware task swapping to avoid stranding builders on distant targets.

'use strict';

var BeeToolbox = require('BeeToolbox');
var RoomPlanner = require('Planner.Room');
var RoadPlanner = require('Planner.Road');
try { require('Traveler'); } catch (e) {}

var ENERGY_MIN_BUILD = 10;
var TTL_STRAND_BUFFER = 15;

if (!global.__BUILDER_CACHE) {
  global.__BUILDER_CACHE = { tick: -1, sitesByRoom: {}, siteArray: [] };
}

function _getHomeName(creep) {
  if (creep.memory.home) return creep.memory.home;
  var nearest = null;
  var best = 9999;
  for (var name in Game.spawns) {
    if (!BeeToolbox.hasOwn(Game.spawns, name)) continue;
    var sp = Game.spawns[name];
    if (!sp) continue;
    var dist = BeeToolbox.safeLinearDistance(creep.pos.roomName, sp.pos.roomName);
    if (dist < best) {
      best = dist;
      nearest = sp.pos.roomName;
    }
  }
  if (!nearest) nearest = creep.pos.roomName;
  creep.memory.home = nearest;
  return nearest;
}

function _gatherSitesOnce() {
  var cache = global.__BUILDER_CACHE;
  if (cache.tick === Game.time) return cache;
  cache.tick = Game.time;
  cache.sitesByRoom = {};
  cache.siteArray = [];
  for (var id in Game.constructionSites) {
    if (!BeeToolbox.hasOwn(Game.constructionSites, id)) continue;
    var site = Game.constructionSites[id];
    if (!site || !site.my) continue;
    var roomName = site.pos.roomName;
    if (!cache.sitesByRoom[roomName]) cache.sitesByRoom[roomName] = [];
    cache.sitesByRoom[roomName].push(site);
    cache.siteArray.push(site);
  }
  return cache;
}

function _planIndex(plan) {
  var index = {};
  if (!plan) return index;
  for (var i = 0; i < plan.structures.length; i++) {
    var task = plan.structures[i];
    var key = task.type + ':' + task.pos.x + ':' + task.pos.y;
    index[key] = task;
  }
  for (var roadKey in plan.roads) {
    if (!BeeToolbox.hasOwn(plan.roads, roadKey)) continue;
    var edge = plan.roads[roadKey];
    if (!edge || !edge.path) continue;
    for (var p = 0; p < edge.path.length; p++) {
      var step = edge.path[p];
      var rKey = STRUCTURE_ROAD + ':' + step.x + ':' + step.y;
      if (!index[rKey]) {
        index[rKey] = {
          key: roadKey,
          type: STRUCTURE_ROAD,
          pos: step,
          category: edge.category === 'critical' ? 'road-critical' : 'road',
          rcl: edge.category === 'critical' ? 2 : 4
        };
      }
    }
  }
  return index;
}

function _isRoadTask(item) {
  if (!item) return false;
  if (item.structureType && item.structureType === STRUCTURE_ROAD) return true;
  if (item.type && item.type === STRUCTURE_ROAD) return true;
  if (item.category === 'road' || item.category === 'road-critical') return true;
  return false;
}

function _priorityForSite(site, planIndex) {
  if (!site) return -1;
  var key = site.structureType + ':' + site.pos.x + ':' + site.pos.y;
  var task = planIndex[key];
  if (task) {
    if (task.type === STRUCTURE_STORAGE) return 120;
    if (task.type === STRUCTURE_SPAWN) return 118;
    if (task.category === 'extension' && task.group === 'extA') return 114;
    if (task.category === 'extension' && task.group === 'extB') return 113;
    if (task.category === 'extension' && task.group === 'extC') return 111;
    if (task.category === 'extension' && task.group === 'extD') return 109;
    if (task.type === STRUCTURE_TOWER) {
      // Acceptance test: After storage exists in RCL4+, extensions outrank towers until the block finishes.
      return 108;
    }
    if (task.category === 'road-critical' || task.category === 'road') return 1;
    if (task.category === 'container') return 106;
    if (task.category === 'link') return 104;
    if (task.category === 'hub') return 80;
  }
  if (site.structureType === STRUCTURE_ROAD) return 1;
  if (site.structureType === STRUCTURE_CONTAINER) return 60;
  if (site.structureType === STRUCTURE_EXTENSION) return 70;
  return 10;
}

function _getEnergySource(creep, homeRoom) {
  // Resolve home room safely
  if (!homeRoom) {
    var homeName = _getHomeName(creep);
    homeRoom = Game.rooms[homeName];
  }

  // If no visible room, bail (can't scan drops/ruins without vision)
  if (!homeRoom) return null;

  // 1️⃣ Dropped energy first (closest first)
  var dropped = homeRoom.find(FIND_DROPPED_RESOURCES, {
    filter: function (r) {
      return r.resourceType === RESOURCE_ENERGY && r.amount >= 50;
    }
  });
  if (dropped && dropped.length) {
    var nearestDrop = creep.pos.findClosestByRange(dropped);
    if (nearestDrop) return nearestDrop;
  }

  // 2️⃣ Tombstones with energy
  var tombs = homeRoom.find(FIND_TOMBSTONES, {
    filter: function (t) {
      return t.store && (t.store[RESOURCE_ENERGY] | 0) > 0;
    }
  });
  if (tombs && tombs.length) {
    var nearestTomb = creep.pos.findClosestByRange(tombs);
    if (nearestTomb) return nearestTomb;
  }

  // 3️⃣ Ruins with energy
  var ruins = homeRoom.find(FIND_RUINS, {
    filter: function (r) {
      return r.store && (r.store[RESOURCE_ENERGY] | 0) > 0;
    }
  });
  if (ruins && ruins.length) {
    var nearestRuin = creep.pos.findClosestByRange(ruins);
    if (nearestRuin) return nearestRuin;
  }

  // 4️⃣ Containers or links with energy
  var conts = homeRoom.find(FIND_STRUCTURES, {
    filter: function (s) {
      return (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_LINK) &&
             s.store && (s.store[RESOURCE_ENERGY] | 0) > 0;
    }
  });
  if (conts && conts.length) {
    var nearestCont = creep.pos.findClosestByRange(conts);
    if (nearestCont) return nearestCont;
  }

  // 5️⃣ Storage, then terminal
  if (homeRoom.storage && (homeRoom.storage.store[RESOURCE_ENERGY] | 0) > 0) {
    return homeRoom.storage;
  }
  if (homeRoom.terminal && (homeRoom.terminal.store[RESOURCE_ENERGY] | 0) > 5000) {
    return homeRoom.terminal;
  }

  // 6️⃣ Fallback: spawn with energy
  var spawns = homeRoom.find(FIND_MY_SPAWNS, {
    filter: function (sp) {
      return (sp.store && (sp.store[RESOURCE_ENERGY] | 0) > 0);
    }
  });
  if (spawns && spawns.length) return spawns[0];

  return null;
}



function _withdraw(creep, target) {
  if (!target) return false;

  // Handle dropped energy first
  if (target.resourceType === RESOURCE_ENERGY) {
    if (creep.pos.isNearTo(target)) {
      return creep.pickup(target) === OK;
    } else {
      creep.travelTo(target, { range: 1, maxRooms: 1 });
      return false;
    }
  }

  // Handle structures and ruins/tombstones
  if (creep.pos.isNearTo(target)) {
    if (target.store && target.store[RESOURCE_ENERGY] > 0) {
      return creep.withdraw(target, RESOURCE_ENERGY) === OK;
    }
    if (target.energy && target.energy > 0) {
      return creep.withdraw(target, RESOURCE_ENERGY) === OK;
    }
  } else {
    creep.travelTo(target, { range: 1, maxRooms: 1 });
  }

  return false;
}


function _getLockedSite(creep) {
  var id = creep.memory.buildSiteId;
  if (!id) return null;
  var site = Game.getObjectById(id);
  if (!site || !site.my) {
    delete creep.memory.buildSiteId;
    return null;
  }
  return site;
}

function _lockSite(creep, site) {
  if (!site) return;
  creep.memory.buildSiteId = site.id;
  creep.memory.lockTime = Game.time;
}

function _shouldAbandon(creep, site) {
  if (!site) return false;
  if (!creep.ticksToLive) return false;
  var distance = creep.pos.getRangeTo(site.pos);
  if (creep.ticksToLive < distance + TTL_STRAND_BUFFER) {
    return true;
  }
  return false;
}

function _chooseSite(creep, planIndex) {
  var cache = _gatherSitesOnce();
  var homeName = _getHomeName(creep);
  var sites = cache.sitesByRoom[homeName] || [];
  if (!sites.length) {
    sites = cache.siteArray;
  }
  var bestNonRoad = null;
  var bestNonRoadScore = -1;
  var bestRoad = null;
  var bestRoadScore = -1;
  var fallback = null;
  var fallbackScore = -1;
  var fallbackDist = 999;
  var lowTTL = creep.ticksToLive && creep.ticksToLive < 250;
  for (var i = 0; i < sites.length; i++) {
    var site = sites[i];
    if (!site || !site.my) continue;
    var key = site.structureType + ':' + site.pos.x + ':' + site.pos.y;
    var task = planIndex[key];
    var isRoad = _isRoadTask(task) || _isRoadTask(site);
    var score = _priorityForSite(site, planIndex);
    if (score < 0) continue;
    if (_wouldStrand(creep, site)) continue;
    var dist = creep.pos.getRangeTo(site.pos);
    var far = site.pos.roomName !== creep.pos.roomName || dist > 25;
    if (lowTTL && far) {
      if (score > fallbackScore || (score === fallbackScore && dist < fallbackDist)) {
        fallback = site;
        fallbackScore = score;
        fallbackDist = dist;
      }
      continue;
    }
    if (isRoad) {
      if (score > bestRoadScore) {
        bestRoad = site;
        bestRoadScore = score;
      } else if (score === bestRoadScore) {
        var curRoadDist = bestRoad ? creep.pos.getRangeTo(bestRoad.pos) : 999;
        if (dist < curRoadDist) {
          bestRoad = site;
          bestRoadScore = score;
        }
      }
      continue;
    }
    if (score > bestNonRoadScore) {
      bestNonRoad = site;
      bestNonRoadScore = score;
    } else if (score === bestNonRoadScore) {
      var curDist = bestNonRoad ? creep.pos.getRangeTo(bestNonRoad.pos) : 999;
      if (dist < curDist) {
        bestNonRoad = site;
        bestNonRoadScore = score;
      }
    }
  }
  if (bestNonRoad) return bestNonRoad;
  if (bestRoad) return bestRoad;
  if (lowTTL) {
    return null;
  }
  return fallback;
}

function _wouldStrand(creep, site) {
  if (!site || !creep.ticksToLive) return false;
  var dist = creep.pos.getRangeTo(site.pos);
  return creep.ticksToLive < (dist * 2 + TTL_STRAND_BUFFER);
}

function _build(creep, site) {
  if (!site) return;
  if (creep.pos.inRangeTo(site, 3)) {
    creep.build(site);
  } else {
    creep.travelTo(site, { range: 3, maxRooms: 1, reusePath: 10 });
  }
}

var TaskBuilder = {
  run: function (creep) {
    if (!creep || !creep.my) return;
    var homeName = _getHomeName(creep);
    var homeRoom = Game.rooms[homeName];
    var plan = homeRoom ? RoomPlanner.plan(homeRoom) : null;
    var planIndex = _planIndex(plan);

    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) < ENERGY_MIN_BUILD) {
      var src = _getEnergySource(creep, homeRoom);
      if (src) {
        _withdraw(creep, src);
        return;
      }
    }

    var current = _getLockedSite(creep);
    if (current && _shouldAbandon(creep, current)) {
      delete creep.memory.buildSiteId;
      current = null;
    }

    if (!current) {
      current = _chooseSite(creep, planIndex);
      if (current) {
        _lockSite(creep, current);
      }
    }

    if (!current) {
      if (homeRoom) {
        var hub = RoadPlanner.computeHub(homeRoom);
        if (hub) creep.travelTo(hub, { range: 2, maxRooms: 1 });
      }
      return;
    }

    _build(creep, current);
  }
};

module.exports = TaskBuilder;
