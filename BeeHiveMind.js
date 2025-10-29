var CoreConfig = require('core.config');
var CoreLogger = require('core.logger');
var CoreSpawn = require('core.spawn');
var BuilderPlanner = require('Task.Builder.Planner');
var TradeEnergy = require('Trade.Energy');
var TaskLuna = require('Task.Luna');
var TaskSquad = require('Task.Squad');
var TaskCombatArcher = require('Task.CombatArcher');
var TaskCombatMelee = require('Task.CombatMelee');
var TaskCombatMedic = require('Task.CombatMedic');

var BeeHiveSettings = CoreConfig.settings['BeeHiveMind'];
var getEconomySettings = (typeof CoreConfig.getEconomySettings === 'function')
  ? CoreConfig.getEconomySettings
  : function () { return BeeHiveSettings && BeeHiveSettings.ECON_DEFAULTS ? BeeHiveSettings.ECON_DEFAULTS : {}; };

var TASK_MODULE_NAME_MAP = {
  baseharvest: 'BaseHarvest',
  builder: 'Builder',
  claimer: 'Claimer',
  combatarcher: 'CombatArcher',
  combatmedic: 'CombatMedic',
  combatmelee: 'CombatMelee',
  courier: 'Courier',
  dismantler: 'Dismantler',
  idle: 'Idle',
  luna: 'Luna',
  queen: 'Queen',
  repair: 'Repair',
  scout: 'Scout',
  trucker: 'Trucker',
  upgrader: 'Upgrader',
  remoteminer: 'Luna',
  remotehauler: 'Luna',
  reserver: 'Luna',
  remoteharvest: 'Luna'
};

var MODULE_REQUIRE_CACHE = Object.create(null);
var TRY_REQUIRE_WARNINGS = Object.create(null);

var TASK_REQUIRE_MAP = {
  baseharvest: 'Task.BaseHarvest',
  courier: 'Task.Courier',
  trucker: 'Task.Trucker',
  queen: 'Task.Queen',
  builder: 'Task.Builder',
  upgrader: 'Task.Upgrader',
  repair: 'Task.Repair',
  scout: 'Task.Scout',
  combatarcher: 'Task.CombatArcher',
  combatmelee: 'Task.CombatMelee',
  combatmedic: 'Task.CombatMedic',
  dismantler: 'Task.Dismantler',
  claimer: 'Task.Claimer',
  luna: 'Task.Luna'
};

var HARVESTER_DEFAULTS = BeeHiveSettings.HARVESTER_DEFAULTS;

function ensureEconomyConfig() {
  var defaults = getEconomySettings();
  var roadDefaults = defaults.roads || { minRCL: 3, disableGate: false };
  var remoteRoadDefaults = defaults.remoteRoads || { minStorageEnergy: 40000 };
  var queenDefaults = defaults.queen || { allowCourierFallback: true };

  if (!global.__beeEconomyConfig) {
    global.__beeEconomyConfig = {
      STORAGE_ENERGY_MIN_BEFORE_REMOTES: defaults.STORAGE_ENERGY_MIN_BEFORE_REMOTES,
      MAX_ACTIVE_REMOTES: defaults.MAX_ACTIVE_REMOTES,
      ROAD_REPAIR_THRESHOLD: defaults.ROAD_REPAIR_THRESHOLD,
      STORAGE_HEALTHY_RATIO: defaults.STORAGE_HEALTHY_RATIO,
      CPU_MIN_BUCKET: defaults.CPU_MIN_BUCKET,
      roads: {
        minRCL: roadDefaults.minRCL,
        disableGate: roadDefaults.disableGate
      },
      remoteRoads: {
        minStorageEnergy: remoteRoadDefaults.minStorageEnergy
      },
      queen: {
        allowCourierFallback: queenDefaults.allowCourierFallback
      }
    };
  } else {
    if (!global.__beeEconomyConfig.roads) {
      global.__beeEconomyConfig.roads = {
        minRCL: roadDefaults.minRCL,
        disableGate: roadDefaults.disableGate
      };
    } else {
      if (typeof global.__beeEconomyConfig.roads.minRCL !== 'number') {
        global.__beeEconomyConfig.roads.minRCL = roadDefaults.minRCL;
      }
      if (typeof global.__beeEconomyConfig.roads.disableGate !== 'boolean') {
        global.__beeEconomyConfig.roads.disableGate = roadDefaults.disableGate;
      }
    }
    if (!global.__beeEconomyConfig.remoteRoads) {
      global.__beeEconomyConfig.remoteRoads = {
        minStorageEnergy: remoteRoadDefaults.minStorageEnergy
      };
    } else if (typeof global.__beeEconomyConfig.remoteRoads.minStorageEnergy !== 'number') {
      global.__beeEconomyConfig.remoteRoads.minStorageEnergy = remoteRoadDefaults.minStorageEnergy;
    }
    if (!global.__beeEconomyConfig.queen) {
      global.__beeEconomyConfig.queen = {
        allowCourierFallback: queenDefaults.allowCourierFallback
      };
    } else if (typeof global.__beeEconomyConfig.queen.allowCourierFallback !== 'boolean') {
      global.__beeEconomyConfig.queen.allowCourierFallback = queenDefaults.allowCourierFallback;
    }
    if (typeof global.__beeEconomyConfig.STORAGE_HEALTHY_RATIO !== 'number') {
      global.__beeEconomyConfig.STORAGE_HEALTHY_RATIO = defaults.STORAGE_HEALTHY_RATIO;
    }
    if (typeof global.__beeEconomyConfig.CPU_MIN_BUCKET !== 'number') {
      global.__beeEconomyConfig.CPU_MIN_BUCKET = defaults.CPU_MIN_BUCKET;
    }
    if (typeof global.__beeEconomyConfig.STORAGE_ENERGY_MIN_BEFORE_REMOTES !== 'number') {
      global.__beeEconomyConfig.STORAGE_ENERGY_MIN_BEFORE_REMOTES = defaults.STORAGE_ENERGY_MIN_BEFORE_REMOTES;
    }
    if (typeof global.__beeEconomyConfig.MAX_ACTIVE_REMOTES !== 'number') {
      global.__beeEconomyConfig.MAX_ACTIVE_REMOTES = defaults.MAX_ACTIVE_REMOTES;
    }
    if (typeof global.__beeEconomyConfig.ROAD_REPAIR_THRESHOLD !== 'number') {
      global.__beeEconomyConfig.ROAD_REPAIR_THRESHOLD = defaults.ROAD_REPAIR_THRESHOLD;
    }
  }
  return global.__beeEconomyConfig;
}

function hasOwn(obj, key) {
  return !!(obj && Object.prototype.hasOwnProperty.call(obj, key));
}

function CanonicalTaskName(task) {
  if (!task) return null;
  var lower = String(task).toLowerCase();
  if (!lower.length) return null;
  if (hasOwn(TASK_MODULE_NAME_MAP, lower)) {
    return TASK_MODULE_NAME_MAP[lower];
  }
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function tryRequire(moduleName) {
  if (!moduleName) return null;
  if (hasOwn(MODULE_REQUIRE_CACHE, moduleName)) {
    return MODULE_REQUIRE_CACHE[moduleName];
  }
  try {
    var mod = require(moduleName);
    MODULE_REQUIRE_CACHE[moduleName] = mod || null;
    return MODULE_REQUIRE_CACHE[moduleName];
  } catch (err) {
    MODULE_REQUIRE_CACHE[moduleName] = null;
    if (moduleName && !TRY_REQUIRE_WARNINGS[moduleName]) {
      TRY_REQUIRE_WARNINGS[moduleName] = Game && Game.time ? Game.time : 1;
      var loggerLevels = (CoreLogger && CoreLogger.LOG_LEVEL) ? CoreLogger.LOG_LEVEL : null;
      if (CoreLogger && typeof CoreLogger.shouldLog === 'function' && typeof hiveLog !== 'undefined' && hiveLog && typeof hiveLog.debug === 'function' && loggerLevels && typeof loggerLevels.DEBUG === 'number') {
        if (CoreLogger.shouldLog(loggerLevels.DEBUG)) {
          hiveLog.debug('Failed to require module', moduleName, err);
        }
      }
    }
    return null;
  }
}

function _tryRequireTask(taskName) {
  if (!taskName) return null;
  var lower = String(taskName).toLowerCase();
  var moduleName = TASK_REQUIRE_MAP[lower];
  if (!moduleName) {
    var canonical = CanonicalTaskName(taskName);
    moduleName = canonical ? 'Task.' + canonical : null;
  }
  return moduleName ? tryRequire(moduleName) : null;
}

function _normalizeBodyTier(entry) {
  if (!entry) return null;
  var body;
  var cost = null;
  if (Array.isArray(entry)) {
    body = entry;
  } else if (Array.isArray(entry.body)) {
    body = entry.body;
    if (typeof entry.cost === 'number') cost = entry.cost;
  } else if (Array.isArray(entry.parts)) {
    body = entry.parts;
    if (typeof entry.cost === 'number') cost = entry.cost;
  }
  if (!body || !body.length) return null;
  var normalized = { body: body.slice() };
  normalized.cost = cost != null ? cost : CoreSpawn.costOfBody(body);
  if (normalized.cost <= 0) return null;
  return normalized;
}

function evaluateBodyTiers(tiers, available, capacity) {
  var normalized = [];
  if (Array.isArray(tiers)) {
    for (var i = 0; i < tiers.length; i++) {
      var norm = _normalizeBodyTier(tiers[i]);
      if (norm) normalized.push(norm);
    }
  }

  var result = {
    tiers: normalized,
    availableBody: [],
    availableCost: 0,
    capacityBody: [],
    capacityCost: 0,
    idealBody: [],
    idealCost: 0,
    minCost: 0
  };

  if (!normalized.length) {
    return result;
  }

  var first = normalized[0];
  var last = normalized[normalized.length - 1];
  result.idealBody = first.body.slice();
  result.idealCost = first.cost;
  result.minCost = last.cost;

  var foundCapacity = false;
  for (var j = 0; j < normalized.length; j++) {
    var tier = normalized[j];
    if (!foundCapacity && tier.cost <= capacity) {
      result.capacityBody = tier.body.slice();
      result.capacityCost = tier.cost;
      foundCapacity = true;
    }
    if (!result.availableBody.length && tier.cost <= available) {
      result.availableBody = tier.body.slice();
      result.availableCost = tier.cost;
    }
  }

  if (!foundCapacity) {
    result.capacityBody = last.body.slice();
    result.capacityCost = last.cost;
  }

  if (!result.availableBody.length && result.capacityBody.length && result.capacityCost <= available) {
    result.availableBody = result.capacityBody.slice();
    result.availableCost = result.capacityCost;
  }

  return result;
}

function looksLikeRoomName(name) {
  if (typeof name !== 'string') return false;
  if (name.length < 4) return false;
  var first = name.charAt(0);
  if (first !== 'W' && first !== 'E') return false;
  if (name.indexOf('N') === -1 && name.indexOf('S') === -1) return false;
  return true;
}

function normalizeRemoteRooms(input) {
  var result = [];
  var seen = Object.create(null);

  function addName(value) {
    if (!value) return;
    var name = null;
    if (typeof value === 'string') {
      name = value;
    } else if (typeof value.roomName === 'string') {
      name = value.roomName;
    } else if (typeof value.name === 'string') {
      name = value.name;
    }
    if (!name) return;
    if (seen[name]) return;
    seen[name] = true;
    result.push(name);
  }

  if (!input) {
    return result;
  }

  if (typeof input === 'string') {
    addName(input);
    return result;
  }

  if (Array.isArray(input)) {
    for (var i = 0; i < input.length; i++) {
      addName(input[i]);
    }
    return result;
  }

  if (typeof input === 'object') {
    if (typeof input.roomName === 'string' || typeof input.name === 'string') {
      addName(input);
      return result;
    }
    for (var key in input) {
      if (!hasOwn(input, key)) continue;
      addName(input[key]);
      if (looksLikeRoomName(key)) {
        addName(key);
      }
    }
  }

  return result;
}

var _remoteAssignmentsTrace = global.__beeRemoteAssignmentsTrace || (global.__beeRemoteAssignmentsTrace = { logged: false });

function _readRemoteAssignments(source) {
  if (source && typeof source === 'object') {
    return source;
  }
  if (!Memory || !Memory.remoteAssignments || typeof Memory.remoteAssignments !== 'object') {
    if (Memory && Memory.__traceRemotes === true && !_remoteAssignmentsTrace.logged) {
      console.log('[REMOTES] remoteAssignments missing or invalid - skipping optional integration');
      _remoteAssignmentsTrace.logged = true;
    }
    return null;
  }
  return Memory.remoteAssignments;
}

function addRemoteCandidate(target, seen, remoteName) {
  if (!remoteName || typeof remoteName !== 'string') return;
  if (!looksLikeRoomName(remoteName)) return;
  if (seen[remoteName]) return;
  seen[remoteName] = true;
  target.push(remoteName);
}

function processAssignmentRecord(homeName, key, record, target, seen) {
  if (!homeName || !record) return;
  if (typeof record === 'string') {
    if (key === homeName && looksLikeRoomName(record)) {
      addRemoteCandidate(target, seen, record);
    } else if (looksLikeRoomName(key) && record === homeName) {
      addRemoteCandidate(target, seen, key);
    }
    return;
  }
  if (Array.isArray(record)) {
    for (var i = 0; i < record.length; i++) {
      processAssignmentRecord(homeName, key, record[i], target, seen);
    }
    return;
  }
  if (typeof record !== 'object') return;

  var remoteName = null;
  if (typeof record.roomName === 'string') remoteName = record.roomName;
  else if (typeof record.remote === 'string') remoteName = record.remote;
  else if (typeof record.targetRoom === 'string') remoteName = record.targetRoom;
  else if (typeof record.room === 'string') remoteName = record.room;
  else if (looksLikeRoomName(key)) remoteName = key;

  var assignedHome = null;
  if (typeof record.home === 'string') assignedHome = record.home;
  else if (typeof record.homeRoom === 'string') assignedHome = record.homeRoom;
  else if (typeof record.spawn === 'string') assignedHome = record.spawn;
  else if (typeof record.origin === 'string') assignedHome = record.origin;
  else if (typeof record.base === 'string') assignedHome = record.base;
  else if (!looksLikeRoomName(key)) assignedHome = key;

  if (assignedHome === homeName && typeof remoteName === 'string') {
    addRemoteCandidate(target, seen, remoteName);
  }

  for (var nestedKey in record) {
    if (!hasOwn(record, nestedKey)) continue;
    if (nestedKey === 'roomName' || nestedKey === 'remote' || nestedKey === 'targetRoom' || nestedKey === 'room' ||
        nestedKey === 'home' || nestedKey === 'homeRoom' || nestedKey === 'spawn' || nestedKey === 'origin' || nestedKey === 'base') {
      continue;
    }
    processAssignmentRecord(homeName, nestedKey, record[nestedKey], target, seen);
  }
}

function gatherRemotesFromAssignments(homeName, target, seen) {
  if (!homeName) return;
  var assignments = _readRemoteAssignments();
  if (!assignments) return;
  for (var key in assignments) {
    if (!hasOwn(assignments, key)) continue;
    processAssignmentRecord(homeName, key, assignments[key], target, seen);
  }
}

function gatherRemotesFromLedger(homeName, target, seen) {
  if (!homeName || !Memory || !Memory.remotes) return;
  for (var remoteName in Memory.remotes) {
    if (!hasOwn(Memory.remotes, remoteName)) continue;
    if (remoteName === 'version') continue;
    var entry = Memory.remotes[remoteName];
    if (!entry || typeof entry !== 'object') continue;
    var ledgerHome = null;
    if (typeof entry.home === 'string') ledgerHome = entry.home;
    else if (typeof entry.homeRoom === 'string') ledgerHome = entry.homeRoom;
    else if (typeof entry.origin === 'string') ledgerHome = entry.origin;
    if (ledgerHome !== homeName) continue;
    var finalRemote = null;
    if (typeof entry.roomName === 'string') finalRemote = entry.roomName;
    else finalRemote = remoteName;
    addRemoteCandidate(target, seen, finalRemote);
  }
}

function collectHomeRemotes(homeName, baseList) {
  var target = [];
  var seen = Object.create(null);
  var base = normalizeRemoteRooms(baseList);
  for (var i = 0; i < base.length; i++) {
    addRemoteCandidate(target, seen, base[i]);
  }
  gatherRemotesFromAssignments(homeName, target, seen);
  gatherRemotesFromLedger(homeName, target, seen);
  return target;
}

function countSourcesInMemory(mem) {
  if (!mem) return 0;
  if (mem.sources && typeof mem.sources === 'object') {
    var count = 0;
    for (var key in mem.sources) {
      if (hasOwn(mem.sources, key)) count += 1;
    }
    return count;
  }
  if (mem.intel && typeof mem.intel.sources === 'number') {
    return mem.intel.sources | 0;
  }
  return 0;
}

var _constructionCache = global.__beeConstructionCache || (global.__beeConstructionCache = {
  tick: -1,
  list: [],
  byRoom: {},
  counts: {}
});

function _refreshConstructionCache() {
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

function constructionSiteCache() {
  return _refreshConstructionCache();
}

function tallyCreeps(options) {
  var opts = options || {};
  var includeMemory = opts.includeMemory === true;
  var field = typeof opts.field === 'string' ? opts.field : null;
  var filter = typeof opts.filter === 'function' ? opts.filter : null;
  var selector = typeof opts.valueSelector === 'function' ? opts.valueSelector : null;
  var defaultValue = opts.defaultValue;
  var counts = Object.create(null);
  var total = 0;

  function tallyOne(memory, creep, isLive) {
    var mem = memory || {};
    if (filter && !filter(mem, creep, isLive)) {
      return;
    }
    var value = null;
    if (selector) {
      value = selector(mem, creep, isLive);
    } else if (field && mem) {
      value = mem[field];
    }
    if ((value === undefined || value === null) && defaultValue !== undefined) {
      if (typeof defaultValue === 'function') {
        value = defaultValue(mem, creep, isLive);
      } else {
        value = defaultValue;
      }
    }
    if (value === undefined || value === null) {
      return;
    }
    counts[value] = (counts[value] || 0) + 1;
    total += 1;
  }

  for (var name in Game.creeps) {
    if (!hasOwn(Game.creeps, name)) {
      continue;
    }
    var creep = Game.creeps[name];
    if (!creep) {
      continue;
    }
    tallyOne(creep.memory, creep, true);
  }

  if (includeMemory && Memory && Memory.creeps) {
    for (var memName in Memory.creeps) {
      if (!hasOwn(Memory.creeps, memName)) {
        continue;
      }
      if (Game.creeps[memName]) {
        continue;
      }
      tallyOne(Memory.creeps[memName], null, false);
    }
  }

  return {
    counts: counts,
    total: total
  };
}

function isCpuBucketHealthy(minBucket) {
  if (!Game.cpu || Game.cpu.bucket == null) return true;
  var threshold = minBucket != null ? minBucket : 0;
  return Game.cpu.bucket >= threshold;
}

function getStructureStoreState(structure, resourceType) {
  var state = { energy: 0, capacity: 0, ratio: 0 };
  if (!structure) return state;
  var store = structure.store;
  if (store && typeof store.getCapacity === 'function') {
    state.capacity = store.getCapacity(resourceType) || 0;
    state.energy = store[resourceType] || 0;
  } else if (store && store[resourceType] != null && structure.storeCapacity != null) {
    state.capacity = structure.storeCapacity;
    state.energy = store[resourceType] || 0;
  } else if (structure.storeCapacity != null && structure.energy != null) {
    state.capacity = structure.storeCapacity;
    state.energy = structure.energy;
  }
  if (state.capacity > 0) {
    state.ratio = state.energy / state.capacity;
  }
  return state;
}

function storageEnergyState(room) {
  var state = { energy: 0, capacity: 0, ratio: 0 };
  if (!room) return state;
  var storage = room.storage;
  if (storage) {
    state = getStructureStoreState(storage, RESOURCE_ENERGY);
  }
  return state;
}

function isStorageHealthy(room, ratioThreshold) {
  var state = storageEnergyState(room);
  var threshold = ratioThreshold != null ? ratioThreshold : 0;
  return state.capacity > 0 && state.ratio >= threshold;
}

function shouldLogThrottled(store, key, interval) {
  if (!store) return true;
  var tick = Game.time | 0;
  var last = store[key] || 0;
  if (tick - last < interval) {
    return false;
  }
  store[key] = tick;
  return true;
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

function summarizeRemotes(remoteNames, options) {
  var summary = {
    list: [],
    set: Object.create(null),
    totalSources: 0,
    remoteCount: 0,
    activeAssignments: 0
  };

  if (!remoteNames) {
    return summary;
  }

  var list = [];
  if (Array.isArray(remoteNames)) {
    for (var i = 0; i < remoteNames.length; i++) {
      if (typeof remoteNames[i] === 'string') {
        list.push(remoteNames[i]);
      }
    }
  } else if (typeof remoteNames === 'string') {
    list.push(remoteNames);
  }

  if (!list.length) {
    return summary;
  }

  summary.list = list.slice();
  summary.remoteCount = list.length;

  var remoteSet = summary.set;
  var roomsMem = (options && options.roomsMemory) || (Memory && Memory.rooms) || {};
  var remoteLedger = (options && options.remoteLedger) || (Memory && Memory.remotes) || null;
  var totalSources = 0;

  for (var j = 0; j < list.length; j++) {
    var remoteName = list[j];
    remoteSet[remoteName] = true;

    var mem = roomsMem && roomsMem[remoteName] ? roomsMem[remoteName] : {};
    var ledger = remoteLedger && typeof remoteLedger === 'object' ? remoteLedger[remoteName] : null;
    var status = ledger && ledger.status;
    var blockedUntil = ledger && typeof ledger.blockedUntil === 'number' ? ledger.blockedUntil : 0;
    var isBlocked = false;

    if (status === 'BLOCKED') {
      if (blockedUntil > (Game.time || 0)) {
        isBlocked = true;
      } else if (blockedUntil && ((Game.time || 0) - blockedUntil) > 1500) {
        status = 'DEGRADED';
      } else if (!blockedUntil) {
        var auditAge = ledger && typeof ledger.lastAudit === 'number' ? ((Game.time || 0) - ledger.lastAudit) : 0;
        if (auditAge <= 1500) {
          isBlocked = true;
        }
      }
    }

    var hostileFlag = !!(mem && mem.hostile);
    var hostileTick = mem ? (mem.hostileTick || mem.hostileSince || mem.hostileLastSeen || mem.lastHostile || mem.hostileSeen || 0) : 0;
    if (hostileFlag && hostileTick && ((Game.time || 0) - hostileTick) > 1500) {
      hostileFlag = false;
    }
    if (hostileFlag && status !== 'BLOCKED') {
      hostileFlag = false;
    }

    if (hostileFlag || isBlocked) {
      continue;
    }

    if (mem && mem._invaderLock && mem._invaderLock.locked) {
      var lockTick = typeof mem._invaderLock.t === 'number' ? mem._invaderLock.t : null;
      if (lockTick === null || ((Game.time || 0) - lockTick) <= 1500) {
        continue;
      }
    }

    var sourceCount = 0;
    if (Game && Game.rooms && Game.rooms[remoteName]) {
      var visibleRoom = Game.rooms[remoteName];
      var sources = visibleRoom && typeof visibleRoom.find === 'function' ? visibleRoom.find(FIND_SOURCES) : [];
      sourceCount = Array.isArray(sources) ? sources.length : 0;
    }

    if (sourceCount === 0) {
      sourceCount = countSourcesInMemory(mem);
    }

    if (sourceCount === 0 && mem && Array.isArray(mem.sources)) {
      sourceCount = mem.sources.length;
    }

    totalSources += sourceCount;
  }

  if (totalSources <= 0) {
    totalSources = list.length;
  }

  var assignments = null;
  if (options && options.assignments && typeof options.assignments === 'object') {
    assignments = options.assignments;
  } else {
    assignments = _readRemoteAssignments();
  }
  if (!assignments) assignments = {};
  var active = 0;
  if (assignments && typeof assignments === 'object') {
    for (var key in assignments) {
      if (!hasOwn(assignments, key)) {
        continue;
      }
      var entry = assignments[key];
      if (!entry) {
        continue;
      }
      var remoteRoomName = null;
      if (typeof entry.roomName === 'string') {
        remoteRoomName = entry.roomName;
      } else if (typeof entry.room === 'string') {
        remoteRoomName = entry.room;
      }
      if (!remoteRoomName || !remoteSet[remoteRoomName]) {
        continue;
      }
      var count = entry.count | 0;
      if (!count && entry.owner) {
        count = 1;
      }
      if (count > 0) {
        active += count;
      }
    }
  }

  summary.totalSources = totalSources;
  summary.activeAssignments = active;

  return summary;
}

var _cachedUsername = null;

function getMyUsername() {
  if (_cachedUsername) return _cachedUsername;
  var name = null;
  var k;
  for (k in Game.spawns) {
    if (!hasOwn(Game.spawns, k)) continue;
    var sp = Game.spawns[k];
    if (sp && sp.owner && sp.owner.username) { name = sp.owner.username; break; }
  }
  if (!name) {
    for (k in Game.creeps) {
      if (!hasOwn(Game.creeps, k)) continue;
      var c = Game.creeps[k];
      if (c && c.owner && c.owner.username) { name = c.owner.username; break; }
    }
  }
  _cachedUsername = name || 'me';
  return _cachedUsername;
}

function isAllyUsername(username) {
  if (!username) return false;
  if (TaskSquad && typeof TaskSquad.isAlly === 'function') {
    return TaskSquad.isAlly(username);
  }
  return false;
}

function isEnemyUsername(username) {
  if (!username) return false;
  if (isAllyUsername(username)) return false;
  var mine = getMyUsername();
  if (mine && username === mine) return false;
  return true;
}

function consumeAttackTargets(options) {
  Memory.attackTargets = Memory.attackTargets || {};
  var results = [];
  if (!Memory.attackTargets || typeof Memory.attackTargets !== 'object') {
    return results;
  }
  var now = Game.time | 0;
  var maxAge = options && options.maxAge != null ? options.maxAge : 2000;
  var requeueInterval = options && options.requeueInterval != null ? options.requeueInterval : 150;
  for (var rn in Memory.attackTargets) {
    if (!hasOwn(Memory.attackTargets, rn)) continue;
    var rec = Memory.attackTargets[rn];
    if (!rec || typeof rec !== 'object') {
      delete Memory.attackTargets[rn];
      continue;
    }
    var roomName = rec.roomName || rn;
    if (!roomName) {
      delete Memory.attackTargets[rn];
      continue;
    }
    if (!isValidRoomName(roomName)) {
      delete Memory.attackTargets[rn];
      continue;
    }
    var owner = rec.owner || null;
    if (owner && !isEnemyUsername(owner)) {
      continue;
    }
    var updatedAt = rec.updatedAt | 0;
    if (maxAge > 0 && (now - updatedAt) > maxAge) {
      delete Memory.attackTargets[rn];
      continue;
    }
    var lastConsumed = rec.lastConsumedAt | 0;
    if (requeueInterval > 0 && (now - lastConsumed) < requeueInterval) {
      continue;
    }
    rec.lastConsumedAt = now;
    Memory.attackTargets[rn] = rec;
    results.push({
      roomName: roomName,
      owner: owner,
      type: rec.type || null,
      count: rec.count || 0,
      threat: rec.threat || null,
      updatedAt: updatedAt,
      source: rec.source || null
    });
  }
  return results;
}

var ECON_CFG = ensureEconomyConfig();

var HARVESTER_CFG = HARVESTER_DEFAULTS;

var LOG_LEVEL = CoreLogger.LOG_LEVEL;
var hiveLog = CoreLogger.createLogger('HiveMind', LOG_LEVEL.BASIC);

var SQUAD_ROLE_RUNNERS = {
  CombatArcher: (TaskCombatArcher && typeof TaskCombatArcher.run === 'function') ? TaskCombatArcher.run : null,
  CombatMelee: (TaskCombatMelee && typeof TaskCombatMelee.run === 'function') ? TaskCombatMelee.run : null,
  CombatMedic: (TaskCombatMedic && typeof TaskCombatMedic.run === 'function') ? TaskCombatMedic.run : null
};

function shouldDebugSquad() {
  return !!(Memory && Memory.DEBUG_SQUAD_SPAWN);
}

function debugSquadLog(message) {
  if (!shouldDebugSquad()) return;
  if (hiveLog && typeof hiveLog.info === 'function') {
    hiveLog.info(message);
  }
}

function hasManualSquadFlag(roomName) {
  if (!roomName) return false;
  var squadFlags = Memory && Memory.squadFlags;
  if (!squadFlags || !squadFlags.manual) {
    return false;
  }
  var manual = squadFlags.manual;
  var bindings = squadFlags.bindings || {};
  for (var flagName in manual) {
    if (!hasOwn(manual, flagName)) continue;
    if (!manual[flagName]) continue;
    if (bindings[flagName] === roomName) {
      return true;
    }
    if (Memory && Memory.squads) {
      var squadId = null;
      if (flagName.indexOf('Squad_') === 0) {
        squadId = flagName.substr(6);
      } else if (flagName.indexOf('Squad') === 0) {
        squadId = flagName.substr(5);
      } else {
        squadId = flagName;
      }
      var bucket = Memory.squads[squadId];
      if (bucket && bucket.home === roomName) {
        return true;
      }
    }
  }
  return false;
}

function planHasManualOverride(plan) {
  if (!plan || !plan.squadId) return false;
  var squadFlags = Memory && Memory.squadFlags;
  if (!squadFlags || !squadFlags.manual) {
    return false;
  }
  var manual = squadFlags.manual;
  var candidates = ['Squad' + plan.squadId, 'Squad_' + plan.squadId];
  for (var i = 0; i < candidates.length; i++) {
    var name = candidates[i];
    if (hasOwn(manual, name) && manual[name]) {
      return true;
    }
  }
  return false;
}

function runSquadRole(creep) {
  if (!creep || !creep.memory) return;
  var role = creep.memory.squadRole || creep.memory.task;
  if (!role) return;
  var handler = SQUAD_ROLE_RUNNERS[role];
  if (typeof handler === 'function') {
    handler(creep);
    return;
  }
}

var ROLE_DISPATCH = Object.freeze({
  Worker_Bee: CoreSpawn.run,
  squad: runSquadRole,
  CombatArcher: SQUAD_ROLE_RUNNERS.CombatArcher,
  CombatMelee: SQUAD_ROLE_RUNNERS.CombatMelee,
  CombatMedic: SQUAD_ROLE_RUNNERS.CombatMedic
});

var DYING_SOON_TTL = BeeHiveSettings.DYING_SOON_TTL;
var DEFAULT_LUNA_PER_SOURCE = (TaskLuna && typeof TaskLuna.MAX_LUNA_PER_SOURCE === 'number')
  ? TaskLuna.MAX_LUNA_PER_SOURCE
  : 1;

var GLOBAL_CACHE = global.__BHM_CACHE;
if (!GLOBAL_CACHE || GLOBAL_CACHE.__ver !== 'BHM_CACHE_v1') {
  GLOBAL_CACHE = { __ver: 'BHM_CACHE_v1', tick: -1 };
  global.__BHM_CACHE = GLOBAL_CACHE;
}

var ECONOMIC_ROLE_MAP = Object.freeze({
  baseharvest: true,
  courier: true,
  queen: true,
  builder: true,
  upgrader: true
});

function cloneCounts(source) {
  var result = Object.create(null);
  if (!source) return result;
  for (var key in source) {
    if (!hasOwn(source, key)) continue;
    result[key] = source[key];
  }
  return result;
}

function ensureEconomyRoomRecord(target, roomName) {
  if (!target || !roomName) {
    return null;
  }
  var record = target[roomName];
  if (!record) {
    record = {
      baseharvest: 0,
      courier: 0,
      queen: 0,
      builder: 0,
      upgrader: 0
    };
    target[roomName] = record;
  }
  return record;
}

function deriveEconomyDecisionState(room, harvesterIntel, economyMap) {
  var state = {
    hasHarvester: false,
    hasCourier: false,
    hasQueen: false,
    hasBuilder: false,
    hasUpgrader: false,
    storageHealthy: false,
    allEssentialPresent: false,
    recoveryMode: false,
    allowCombat: false,
    harvesterCount: 0,
    courierCount: 0,
    queenCount: 0,
    builderCount: 0,
    upgraderCount: 0,
    storageEnergy: 0,
    storageCapacity: 0
  };

  if (!room) {
    return state;
  }

  var roomName = room.name;
  var econCounts = economyMap && economyMap[roomName];
  var activeHarvesters = 0;
  var hatchingHarvesters = 0;
  var harvesterCount = 0;
  if (harvesterIntel) {
    activeHarvesters = harvesterIntel.active | 0;
    hatchingHarvesters = harvesterIntel.hatching | 0;
    harvesterCount = (harvesterIntel.coverage | 0);
  }
  state.harvesterCount = harvesterCount;
  state.harvesterActive = activeHarvesters;
  state.harvesterHatching = hatchingHarvesters;
  state.hasHarvester = harvesterCount > 0;

  if (econCounts) {
    state.courierCount = econCounts.courier | 0;
    state.queenCount = econCounts.queen | 0;
    state.builderCount = econCounts.builder | 0;
    state.upgraderCount = econCounts.upgrader | 0;
    state.hasCourier = state.courierCount > 0;
    state.hasQueen = state.queenCount > 0;
    state.hasBuilder = state.builderCount > 0;
    state.hasUpgrader = state.upgraderCount > 0;
  }

  var storageState = storageEnergyState(room);
  state.storageCapacity = storageState.capacity;
  state.storageEnergy = storageState.energy;
  var healthyRatio = (ECON_CFG && typeof ECON_CFG.STORAGE_HEALTHY_RATIO === 'number')
    ? ECON_CFG.STORAGE_HEALTHY_RATIO
    : 0.7;
  if (isStorageHealthy(room, healthyRatio)) {
    state.storageHealthy = true;
  }

  state.allEssentialPresent = state.hasHarvester && state.hasCourier && state.hasQueen && state.hasBuilder && state.hasUpgrader;
  state.recoveryMode = !state.hasHarvester || !state.hasCourier;
  // Combat spawning is only permitted when the economy is healthy or buffered by storage,
  // unless a manual squad flag authorizes a minimal economy override.
  var baselineAllow = !state.recoveryMode && (state.storageHealthy || state.allEssentialPresent);
  var manualOverride = hasManualSquadFlag(roomName);
  var minimalEconomyReady = state.hasHarvester && (state.hasCourier || state.hasQueen);
  var forceAllow = !!(Memory && Memory.combat && Memory.combat.forceAllow);
  var gateReason = baselineAllow ? 'baseline' : 'suppressed';
  state.allowCombat = baselineAllow;
  if (!state.allowCombat && manualOverride && minimalEconomyReady) {
    state.allowCombat = true;
    gateReason = 'manual';
  }
  if (!state.allowCombat && forceAllow) {
    state.allowCombat = true;
    gateReason = 'force';
  } else if (state.allowCombat && forceAllow) {
    gateReason = 'force';
  }
  if (state.allowCombat && gateReason === 'manual') {
    debugSquadLog('[CombatGate] Manual flag present; allowing combat at ' + roomName + ' with minimal economy.');
  } else if (state.allowCombat && gateReason === 'force') {
    debugSquadLog('[CombatGate] Force override enabled; allowing combat at ' + roomName + '.');
  } else if (shouldDebugSquad()) {
    debugSquadLog('[CombatGate] ' + roomName + ' allowCombat=' + state.allowCombat + ' reason=' + gateReason + ' (harv=' + state.harvesterCount + ' courier=' + state.courierCount + ' queen=' + state.queenCount + ')');
  }

  return state;
}

function determineHarvesterRoom(memory, creep) {
  if (!memory) memory = {};
  var keys = ['home', '_home', 'spawnRoom', 'origin', 'targetRoom'];
  for (var i = 0; i < keys.length; i++) {
    var value = memory[keys[i]];
    if (typeof value === 'string' && value.length) {
      return value;
    }
  }
  if (creep && creep.room && creep.room.name) {
    return creep.room.name;
  }
  return null;
}

function determineBirthBody(mem, creep) {
  return (mem && mem.birthBody && mem.birthBody.slice)
    ? mem.birthBody
    : (creep && creep.body ? creep.body.map(function (part) { return part.type; }) : []);
}

function createHarvesterIntelRecord() {
  return { active: 0, hatching: 0, lowestTtl: null, highestCost: 0, sources: 0, desiredCount: 1, coverage: 0 };
}

function ensureHarvesterIntelForRoom(room, cache) {
  if (!room || !room.name) {
    return createHarvesterIntelRecord();
  }
  cache = cache || prepareTickCaches();
  var intelMap = cache.harvesterIntelByRoom;
  if (!intelMap) {
    intelMap = Object.create(null);
    cache.harvesterIntelByRoom = intelMap;
  }
  var info = intelMap[room.name];
  if (!info) {
    info = createHarvesterIntelRecord();
    intelMap[room.name] = info;
  }
  return info;
}

function planHarvesterSpawn(room, spawnEnergy, spawnCapacity, intel) {
  var plan = { shouldSpawn: false, body: [], cost: 0 };
  if (!room) return plan;

  var TaskBaseHarvest = _tryRequireTask('baseharvest');
  var targetContext = { mode: 'target', intel: intel, availableEnergy: spawnEnergy, capacityEnergy: spawnCapacity };
  var fallbackContext = { mode: 'fallback', intel: intel, availableEnergy: spawnEnergy, capacityEnergy: spawnCapacity };
  var targetBody = (TaskBaseHarvest && typeof TaskBaseHarvest.getSpawnBody === 'function')
    ? TaskBaseHarvest.getSpawnBody(spawnCapacity, room, targetContext)
    : [];
  var targetCost = CoreSpawn.costOfBody(targetBody);
  var fallbackBody = (TaskBaseHarvest && typeof TaskBaseHarvest.getSpawnBody === 'function')
    ? TaskBaseHarvest.getSpawnBody(spawnEnergy, room, fallbackContext)
    : [];
  var fallbackCost = CoreSpawn.costOfBody(fallbackBody);

  var desired = intel && typeof intel.desiredCount === 'number' ? intel.desiredCount : 1;
  var coverage = intel && typeof intel.coverage === 'number' ? intel.coverage : 0;
  var active = intel && typeof intel.active === 'number' ? intel.active : 0;
  var hatching = intel && typeof intel.hatching === 'number' ? intel.hatching : 0;
  var lowestTtl = (intel && typeof intel.lowestTtl === 'number') ? intel.lowestTtl : null;
  var highestCost = intel && typeof intel.highestCost === 'number' ? intel.highestCost : 0;

  if (coverage < desired) {
    var canAffordTarget = targetBody && targetBody.length && spawnEnergy >= targetCost && targetCost > 0;
    var chosenBody = canAffordTarget ? targetBody : fallbackBody;
    var chosenCost = canAffordTarget ? targetCost : fallbackCost;
    if (chosenBody && chosenBody.length && chosenCost > 0 && spawnEnergy >= chosenCost) {
      plan.shouldSpawn = true;
      plan.body = chosenBody;
      plan.cost = chosenCost;
    }
    return plan;
  }

  if (active <= 0) {
    return plan;
  }

  if (lowestTtl === null || lowestTtl > HARVESTER_CFG.RENEWAL_TTL) {
    return plan;
  }

  if (hatching > 0) {
    return plan;
  }

  var canUpgrade = targetCost > highestCost;
  if (targetBody && targetBody.length && targetCost > 0 && spawnEnergy >= targetCost) {
    plan.shouldSpawn = true;
    plan.body = targetBody;
    plan.cost = targetCost;
    return plan;
  }

  if (!canUpgrade && fallbackBody && fallbackBody.length && fallbackCost > 0 && spawnEnergy >= fallbackCost && fallbackCost === targetCost) {
    plan.shouldSpawn = true;
    plan.body = fallbackBody;
    plan.cost = fallbackCost;
    return plan;
  }

  if (lowestTtl <= HARVESTER_CFG.EMERGENCY_TTL && fallbackBody && fallbackBody.length && fallbackCost > 0 && spawnEnergy >= fallbackCost) {
    plan.shouldSpawn = true;
    plan.body = fallbackBody;
    plan.cost = fallbackCost;
    return plan;
  }

  if (!canUpgrade && targetCost > 0 && spawnEnergy >= targetCost && targetBody && targetBody.length) {
    plan.shouldSpawn = true;
    plan.body = targetBody;
    plan.cost = targetCost;
  }

  return plan;
}

function prepareTickCaches() {
  var tick = Game.time | 0;
  var cache = GLOBAL_CACHE;
  if (cache.tick === tick) {
    return cache;
  }

  cache.tick = tick;

  var ownedRooms = [];
  var roomsMap = Object.create(null);
  for (var roomName in Game.rooms) {
    if (!hasOwn(Game.rooms, roomName)) continue;
    var room = Game.rooms[roomName];
    if (!room || !room.controller || !room.controller.my) continue;
    ownedRooms.push(room);
    roomsMap[room.name] = room;
  }
  cache.roomsOwned = ownedRooms;
  cache.roomsMap = roomsMap;

  var spawns = [];
  for (var spawnName in Game.spawns) {
    if (!hasOwn(Game.spawns, spawnName)) continue;
    var spawnObj = Game.spawns[spawnName];
    if (spawnObj) spawns.push(spawnObj);
  }
  cache.spawns = spawns;

  var creeps = [];
  var roleCounts = Object.create(null);
  var lunaCountsByHome = Object.create(null);
  var economyByRoom = Object.create(null);
  var harvesterIntelByRoom = Object.create(null);

  function getHarvesterIntelBucket(roomName) {
    if (!roomName) return null;
    var bucket = harvesterIntelByRoom[roomName];
    if (!bucket) {
      bucket = createHarvesterIntelRecord();
      harvesterIntelByRoom[roomName] = bucket;
    }
    return bucket;
  }

  for (var creepName in Game.creeps) {
    if (!hasOwn(Game.creeps, creepName)) continue;
    var creep = Game.creeps[creepName];
    if (!creep) continue;
    creeps.push(creep);

    if (!creep.memory) creep.memory = {};
    var creepMemory = creep.memory;
    var task = creepMemory.task;
    if (task === 'luna') {
      task = 'luna';
      creepMemory.task = 'luna';
    }

    var ttl = creep.ticksToLive;

    if (task === 'baseharvest') {
      var harvesterRoomName = determineHarvesterRoom(creepMemory, creep);
      if (harvesterRoomName) {
        var intelBucket = getHarvesterIntelBucket(harvesterRoomName);
        if (intelBucket) {
          intelBucket.active += 1;
          if (typeof ttl === 'number') {
            if (intelBucket.lowestTtl === null || ttl < intelBucket.lowestTtl) {
              intelBucket.lowestTtl = ttl;
            }
          }
          var birthBody = determineBirthBody(creepMemory, creep);
        var birthCost = CoreSpawn.costOfBody(birthBody);
          if (birthCost > intelBucket.highestCost) {
            intelBucket.highestCost = birthCost;
          }
        }
      }
    }

    if (typeof ttl === 'number' && ttl <= DYING_SOON_TTL) {
      continue;
    }

    var homeName = creepMemory.home || creepMemory._home || (creep.room ? creep.room.name : null);
    if (homeName && task) {
      var econRecord = ensureEconomyRoomRecord(economyByRoom, homeName);
      if (econRecord) {
        if (task === 'baseharvest') {
          econRecord.baseharvest += 1;
        } else if (task === 'courier') {
          econRecord.courier += 1;
        } else if (task === 'queen') {
          econRecord.queen += 1;
        } else if (task === 'builder') {
          econRecord.builder += 1;
        } else if (task === 'upgrader') {
          econRecord.upgrader += 1;
        }
      }
    }

    if (!task) continue;

    roleCounts[task] = (roleCounts[task] || 0) + 1;

    if (task === 'luna') {
      if (homeName) {
        lunaCountsByHome[homeName] = (lunaCountsByHome[homeName] || 0) + 1;
      }
    }
  }

  if (Memory.creeps) {
    for (var memName in Memory.creeps) {
      if (!hasOwn(Memory.creeps, memName)) continue;
      if (Game.creeps[memName]) continue;
      var mem = Memory.creeps[memName];
      if (!mem || mem.task !== 'baseharvest') continue;
      var memRoomName = determineHarvesterRoom(mem, null);
      if (!memRoomName) continue;
      var memIntel = getHarvesterIntelBucket(memRoomName);
      if (!memIntel) continue;
      memIntel.hatching += 1;
      var memBirthBody = determineBirthBody(mem, null);
      var memCost = CoreSpawn.costOfBody(memBirthBody);
      if (memCost > memIntel.highestCost) {
        memIntel.highestCost = memCost;
      }
    }
  }

  for (var ownedIndex = 0; ownedIndex < ownedRooms.length; ownedIndex++) {
    var ownedRoomObj = ownedRooms[ownedIndex];
    if (ownedRoomObj) {
      getHarvesterIntelBucket(ownedRoomObj.name);
    }
  }

  for (var intelRoomName in harvesterIntelByRoom) {
    if (!hasOwn(harvesterIntelByRoom, intelRoomName)) continue;
    var intelRecord = harvesterIntelByRoom[intelRoomName];
    var intelRoom = roomsMap[intelRoomName];
    var sourceCount = 0;
    if (intelRoom && typeof intelRoom.find === 'function') {
      var foundSources = intelRoom.find(FIND_SOURCES) || [];
      sourceCount = foundSources.length || 0;
    } else {
      var roomMemory = (Memory.rooms && Memory.rooms[intelRoomName]) ? Memory.rooms[intelRoomName] : null;
      if (roomMemory) {
        sourceCount = countSourcesInMemory(roomMemory);
        if (!sourceCount && roomMemory.sources && roomMemory.sources.length) {
          sourceCount = roomMemory.sources.length;
        }
      }
    }
    intelRecord.sources = sourceCount;
    intelRecord.desiredCount = sourceCount > 0 ? sourceCount : 1;
    intelRecord.coverage = (intelRecord.active | 0) + (intelRecord.hatching | 0);
  }

  cache.creeps = creeps;
  cache.roleCounts = roleCounts;
  cache.lunaCountsByHome = lunaCountsByHome;
  cache.economyByRoom = economyByRoom;
  cache.harvesterIntelByRoom = harvesterIntelByRoom;

  var siteCache = constructionSiteCache();
  cache.roomSiteCounts = siteCache.counts || Object.create(null);
  cache.totalSites = siteCache.list ? siteCache.list.length : 0;

  var remotesByHome = Object.create(null);
  for (var idx = 0; idx < ownedRooms.length; idx++) {
    var ownedRoom = ownedRooms[idx];
    var baseRemotes = null;
    if (BuilderPlanner && typeof BuilderPlanner.getActiveRemoteRooms === 'function') {
      baseRemotes = normalizeRemoteRooms(BuilderPlanner.getActiveRemoteRooms(ownedRoom));
    }
    remotesByHome[ownedRoom.name] = collectHomeRemotes(ownedRoom.name, baseRemotes);
  }
  cache.remotesByHome = remotesByHome;

  return cache;
}

function defaultTaskForRole(role) {
  if (!role) return undefined;
  role = ('' + role).toLowerCase();
  var MAP = { queen: 'queen', scout: 'scout', repair: 'repair' };
  return MAP[role];
}

function needBuilder(room, cache) {
  if (!room) return 0;
  cache = cache || prepareTickCaches();

  var roomSiteCounts = cache.roomSiteCounts || Object.create(null);
  var totalSites = roomSiteCounts[room.name] || 0;

  var remoteNames;
  if (BuilderPlanner && typeof BuilderPlanner.getActiveRemoteRooms === 'function') {
    remoteNames = normalizeRemoteRooms(BuilderPlanner.getActiveRemoteRooms(room));
  } else {
    remoteNames = cache.remotesByHome[room.name] || [];
  }

  for (var i = 0; i < remoteNames.length; i++) {
    var remoteRoomName = remoteNames[i];
    totalSites += roomSiteCounts[remoteRoomName] || 0;
  }

  return totalSites;
}

function computeBuilderLimit(totalSites, rcl) {
  var sites = totalSites | 0;
  var level = rcl | 0;
  if (sites <= 0) return 0;
  if (level <= 2) return 1;
  if (sites <= 5) return 1;
  if (sites <= 20) return 2;
  if (sites <= 50) return 3;
  return 4;
}

function getBuilderBodyConfigs() {
  if (GLOBAL_CACHE.builderBodyConfigs) {
    return GLOBAL_CACHE.builderBodyConfigs;
  }
  var mod = _tryRequireTask('builder');
  var tiers = (mod && mod.BODY_TIERS) ? mod.BODY_TIERS : [];
  GLOBAL_CACHE.builderBodyConfigs = tiers && typeof tiers.slice === 'function' ? tiers.slice() : tiers;
  return GLOBAL_CACHE.builderBodyConfigs;
}

function determineBuilderFailureReason(available, capacity) {
  var configs = getBuilderBodyConfigs();
  if (!configs.length) {
    return 'BODY_INVALID';
  }
  var tierInfo = evaluateBodyTiers(configs, available, capacity);
  if (!tierInfo.tiers || !tierInfo.tiers.length) {
    return 'BODY_INVALID';
  }
  if (!tierInfo.capacityBody.length || tierInfo.capacityCost > capacity) {
    return 'ENERGY_OVER_CAPACITY';
  }
  if (!tierInfo.availableBody.length || tierInfo.availableCost > available) {
    return 'ENERGY_LOW_AVAILABLE';
  }
  return 'OTHER_FAIL';
}

function ensureSquadMemoryRecord(squadId) {
  var id = squadId || 'Alpha';
  if (!Memory.squads) Memory.squads = {};
  if (!Memory.squads[id]) {
    Memory.squads[id] = { targetId: null, targetAt: 0, anchor: null, anchorAt: 0 };
  }
  var bucket = Memory.squads[id];
  if (!bucket.desiredRoles) bucket.desiredRoles = {};
  if (!bucket.roleOrder || !bucket.roleOrder.length) bucket.roleOrder = ['CombatMelee', 'CombatArcher', 'CombatMedic'];
  if (!bucket.minReady || bucket.minReady < 1) bucket.minReady = 1;
  if (!bucket.members) bucket.members = bucket.members || {};
  if (typeof bucket.spawnCooldownUntil !== 'number') bucket.spawnCooldownUntil = 0;
  return bucket;
}

function chooseHomeRoom(targetRoom, roomsOwned, preferred) {
  if (preferred && Game.rooms[preferred] && Game.rooms[preferred].controller && Game.rooms[preferred].controller.my) {
    return preferred;
  }
  if (!roomsOwned || !roomsOwned.length || !isValidRoomName(targetRoom)) {
    return preferred || null;
  }
  var best = preferred || null;
  var bestDist = Infinity;
  for (var i = 0; i < roomsOwned.length; i++) {
    var room = roomsOwned[i];
    if (!room || !room.controller || !room.controller.my) continue;
    var dist = safeLinearDistance(room.name, targetRoom, true);
    if (dist < bestDist) {
      bestDist = dist;
      best = room.name;
    }
  }
  return best || preferred || null;
}

function gatherSquadCensus(squadId) {
  var result = { counts: Object.create(null), total: 0 };
  if (!squadId || typeof tallyCreeps !== 'function') {
    return result;
  }
  var tally = tallyCreeps({
    includeMemory: true,
    filter: function (memory) {
      return memory && memory.squadId === squadId;
    },
    valueSelector: function (memory) {
      if (!memory) return null;
      return memory.squadRole || memory.task || memory.role || null;
    }
  });
  if (tally && tally.counts) {
    result.counts = tally.counts;
  }
  if (tally && typeof tally.total === 'number') {
    result.total = tally.total;
  }
  return result;
}

function deriveSquadDesiredRoles(intel, bucket) {
  var score = (intel && typeof intel.threatScore === 'number') ? intel.threatScore : 0;
  var details = (intel && intel.details) ? intel.details : {};
  var melee = 1;
  var medic = 1;
  var archer = 0;

  if (details.hasRanged || score >= 10) {
    archer = 1;
  }
  if (details.hasHostileTower || score >= 18) {
    melee = 2;
    medic = Math.max(medic, 2);
  }
  if (details.hasHeal) {
    medic = Math.max(medic, 2);
  }
  if (score >= 22 || (details.hasRanged && details.hasHostileTower)) {
    archer = Math.max(archer, 2);
  }

  var desired = Object.create(null);
  desired.CombatMelee = melee;
  desired.CombatMedic = medic;
  if (archer > 0) {
    desired.CombatArcher = archer;
  }

  bucket.desiredRoles = desired;
  var order = ['CombatMelee'];
  if (archer > 0) {
    order.push('CombatArcher');
  }
  order.push('CombatMedic');
  bucket.roleOrder = order;

  var total = melee + medic + (archer > 0 ? archer : 0);
  bucket.minReady = total > 0 ? total : 1;

  return desired;
}

function selectNextSquadRole(bucket, desired, counts) {
  var order = (bucket && bucket.roleOrder && bucket.roleOrder.length)
    ? bucket.roleOrder
    : ['CombatMelee', 'CombatArcher', 'CombatMedic'];
  for (var i = 0; i < order.length; i++) {
    var role = order[i];
    var need = desired[role] || 0;
    if (need <= 0) continue;
    var have = counts[role] || 0;
    if (have < need) {
      return role;
    }
  }
  return null;
}

/* === FIX: Squad spawn blocking === */
function buildSquadSpawnPlans(cache) {
  var plansByHome = Object.create(null);
  if (!TaskSquad || typeof TaskSquad.getActiveSquads !== 'function') {
    return plansByHome;
  }

  var roomsOwned = (cache && cache.roomsOwned) || [];
  var active = TaskSquad.getActiveSquads({ ownedRooms: roomsOwned }) || [];
  var intelQueue = [];
  var seenTargets = Object.create(null);

  for (var i = 0; i < active.length; i++) {
    var intel = active[i];
    if (!intel) continue;
    if (intel.targetRoom) {
      seenTargets[intel.targetRoom] = true;
    }
    intelQueue.push(intel);
  }

  // ensures combat plans trigger from scout intel
  var fallbackIntel = consumeAttackTargets({ maxAge: 2500, requeueInterval: 200 }) || [];
  if (!fallbackIntel.length && Memory.attackTargets && typeof Memory.attackTargets === 'object') {
    fallbackIntel = [];
    for (var tn in Memory.attackTargets) {
      if (!Object.prototype.hasOwnProperty.call(Memory.attackTargets, tn)) continue;
      var raw = Memory.attackTargets[tn];
      if (!raw || typeof raw !== 'object') continue;
      var owner = raw.owner || null;
      if (owner && !isEnemyUsername(owner)) {
        continue;
      }
      fallbackIntel.push(raw);
    }
  }

  for (var f = 0; f < fallbackIntel.length; f++) {
    var rec = fallbackIntel[f];
    if (!rec) continue;
    var roomName = rec.roomName || rec.targetRoom || rec.room || null;
    if (!roomName || !isValidRoomName(roomName)) {
      continue;
    }
    if (seenTargets[roomName]) {
      continue;
    }
    seenTargets[roomName] = true;
    var detailInfo = {
      hasRanged: rec.type === 'creep',
      hasAttack: rec.type === 'creep',
      hasHeal: false,
      hasHostileTower: rec.type === STRUCTURE_TOWER,
      hasHostileSpawn: rec.type === STRUCTURE_SPAWN,
      hostileCount: rec.count || 0
    };
    var baseScore = 10;
    if (rec.type === 'creep') {
      baseScore = Math.max(baseScore, 10 + ((rec.count || 0) * 3));
    } else if (rec.type === STRUCTURE_TOWER) {
      baseScore = Math.max(baseScore, 20);
    } else if (rec.type === STRUCTURE_SPAWN) {
      baseScore = Math.max(baseScore, 16);
    } else if (rec.type === 'controller') {
      baseScore = Math.max(baseScore, 18);
    }
    intelQueue.push({
      squadId: 'Scout' + roomName,
      targetRoom: roomName,
      rallyPos: new RoomPosition(25, 25, roomName),
      threatScore: baseScore,
      details: detailInfo,
      source: rec.source || 'scout'
    });
  }

  for (i = 0; i < intelQueue.length; i++) {
    intel = intelQueue[i];
    if (!intel) continue;
    var id = intel.squadId || 'Alpha';
    var bucket = ensureSquadMemoryRecord(id);
    if (intel.rallyPos) {
      bucket.rally = { x: intel.rallyPos.x, y: intel.rallyPos.y, roomName: intel.rallyPos.roomName };
    }
    if (intel.targetRoom) {
      bucket.targetRoom = intel.targetRoom;
    }
    bucket.home = chooseHomeRoom(intel.targetRoom, roomsOwned, bucket.home || intel.homeRoom);

    if (bucket.spawnCooldownUntil && bucket.spawnCooldownUntil > Game.time) {
      // Skip planning while cooldown is active so failed squads do not block other spawns.
      continue;
    }

    var desired = deriveSquadDesiredRoles(intel, bucket);
    var census = gatherSquadCensus(id);
    var nextRole = selectNextSquadRole(bucket, desired, census.counts);

    var totalNeeded = 0;
    var key;
    for (key in desired) {
      if (!hasOwn(desired, key)) continue;
      totalNeeded += desired[key] || 0;
    }
    if (totalNeeded > 0) {
      bucket.minReady = totalNeeded;
    }

    if (!nextRole) {
      continue;
    }

    var home = bucket.home || chooseHomeRoom(intel.targetRoom, roomsOwned, null);
    if (!home && roomsOwned.length) {
      home = roomsOwned[0].name;
    }
    if (!home) {
      continue;
    }

    if (!plansByHome[home]) {
      plansByHome[home] = [];
    }
    plansByHome[home].push({
      squadId: id,
      role: nextRole,
      homeRoom: home,
      targetRoom: intel.targetRoom,
      threatScore: intel.threatScore || 0,
      details: intel.details || null,
      desired: desired,
      counts: census.counts,
      totalNeeded: totalNeeded,
      rallyPos: intel.rallyPos
    });
  }

  for (var homeRoom in plansByHome) {
    if (!hasOwn(plansByHome, homeRoom)) continue;
    plansByHome[homeRoom].sort(function (a, b) {
      return (b.threatScore || 0) - (a.threatScore || 0);
    });
  }

  return plansByHome;
}

function _squadBodiesEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (var i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function _findSquadTierIndex(tiers, body) {
  if (!Array.isArray(tiers) || !Array.isArray(body)) {
    return -1;
  }
  for (var i = 0; i < tiers.length; i++) {
    if (_squadBodiesEqual(tiers[i], body)) {
      return i;
    }
  }
  return -1;
}

function _pickAffordableSquadTier(tiers, maxCost) {
  if (!Array.isArray(tiers)) {
    return null;
  }
  for (var i = 0; i < tiers.length; i++) {
    var candidate = tiers[i];
    var cost = CoreSpawn.costOfBody(candidate);
    if (cost <= maxCost) {
      return { body: candidate.slice(), cost: cost, index: i };
    }
  }
  return null;
}

function _squadTierLabel(index) {
  return (typeof index === 'number' && index >= 0) ? ('T' + (index + 1)) : 'n/a';
}

/* === FIX: Squad spawn blocking === */
function trySpawnSquadMember(spawner, plan) {
  if (!spawner || !plan) {
    return 'failed';
  }
  var room = spawner.room;
  if (!room) {
    return 'failed';
  }

  var economyStates = GLOBAL_CACHE.economyStateByRoom;
  var manualOverride = planHasManualOverride(plan);
  if (economyStates) {
    var economyState = economyStates[room.name];
    if (economyState && !economyState.allowCombat && !manualOverride) {
      // Spawn is intentionally idled until the economy is back online.
      debugSquadLog('[SquadSpawn] ' + room.name + ' ' + (plan.squadId || '?') + ':' + plan.role + ' decision=waiting reason=economy');
      return 'waiting';
    }
  }

  var available = (CoreSpawn && typeof CoreSpawn.availableEnergy === 'function')
    ? CoreSpawn.availableEnergy(spawner)
    : (room.energyAvailable || 0);
  var capacity = room.energyCapacityAvailable || available;
  var roleMod = _tryRequireTask(plan.role);
  var context = {
    plan: plan,
    availableEnergy: available,
    capacityEnergy: capacity,
    room: room,
    requestedEnergy: available
  };
  var body = (roleMod && typeof roleMod.getSpawnBody === 'function')
    ? roleMod.getSpawnBody(available, room, context) || []
    : [];
  var cost = CoreSpawn.costOfBody(body);
  var tiers = (roleMod && Array.isArray(roleMod.BODY_TIERS)) ? roleMod.BODY_TIERS : null;
  var initialTierIndex = _findSquadTierIndex(tiers, body);
  var downshiftFromIndex = -1;

  if (!body.length || cost <= 0) {
    // Check the best possible body at full capacity to decide if the plan is ever viable.
    var capacityContext = {
      plan: plan,
      availableEnergy: available,
      capacityEnergy: capacity,
      room: room,
      requestedEnergy: capacity
    };
    var bestBody = (roleMod && typeof roleMod.getSpawnBody === 'function')
      ? roleMod.getSpawnBody(capacity, room, capacityContext) || []
      : [];
    var bestCost = CoreSpawn.costOfBody(bestBody);
    if (!bestBody.length || bestCost <= 0) {
      debugSquadLog('[SquadSpawn] ' + room.name + ' ' + (plan.squadId || '?') + ':' + plan.role + ' decision=drop reason=no-body');
      return 'skip';
    }
    body = bestBody;
    cost = bestCost;
    initialTierIndex = _findSquadTierIndex(tiers, body);
  }

  if (cost > capacity) {
    var affordableTier = _pickAffordableSquadTier(tiers, capacity);
    if (affordableTier) {
      if (!_squadBodiesEqual(affordableTier.body, body)) {
        downshiftFromIndex = initialTierIndex;
      }
      body = affordableTier.body;
      cost = affordableTier.cost;
      initialTierIndex = affordableTier.index;
    } else {
      debugSquadLog('[SquadSpawn] ' + room.name + ' ' + (plan.squadId || '?') + ':' + plan.role + ' decision=drop reason=overcap cost=' + cost + ' cap=' + capacity);
      return 'skip';
    }
  }

  var selectedTierIndex = initialTierIndex;
  if (Array.isArray(tiers) && selectedTierIndex === -1) {
    selectedTierIndex = _findSquadTierIndex(tiers, body);
  }

  function logDecision(decision, extra) {
    if (!shouldDebugSquad()) return;
    var tierLabel = _squadTierLabel(selectedTierIndex);
    var note = '';
    if (downshiftFromIndex >= 0 && selectedTierIndex >= 0 && selectedTierIndex > downshiftFromIndex) {
      note = ' (from ' + _squadTierLabel(downshiftFromIndex) + ')';
    }
    var message = '[SquadSpawn] ' + room.name + ' ' + (plan.squadId || '?') + ':' + plan.role + ' tier=' + tierLabel + note + ' cost=' + cost + ' cap=' + capacity + ' avail=' + available + ' decision=' + decision;
    if (extra) {
      message += ' ' + extra;
    }
    debugSquadLog(message);
    if (Memory && Memory.debug && Memory.debug.spawn) {
      console.log('[SpawnDebug]', room.name, plan.role, 'cost=' + cost, 'cap=' + capacity, 'decision=' + decision);
    }
  }

  if (!body.length) {
    logDecision('drop', 'reason=no-body');
    return 'skip';
  }

  if (cost > available) {
    logDecision('waiting', 'reason=energy');
    return 'waiting';
  }

  var cpuThreshold = (ECON_CFG && typeof ECON_CFG.CPU_MIN_BUCKET === 'number')
    ? ECON_CFG.CPU_MIN_BUCKET
    : 500;
  if (!isCpuBucketHealthy(cpuThreshold)) {
    logDecision('waiting', 'reason=cpu');
    return 'waiting';
  }

  var homeRoom = plan.homeRoom || room.name;
  var spec = {
    body: body,
    namePrefix: plan.role,
    memory: {
      role: 'squad',
      squadRole: plan.role,
      squadId: plan.squadId,
      task: plan.role,
      home: homeRoom,
      state: 'rally',
      targetRoom: plan.targetRoom,
      bornTask: plan.role,
      birthBody: body.slice()
    }
  };

  var result = (CoreSpawn && typeof CoreSpawn.spawnFromSpec === 'function')
    ? CoreSpawn.spawnFromSpec(spawner, plan.role, spec)
    : ERR_INVALID_ARGS;
  if (result === OK) {
    logDecision('spawn');
    var bucket = ensureSquadMemoryRecord(plan.squadId);
    bucket.home = homeRoom;
    bucket.lastSpawnTick = Game.time;
    bucket.lastSpawnRole = plan.role;
    // Clear any previous cooldown once spawning succeeds so follow-up members queue normally.
    bucket.spawnCooldownUntil = 0;
    if (plan.totalNeeded > 0) {
      bucket.minReady = plan.totalNeeded;
    }
    hiveLog.info('🛡️[Squad ' + plan.squadId + '] Spawning ' + plan.role + ' @ RCL' + ((room.controller && room.controller.level) || 0) + ' (cost ~' + cost + ')');
    return 'spawned';
  }

  if (result === ERR_NOT_ENOUGH_ENERGY) {
    logDecision('waiting', 'reason=spawn-energy');
    return 'waiting';
  }

  logDecision('error', 'code=' + result);
  return 'failed';
}

function logBuilderSpawnBlock(spawner, room, builderSites, reason, available, capacity, builderFailLog) {
  if (!room || builderSites <= 0) {
    return;
  }
  var roomName = room.name || null;
  if (!roomName) {
    return;
  }
  if (!shouldLogThrottled(builderFailLog, roomName, 50)) {
    return;
  }
  var spawnName = (spawner && spawner.name) ? spawner.name : 'spawn';
  var message = '[' + spawnName + '] builder wanted: sites=' + builderSites + ' reason=' + reason + ' (avail/cap ' + available + '/' + capacity + ')';
  hiveLog.info(message);
}

function determineLunaQuota(room, cache) {
  if (!room) return 0;

  if (TaskLuna && typeof TaskLuna.getHomeQuota === 'function') {
    var quota = TaskLuna.getHomeQuota(room.name);
    if (quota > 0) return quota;
  }

  var remotes = cache.remotesByHome[room.name] || [];
  if (remotes.length === 0) return 0;
  var summary = summarizeRemotes(remotes);
  var totalSources = summary && typeof summary.totalSources === 'number'
    ? summary.totalSources
    : remotes.length;
  if (totalSources <= 0) {
    totalSources = remotes.length;
  }
  var active = summary && typeof summary.activeAssignments === 'number'
    ? summary.activeAssignments
    : 0;
  return Math.max(totalSources * DEFAULT_LUNA_PER_SOURCE, active);
}

var BeeHiveMind = {

  run: function () {
    this.initializeMemory();
    var cache = prepareTickCaches();

    if (TaskLuna && typeof TaskLuna.tick === 'function') {
      TaskLuna.tick(cache);
    }

    var ownedRooms = cache.roomsOwned || [];
    for (var i = 0; i < ownedRooms.length; i++) {
      this.manageRoom(ownedRooms[i], cache);
    }

    this.runCreeps(cache);

    if (TaskLuna && typeof TaskLuna.report === 'function') {
      TaskLuna.report(cache);
    }

    this.manageSpawns(cache);

    if (TradeEnergy && typeof TradeEnergy.runAll === 'function') {
      TradeEnergy.runAll();
    }
  },

  manageRoom: function (room, cache) {
    if (!room) return;
    if (BuilderPlanner && typeof BuilderPlanner.ensureSites === 'function') {
      BuilderPlanner.ensureSites(room, cache);
    }
    if (BuilderPlanner && typeof BuilderPlanner.ensureRemoteRoads === 'function') {
      BuilderPlanner.ensureRemoteRoads(room, cache);
    }
  },

  runCreeps: function (cache) {
    var creeps = cache.creeps || [];
    for (var i = 0; i < creeps.length; i++) {
      var creep = creeps[i];
      if (!creep) continue;
      this.assignTask(creep);
      var roleName = (creep.memory && creep.memory.role) ? creep.memory.role : null;
      var roleFn = ROLE_DISPATCH[roleName];
      if (typeof roleFn === 'function') {
        try {
          roleFn(creep);
        } catch (error) {
          hiveLog.debug('⚠️ Role error for ' + (creep.name || 'unknown') + ' (' + (roleName || 'unset') + ')', error);
        }
      } else {
        hiveLog.info('🐝 Unknown role: ' + (roleName || 'undefined') + ' (Creep: ' + (creep.name || 'unknown') + ')');
      }
    }
  },

  runVisuals: function () {
    // Visuals removed: legacy visuals module deleted (see PR #XXXX).
  },

  assignTask: function (creep) {
    if (!creep || !creep.memory) return;
    if (creep.memory.task) return;
    if (creep.memory.role === 'squad') return;
    var defaultTask = defaultTaskForRole(creep.memory.role);
    if (defaultTask) {
      creep.memory.task = defaultTask;
    }
  },

  manageSpawns: function (cache) {
    var roleCounts = cloneCounts(cache.roleCounts);
    var lunaCountsByHome = cloneCounts(cache.lunaCountsByHome);
    var spawns = cache.spawns || [];
    var builderFailLog = GLOBAL_CACHE.builderFailLog || (GLOBAL_CACHE.builderFailLog = Object.create(null));
    var squadPlansByRoom = buildSquadSpawnPlans(cache);
    var roomSpawned = Object.create(null);
    var harvesterIntelByRoom = cache.harvesterIntelByRoom;
    if (!harvesterIntelByRoom) {
      harvesterIntelByRoom = Object.create(null);
      cache.harvesterIntelByRoom = harvesterIntelByRoom;
    }
    var economyStates = GLOBAL_CACHE.economyStateByRoom || (GLOBAL_CACHE.economyStateByRoom = Object.create(null));
    var economyCountsByRoom = cache.economyByRoom || Object.create(null);
    function buildTaskSpec(task, mod, room, context) {
      if (mod && typeof mod.getSpawnSpec === 'function') {
        try {
          var spec = mod.getSpawnSpec(room, context);
          if (spec && spec.body && spec.body.length) {
            return spec;
          }
        } catch (specErr) {}
      }
      if (mod && typeof mod.getSpawnBody === 'function') {
        var body = mod.getSpawnBody(context.availableEnergy, room, context);
        if ((!body || !body.length) && typeof context.capacityEnergy === 'number') {
          body = mod.getSpawnBody(context.capacityEnergy, room, context);
        }
        if (body && body.length) {
          return {
            body: body,
            namePrefix: task,
            memory: { role: 'Worker_Bee', task: task, home: room && room.name }
          };
        }
      }
      return null;
    }

    function trySpawnWithSpec(spawner, task, room, spec, availableEnergy) {
      if (!spec || !Array.isArray(spec.body) || !spec.body.length) {
        return ERR_INVALID_ARGS;
      }
      var energy = (typeof availableEnergy === 'number') ? availableEnergy : (room.energyAvailable || 0);
      if (CoreSpawn && typeof CoreSpawn.isAffordable === 'function') {
        if (!CoreSpawn.isAffordable(spec.body, energy)) {
          return ERR_NOT_ENOUGH_ENERGY;
        }
      }
      if (spec.namePrefix == null) {
        spec.namePrefix = task;
      }
      if (!spec.memory || typeof spec.memory !== 'object') {
        spec.memory = {};
      }
      if (!spec.memory.role) {
        spec.memory.role = 'Worker_Bee';
      }
      if (!spec.memory.task) {
        spec.memory.task = task;
      }
      if (room && room.name && !spec.memory.home) {
        spec.memory.home = room.name;
      }
      return CoreSpawn.spawnFromSpec(spawner, task, spec);
    }
    // Spawn decision order prioritizes economic recovery before utility or combat units.
    var defaultTaskOrder = [
      'baseharvest',
      'courier',
      'queen',
      'builder',
      'upgrader',
      'repair',
      'luna',
      'scout',
      'CombatArcher',
      'CombatMelee',
      'CombatMedic',
      'Dismantler',
      'Trucker',
      'Claimer',
      
    ];

    for (var i = 0; i < spawns.length; i++) {
      var spawner = spawns[i];
      if (!spawner) continue;

      var room = spawner.room;
      if (!room) continue;

      var harvesterIntel = harvesterIntelByRoom[room.name];
      if (!harvesterIntel) {
        harvesterIntel = ensureHarvesterIntelForRoom(room, cache);
        harvesterIntelByRoom[room.name] = harvesterIntel;
      }

      // Derive per-room economic health so we can gate non-essential spawns.
      var economyState = deriveEconomyDecisionState(room, harvesterIntel, economyCountsByRoom);
      economyStates[room.name] = economyState;

      if (roomSpawned[room.name]) {
        continue;
      }

      var builderSites = needBuilder(room, cache);
      var controllerLevel = room.controller && room.controller.level ? room.controller.level : 1;
      var builderLimit = computeBuilderLimit(builderSites, controllerLevel);

      var spawnResource = (CoreSpawn && typeof CoreSpawn.availableEnergy === 'function')
        ? CoreSpawn.availableEnergy(spawner)
        : (room.energyAvailable || 0);
      var spawnCapacity = room.energyCapacityAvailable || spawnResource;

      if (spawner.spawning) {
        if (TaskLuna && typeof TaskLuna.noteSpawnBlocked === 'function') {
          try {
            TaskLuna.noteSpawnBlocked(room.name, 'SPAWN_BUSY', Game.time + 1, spawnResource, spawnCapacity);
          } catch (lunaNoteErr) {}
        }
        if (builderLimit > 0) {
          logBuilderSpawnBlock(spawner, room, builderSites, 'SPAWN_BUSY', spawnResource, spawnCapacity, builderFailLog);
        }
        continue;
      }

      var planQueue = squadPlansByRoom[room.name];
      if (!planQueue) {
        planQueue = [];
        squadPlansByRoom[room.name] = planQueue;
      }

      if (!roomSpawned[room.name] && planQueue.length) {
        if (!economyState.allowCombat) {
          // Economy triage pauses combat recruitment until base harvesters and couriers are online again.
        } else {
          var currentPlan = planQueue[0];
          var planOutcome = trySpawnSquadMember(spawner, currentPlan);
          if (planOutcome === 'spawned') {
            planQueue.shift();
            roomSpawned[room.name] = true;
            continue;
          }
          if (planOutcome === 'waiting') {
            debugSquadLog('[SquadSpawn] ' + room.name + ' ' + (currentPlan.squadId || '?') + ':' + currentPlan.role + ' waiting (workers still eligible this tick).');
            continue;
          }
          if (planOutcome === 'skip') {
            // Drop impossible plans for a while so they stop hogging the spawn slot.
            planQueue.shift();
            var skipBucket = ensureSquadMemoryRecord(currentPlan.squadId);
            skipBucket.spawnCooldownUntil = Game.time + 50;
            continue;
          }
          if (planOutcome === 'failed') {
            // Back off briefly after an unexpected failure so other roles can spawn.
            planQueue.shift();
            var planBucket = ensureSquadMemoryRecord(currentPlan.squadId);
            planBucket.spawnCooldownUntil = Game.time + 10;
            continue;
          }
        }
      }

      if (roomSpawned[room.name]) {
        continue;
      }

      var taskOrder = defaultTaskOrder.slice();
      if (builderLimit > 0) {
        var builderIndex = -1;
        var queenIndex = -1;
        for (var orderIdx = 0; orderIdx < taskOrder.length; orderIdx++) {
          if (taskOrder[orderIdx] === 'builder') {
            builderIndex = orderIdx;
          }
          if (taskOrder[orderIdx] === 'queen') {
            queenIndex = orderIdx;
          }
        }
        if (builderIndex !== -1) {
          taskOrder.splice(builderIndex, 1);
          if (queenIndex === -1) {
            queenIndex = 0;
          }
          taskOrder.splice(queenIndex + 1, 0, 'builder');
        }
      }

      var workerTaskLimits = {
        baseharvest: harvesterIntel.desiredCount || 1,
        courier: 1,
        queen: 1,
        upgrader: 2,
        repair: 0,
        luna: determineLunaQuota(room, cache),
        builder: builderLimit,
        scout: 1,
        CombatArcher: 0,
        CombatMelee: 0,
        CombatMedic: 0,
        Dismantler: 0,
        Trucker: 0,
        Claimer: 0
      };

      if (!economyState.hasQueen) {
        workerTaskLimits.queen = Math.max(workerTaskLimits.queen || 0, 1);
      }
      if (!economyState.hasCourier) {
        workerTaskLimits.courier = Math.max(workerTaskLimits.courier || 0, 1);
      }
      if (!economyState.hasHarvester) {
        workerTaskLimits.baseharvest = Math.max(workerTaskLimits.baseharvest || 0, 1);
      }

      // Recovery mode clamps the spawn table to economic lifelines until energy flow stabilizes.
      if (economyState.recoveryMode) {
        for (var limitKey in workerTaskLimits) {
          if (!hasOwn(workerTaskLimits, limitKey)) continue;
          if (!ECONOMIC_ROLE_MAP[limitKey]) {
            workerTaskLimits[limitKey] = 0;
          }
        }
      }

      for (var orderPos = 0; orderPos < taskOrder.length; orderPos++) {
        var task = taskOrder[orderPos];
        if (!hasOwn(workerTaskLimits, task)) continue;
        var limit = workerTaskLimits[task] | 0;
        if (!limit) {
          if (task === 'builder' && builderLimit > 0) {
            logBuilderSpawnBlock(spawner, room, builderSites, 'LIMIT_ZERO', spawnResource, spawnCapacity, builderFailLog);
          }
          continue;
        }

        var current = (task === 'luna')
          ? (lunaCountsByHome[room.name] || 0)
          : (task === 'baseharvest' ? (harvesterIntel.coverage || 0) : (roleCounts[task] || 0));
        if (current >= limit) {
          if (task === 'builder' && builderLimit > 0) {
            logBuilderSpawnBlock(spawner, room, builderSites, 'ROLE_LIMIT_REACHED', spawnResource, spawnCapacity, builderFailLog);
          }
          continue;
        }

        var mod = _tryRequireTask(task);
        var specContext = {
          availableEnergy: spawnResource,
          capacityEnergy: spawnCapacity,
          current: current,
          limit: limit
        };

        var didSpawn = false;
        if (task === 'luna') {
          var lunaPlan = null;
          if (TaskLuna && typeof TaskLuna.planSpawnForRoom === 'function') {
            try {
              lunaPlan = TaskLuna.planSpawnForRoom(spawner, {
                availableEnergy: spawnResource,
                capacityEnergy: spawnCapacity,
                current: current,
                limit: limit
              });
            } catch (planErr) {
              lunaPlan = null;
            }
          }
          if (!lunaPlan || lunaPlan.shouldSpawn !== true) {
            continue;
          }
          var spawnResult;
          if (TaskLuna && typeof TaskLuna.spawnFromPlan === 'function') {
            try {
              spawnResult = TaskLuna.spawnFromPlan(spawner, lunaPlan);
            } catch (spawnErr) {
              spawnResult = spawnErr && typeof spawnErr === 'number' ? spawnErr : ERR_INVALID_TARGET;
            }
          } else {
            spawnResult = ERR_INVALID_TARGET;
          }
          if (spawnResult === OK || spawnResult === true) {
            didSpawn = true;
          } else if (spawnResult === ERR_BUSY) {
            roomSpawned[room.name] = true;
            continue;
          } else {
            continue;
          }
        } else if (task === 'baseharvest') {
          var harvesterPlan = planHarvesterSpawn(room, spawnResource, spawnCapacity, harvesterIntel);
          if (!harvesterPlan.shouldSpawn) {
            continue;
          }
          var harvesterSpec = buildTaskSpec(task, mod, room, specContext);
          if (!harvesterSpec && Array.isArray(harvesterPlan.body) && harvesterPlan.body.length) {
            harvesterSpec = {
              body: harvesterPlan.body.slice(),
              namePrefix: 'baseharvest',
              memory: { role: 'Worker_Bee', task: 'baseharvest', home: room.name }
            };
          }
          if (!harvesterSpec) {
            continue;
          }
          var harvesterResult = trySpawnWithSpec(spawner, task, room, harvesterSpec, spawnResource);
          if (harvesterResult === OK) {
            didSpawn = true;
            harvesterIntel.hatching = (harvesterIntel.hatching || 0) + 1;
            harvesterIntel.coverage = (harvesterIntel.coverage || 0) + 1;
            if (!harvesterIntel.highestCost || harvesterPlan.cost > harvesterIntel.highestCost) {
              harvesterIntel.highestCost = harvesterPlan.cost;
            }
          }
        } else if (task === 'builder') {
          var builderSpecResolved = buildTaskSpec(task, mod, room, specContext);
          if (!builderSpecResolved) {
            if (builderLimit > 0) {
              logBuilderSpawnBlock(spawner, room, builderSites, 'SPEC_UNAVAILABLE', spawnResource, spawnCapacity, builderFailLog);
            }
            continue;
          }
          var builderResult = trySpawnWithSpec(spawner, task, room, builderSpecResolved, spawnResource);
          if (builderResult === OK) {
            didSpawn = true;
          } else if (builderLimit > 0 && builderResult === ERR_NOT_ENOUGH_ENERGY) {
            var energyReason = determineBuilderFailureReason(spawnResource, spawnCapacity);
            logBuilderSpawnBlock(spawner, room, builderSites, energyReason, spawnResource, spawnCapacity, builderFailLog);
          } else if (builderLimit > 0 && builderResult !== OK) {
            logBuilderSpawnBlock(spawner, room, builderSites, 'SPAWN_ERROR', spawnResource, spawnCapacity, builderFailLog);
          }
        } else {
          var taskSpecResolved = buildTaskSpec(task, mod, room, specContext);
          if (!taskSpecResolved) {
            continue;
          }
          var taskSpawnResult = trySpawnWithSpec(spawner, task, room, taskSpecResolved, spawnResource);
          if (taskSpawnResult === OK) {
            didSpawn = true;
          }
        }

        if (didSpawn) {
          roleCounts[task] = (roleCounts[task] || 0) + 1;
          if (task === 'luna') {
            lunaCountsByHome[room.name] = (lunaCountsByHome[room.name] || 0) + 1;
          }
          roomSpawned[room.name] = true;
          break;
        }
      }
    }
  },
  
  manageRemoteOps: function () {
    // Reserved for future remote task coordination.
  },

  initializeMemory: function () {
    if (!Memory.rooms) {
      Memory.rooms = {};
      return;
    }

    for (var roomName in Memory.rooms) {
      if (!hasOwn(Memory.rooms, roomName)) continue;
      if (!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {};
      }
    }
  }
};

module.exports = BeeHiveMind;
