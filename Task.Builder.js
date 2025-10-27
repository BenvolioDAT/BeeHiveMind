var BuilderPlanner = require('Task.Builder.Planner');
try { require('Traveler'); } catch (e) {}

var HAS_OWN = Object.prototype.hasOwnProperty;

function hasOwn(obj, key) {
  return !!(obj && HAS_OWN.call(obj, key));
}

function isValidRoomName(name) {
  if (typeof name !== 'string') return false;
  return /^[WE]\d+[NS]\d+$/.test(name);
}

function safeLinearDistance(a, b, allowInexact) {
  if (!isValidRoomName(a) || !isValidRoomName(b)) {
    return 9999;
  }
  if (!Game || !Game.map || typeof Game.map.getRoomLinearDistance !== 'function') {
    return 9999;
  }
  return Game.map.getRoomLinearDistance(a, b, allowInexact);
}

var _constructionCache = global.__taskBuilderConstructionCache ||
  (global.__taskBuilderConstructionCache = { tick: -1, list: [], byRoom: {}, counts: {} });

function constructionSiteCache() {
  var tick = Game.time | 0;
  if (_constructionCache.tick === tick) {
    return _constructionCache;
  }
  _constructionCache.tick = tick;
  _constructionCache.list = [];
  _constructionCache.byRoom = {};
  _constructionCache.counts = {};
  for (var id in Game.constructionSites) {
    if (!hasOwn(Game.constructionSites, id)) continue;
    var site = Game.constructionSites[id];
    if (!site || !site.my) continue;
    _constructionCache.list.push(site);
    if (site.pos && site.pos.roomName) {
      var roomName = site.pos.roomName;
      if (!_constructionCache.byRoom[roomName]) {
        _constructionCache.byRoom[roomName] = [];
        _constructionCache.counts[roomName] = 0;
      }
      _constructionCache.byRoom[roomName].push(site);
      _constructionCache.counts[roomName] += 1;
    }
  }
  return _constructionCache;
}

var ENERGY_MIN_BUILD = 10;
var TTL_STRAND_BUFFER = 15;

if (!global.__BUILDER_CACHE) {
  global.__BUILDER_CACHE = { tick: -1, sitesByRoom: {}, siteArray: [] };
}

// Cache plan indexes per room per tick to reduce repeated computation.
if (!global.__PLAN_INDEX_CACHE) {
  global.__PLAN_INDEX_CACHE = {};
}

// Cache energy search results briefly to avoid repeated scans.
if (!global.__BUILDER_ENERGY_CACHE) {
  global.__BUILDER_ENERGY_CACHE = {};
}

// Cache hub positions per room per tick for idle movement.
if (!global.__BUILDER_HUB_CACHE) {
  global.__BUILDER_HUB_CACHE = {};
}

// Ensure the shared soft lock memory container exists before use.
function _ensureLockMemory() {
  if (!Memory._buildLocks) {
    Memory._buildLocks = {};
  }
  return Memory._buildLocks;
}

function _getHomeName(creep) {
  if (creep.memory.home) return creep.memory.home;
  var nearest = null;
  var best = 9999;
  for (var name in Game.spawns) {
    if (!hasOwn(Game.spawns, name)) continue;
    var sp = Game.spawns[name];
    if (!sp) continue;
    var dist = safeLinearDistance(creep.pos.roomName, sp.pos.roomName);
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
  var siteCache = constructionSiteCache();
  var byRoom = siteCache.byRoom || {};
  var list = siteCache.list || [];
  cache.siteArray = list.slice();
  for (var roomName in byRoom) {
    if (!hasOwn(byRoom, roomName)) continue;
    var roomSites = byRoom[roomName];
    cache.sitesByRoom[roomName] = Array.isArray(roomSites) ? roomSites.slice() : [];
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
    if (!hasOwn(plan.roads, roadKey)) continue;
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

// Retrieve a cached plan index for the room if available this tick.
function _getPlanIndexCached(roomName, plan) {
  if (!roomName) return {};
  var cache = global.__PLAN_INDEX_CACHE;
  var entry = cache[roomName];
  if (entry && entry.tick === Game.time) {
    return entry.index;
  }
  var index = _planIndex(plan);
  cache[roomName] = { tick: Game.time, index: index };
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

// Cache hub lookups for the room each tick to avoid recomputation while idle.
function _getCachedHub(homeRoom) {
  if (!homeRoom) return null;
  var roomName = homeRoom.name;
  var entry = global.__BUILDER_HUB_CACHE[roomName];
  if (entry && entry.tick === Game.time) {
    return entry.hub;
  }
  var hub = BuilderPlanner.computeHub(homeRoom);
  global.__BUILDER_HUB_CACHE[roomName] = { tick: Game.time, hub: hub };
  return hub;
}

function _getEnergySource(creep, homeRoom, forceRefresh) {
  // Resolve home room safely
  if (!homeRoom) {
    var homeName = _getHomeName(creep);
    homeRoom = Game.rooms[homeName];
  }

  // If no visible room, bail (can't scan drops/ruins without vision)
  if (!homeRoom) return null;

  var roomName = homeRoom.name;
  var roomCache = global.__BUILDER_ENERGY_CACHE;
  var entry = roomCache[roomName];
  var needsRefresh = forceRefresh || !entry || (Game.time - entry.tick >= 3);

  // Refresh the cached energy targets if stale or forced.
  if (needsRefresh) {
    entry = {
      tick: Game.time,
      drops: homeRoom.find(FIND_DROPPED_RESOURCES, {
        filter: function (r) {
          return r.resourceType === RESOURCE_ENERGY;
        }
      }),
      tombs: homeRoom.find(FIND_TOMBSTONES),
      ruins: homeRoom.find(FIND_RUINS),
      conts: homeRoom.find(FIND_STRUCTURES, {
        filter: function (s) {
          return s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_LINK;
        }
      }),
      storage: homeRoom.storage || null,
      terminal: homeRoom.terminal || null,
      spawns: homeRoom.find(FIND_MY_SPAWNS)
    };
    roomCache[roomName] = entry;
  }

  // 1️⃣ Dropped energy first (closest first)
  var validDrops = [];
  for (var i = 0; i < entry.drops.length; i++) {
    var drop = entry.drops[i];
    if (drop && drop.amount >= 50 && drop.resourceType === RESOURCE_ENERGY) {
      validDrops.push(drop);
    }
  }
  if (validDrops.length) {
    var nearestDrop = creep.pos.findClosestByRange(validDrops);
    if (nearestDrop) return nearestDrop;
  }

  // 2️⃣ Tombstones with energy
  var validTombs = [];
  for (var j = 0; j < entry.tombs.length; j++) {
    var tomb = entry.tombs[j];
    if (tomb && tomb.store && (tomb.store[RESOURCE_ENERGY] | 0) > 0) {
      validTombs.push(tomb);
    }
  }
  if (validTombs.length) {
    var nearestTomb = creep.pos.findClosestByRange(validTombs);
    if (nearestTomb) return nearestTomb;
  }

  // 3️⃣ Ruins with energy
  var validRuins = [];
  for (var k = 0; k < entry.ruins.length; k++) {
    var ruin = entry.ruins[k];
    if (ruin && ruin.store && (ruin.store[RESOURCE_ENERGY] | 0) > 0) {
      validRuins.push(ruin);
    }
  }
  if (validRuins.length) {
    var nearestRuin = creep.pos.findClosestByRange(validRuins);
    if (nearestRuin) return nearestRuin;
  }

  // 4️⃣ Containers or links with energy
  var validContainers = [];
  for (var m = 0; m < entry.conts.length; m++) {
    var cont = entry.conts[m];
    if (!cont) continue;
    var stored = 0;
    if (cont.store) {
      stored = cont.store[RESOURCE_ENERGY] | 0;
    } else if (cont.energy) {
      stored = cont.energy;
    }
    if (stored > 0) {
      validContainers.push(cont);
    }
  }
  if (validContainers.length) {
    var nearestCont = creep.pos.findClosestByRange(validContainers);
    if (nearestCont) return nearestCont;
  }

  // 5️⃣ Storage, then terminal
  if (entry.storage && entry.storage.store && (entry.storage.store[RESOURCE_ENERGY] | 0) > 0) {
    return entry.storage;
  }
  if (entry.terminal && entry.terminal.store && (entry.terminal.store[RESOURCE_ENERGY] | 0) > 5000) {
    return entry.terminal;
  }

  // 6️⃣ Fallback: spawn with energy
  for (var n = 0; n < entry.spawns.length; n++) {
    var spawn = entry.spawns[n];
    if (spawn && spawn.store && (spawn.store[RESOURCE_ENERGY] | 0) > 0) {
      return spawn;
    }
  }

  return null;
}



// Withdraw energy with a quick retry if the target is unexpectedly empty.
function _withdraw(creep, target, retried) {
  if (!target) return false;

  // Handle dropped energy first
  if (target.resourceType === RESOURCE_ENERGY) {
    if (creep.pos.isNearTo(target)) {
      if (target.amount > 0) {
        return creep.pickup(target) === OK;
      }
      if (!retried) {
        var refreshRoom = Game.rooms[_getHomeName(creep)];
        var newSrc = _getEnergySource(creep, refreshRoom, true);
        if (newSrc && newSrc.id !== target.id) {
          return _withdraw(creep, newSrc, true);
        }
      }
      return false;
    } else {
      creep.travelTo(target, { range: 1, maxRooms: 1 });
      return false;
    }
  }

  // Handle structures and ruins/tombstones
  if (creep.pos.isNearTo(target)) {
    var available = 0;
    if (target.store) {
      available = target.store[RESOURCE_ENERGY] | 0;
    } else if (target.energy) {
      available = target.energy;
    }
    if (available > 0) {
      return creep.withdraw(target, RESOURCE_ENERGY) === OK;
    }
    if (!retried) {
      var refreshRoom2 = Game.rooms[_getHomeName(creep)];
      var retrySource = _getEnergySource(creep, refreshRoom2, true);
      if (retrySource && retrySource.id !== target.id) {
        return _withdraw(creep, retrySource, true);
      }
    }
  } else {
    creep.travelTo(target, { range: 1, maxRooms: 1 });
  }

  return false;
}


// Drop expired locks and orphan entries to keep the shared table clean.
function _cleanupBuildLocks() {
  var locks = _ensureLockMemory();
  for (var id in locks) {
    if (!hasOwn(locks, id)) continue;
    var lock = locks[id];
    if (!lock || lock.until < Game.time) {
      delete locks[id];
    }
  }
}

// Remove a lock association for the creep and optionally from global memory.
function _releaseLock(creep, siteId, keepGlobal) {
  var id = siteId;
  if (siteId && siteId.id) {
    id = siteId.id;
  }
  if (id && !keepGlobal) {
    var locks = _ensureLockMemory();
    if (locks[id]) {
      delete locks[id];
    }
  }
  delete creep.memory.buildSiteId;
  delete creep.memory.lockTime;
  delete creep.memory.lastProgress;
}

// Refresh the lock timer so teammates know this creep is still active.
function _refreshBuildLock(creep, site) {
  if (!site) return;
  var locks = _ensureLockMemory();
  var lock = locks[site.id];
  if (lock && lock.name === creep.name) {
    lock.until = Game.time + 20;
  }
}

function _getLockedSite(creep) {
  var id = creep.memory.buildSiteId;
  if (!id) return null;
  var locks = Memory._buildLocks;
  if (locks && locks[id]) {
    var lock = locks[id];
    if (lock.name && lock.name !== creep.name && lock.until >= Game.time) {
      _releaseLock(creep, id, true);
      return null;
    }
    if (lock.until < Game.time) {
      delete locks[id];
    }
  }
  var site = Game.getObjectById(id);
  if (!site || !site.my) {
    _releaseLock(creep, id, false);
    return null;
  }
  return site;
}

function _lockSite(creep, site) {
  if (!site) return;
  var locks = _ensureLockMemory();
  locks[site.id] = { name: creep.name, until: Game.time + 20 };
  creep.memory.buildSiteId = site.id;
  creep.memory.lockTime = Game.time;
  creep.memory.lastProgress = site.progress || 0;
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
    var lock = Memory._buildLocks && Memory._buildLocks[site.id];
    if (lock && lock.name && lock.name !== creep.name && lock.until >= Game.time) continue;
    var key = site.structureType + ':' + site.pos.x + ':' + site.pos.y;
    var task = planIndex[key];
    var isRoad = _isRoadTask(task) || _isRoadTask(site);
    var score = _priorityForSite(site, planIndex);
    if (score < 0) continue;
    if (_wouldStrand(creep, site)) continue;
    var dist = creep.pos.getRangeTo(site.pos);
    var far = site.pos.roomName !== creep.pos.roomName || dist > 25;
    var progress = site.progress || 0;
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
        var bestRoadProgress = bestRoad ? (bestRoad.progress || 0) : -1;
        if (progress > bestRoadProgress) {
          bestRoad = site;
          bestRoadScore = score;
        } else if (progress === bestRoadProgress) {
          var curRoadDist = bestRoad ? creep.pos.getRangeTo(bestRoad.pos) : 999;
          if (dist < curRoadDist) {
            bestRoad = site;
            bestRoadScore = score;
          }
        }
      }
      continue;
    }
    if (score > bestNonRoadScore) {
      bestNonRoad = site;
      bestNonRoadScore = score;
    } else if (score === bestNonRoadScore) {
      var bestProgress = bestNonRoad ? (bestNonRoad.progress || 0) : -1;
      if (progress > bestProgress) {
        bestNonRoad = site;
        bestNonRoadScore = score;
      } else if (progress === bestProgress) {
        var curDist = bestNonRoad ? creep.pos.getRangeTo(bestNonRoad.pos) : 999;
        if (dist < curDist) {
          bestNonRoad = site;
          bestNonRoadScore = score;
        }
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
  if (site.pos.roomName !== creep.pos.roomName && creep.ticksToLive < 300) return true;
  var dist = creep.pos.getRangeTo(site.pos);
  var base = dist * 2 + TTL_STRAND_BUFFER;
  var room = Game.rooms[site.pos.roomName];
  if (room) {
    var terrain = room.getTerrain();
    var hasRough = false;
    var dx = site.pos.x - creep.pos.x;
    var dy = site.pos.y - creep.pos.y;
    var steps = Math.max(Math.abs(dx), Math.abs(dy));
    if (steps > 0) {
      var sample = Math.min(steps, 10);
      for (var i = 1; i <= sample; i++) {
        var ix = creep.pos.x + Math.round(dx * i / sample);
        var iy = creep.pos.y + Math.round(dy * i / sample);
        if (ix < 0 || ix > 49 || iy < 0 || iy > 49) {
          continue;
        }
        if (terrain.get(ix, iy) === TERRAIN_MASK_SWAMP) {
          hasRough = true;
          break;
        }
      }
    }
    if (!hasRough) {
      var sx = site.pos.x;
      var sy = site.pos.y;
      for (var ox = -1; ox <= 1 && !hasRough; ox++) {
        for (var oy = -1; oy <= 1; oy++) {
          var tx = sx + ox;
          var ty = sy + oy;
          if (tx < 0 || tx > 49 || ty < 0 || ty > 49) {
            continue;
          }
          if (terrain.get(tx, ty) === TERRAIN_MASK_SWAMP) {
            hasRough = true;
            break;
          }
        }
      }
    }
    var lowRoads = false;
    if (room.lookForAtArea) {
      var top = Math.max(0, site.pos.y - 2);
      var left = Math.max(0, site.pos.x - 2);
      var bottom = Math.min(49, site.pos.y + 2);
      var right = Math.min(49, site.pos.x + 2);
      var area = room.lookForAtArea(LOOK_STRUCTURES, top, left, bottom, right, true);
      var roadCount = 0;
      for (var a = 0; a < area.length; a++) {
        var struct = area[a].structure;
        if (struct && struct.structureType === STRUCTURE_ROAD) {
          roadCount++;
          if (roadCount >= 3) {
            break;
          }
        }
      }
      if (roadCount < 3) {
        lowRoads = true;
      }
    }
    if (hasRough || lowRoads) {
      base = Math.ceil(base * 1.5);
    }
  }
  return creep.ticksToLive < base;
}

function _build(creep, site) {
  if (!site) return;
  if (creep.pos.inRangeTo(site, 3)) {
    creep.build(site);
  } else {
    creep.travelTo(site, { range: 3, maxRooms: 1, reusePath: 10 });
  }
  _refreshBuildLock(creep, site);
  var progress = site.progress || 0;
  if (creep.memory.lastProgress === undefined || progress > creep.memory.lastProgress) {
    creep.memory.lastProgress = progress;
    creep.memory.lockTime = Game.time;
  }
}

var TaskBuilder = {
  run: function (creep) {
    if (!creep || !creep.my) return;
    _cleanupBuildLocks();
    var homeName = _getHomeName(creep);
    var homeRoom = Game.rooms[homeName];
    var plan = homeRoom ? BuilderPlanner.plan(homeRoom) : null;
    var planIndex = _getPlanIndexCached(homeName, plan);

    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) < ENERGY_MIN_BUILD) {
      var src = _getEnergySource(creep, homeRoom);
      if (src) {
        _withdraw(creep, src);
        return;
      }
    }

    var current = _getLockedSite(creep);
    if (current) {
      if (_shouldAbandon(creep, current)) {
        _releaseLock(creep, current, false);
        current = null;
      } else if (creep.memory.lockTime && Game.time - creep.memory.lockTime > 50) {
        var stuckProgress = current.progress || 0;
        if (creep.memory.lastProgress !== undefined && stuckProgress <= creep.memory.lastProgress) {
          _releaseLock(creep, current, false);
          current = null;
        }
      }
      if (current && creep.memory.lastProgress === undefined) {
        creep.memory.lastProgress = current.progress || 0;
      }
    }

    if (!current) {
      current = _chooseSite(creep, planIndex);
      if (current) {
        _lockSite(creep, current);
      }
    }

    if (!current) {
      if (homeRoom) {
        var hub = _getCachedHub(homeRoom);
        if (hub) creep.travelTo(hub, { range: 2, maxRooms: 1 });
      }
      return;
    }

    _build(creep, current);
  }
};

module.exports = TaskBuilder;
var BODY_COSTS = (typeof BODYPART_COST !== 'undefined') ? BODYPART_COST : (global && global.BODYPART_COST) || {};

function builderBody(workCount, carryCount, moveCount) {
  var body = [];
  for (var w = 0; w < workCount; w++) body.push(WORK);
  for (var c = 0; c < carryCount; c++) body.push(CARRY);
  for (var m = 0; m < moveCount; m++) body.push(MOVE);
  return body;
}

var BUILDER_BODY_TIERS = [
  builderBody(6, 12, 18),
  builderBody(4, 8, 12),
  builderBody(3, 6, 9),
  builderBody(2, 4, 6),
  builderBody(2, 2, 4),
  builderBody(1, 2, 3),
  builderBody(1, 1, 2),
  builderBody(1, 1, 1)
];

function costOfBody(body) {
  var total = 0;
  if (!Array.isArray(body)) return total;
  for (var i = 0; i < body.length; i++) {
    var part = body[i];
    total += BODY_COSTS[part] || 0;
  }
  return total;
}

function pickLargestAffordable(tiers, energy) {
  if (!Array.isArray(tiers) || !tiers.length) return [];
  var available = typeof energy === 'number' ? energy : 0;
  for (var i = 0; i < tiers.length; i++) {
    var candidate = tiers[i];
    if (!Array.isArray(candidate)) continue;
    if (costOfBody(candidate) <= available) {
      return candidate.slice();
    }
  }
  return [];
}

module.exports.BODY_TIERS = BUILDER_BODY_TIERS.map(function (tier) { return tier.slice(); });
module.exports.getSpawnBody = function (energy) {
  return pickLargestAffordable(BUILDER_BODY_TIERS, energy);
};
module.exports.getSpawnSpec = function (room, ctx) {
  var context = ctx || {};
  var energy = context.availableEnergy;
  var body = module.exports.getSpawnBody(energy, room, context);
  return {
    body: body,
    namePrefix: 'builder',
    memory: { role: 'Worker_Bee', task: 'builder', home: room && room.name }
  };
};
