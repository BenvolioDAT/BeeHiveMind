var Logger = require('core.logger');
var CoreSpawn = require('core.spawn');
var CoreConfig = require('core.config');
var Traveler = null;
try {
  Traveler = require('Traveler');
} catch (e) {
  Traveler = null;
}

var TaskBaseHarvest = null;
try {
  TaskBaseHarvest = require('Task.BaseHarvest');
} catch (baseHarvestErr) {
  TaskBaseHarvest = null;
}

var TaskCourier = null;
try {
  TaskCourier = require('Task.Courier');
} catch (courierErr) {
  TaskCourier = null;
}

var TaskClaimer = null;
try {
  TaskClaimer = require('Task.Claimer');
} catch (claimerErr) {
  TaskClaimer = null;
}

var TaskSpawn = null;
try {
  TaskSpawn = require('Task.Spawn');
} catch (spawnErr) {
  TaskSpawn = null;
}

var SpawnSettings = (CoreConfig && CoreConfig.settings && CoreConfig.settings.Spawn) || {};
var CENTRAL_SPAWN_ENABLED = !!(SpawnSettings && SpawnSettings.USE_CENTRAL);
var SPAWN_ROLE_OVERRIDES = (SpawnSettings && SpawnSettings.ROLE_OVERRIDES) || {};
var CENTRAL_REMOTE_MINER_ENABLED = !!(CENTRAL_SPAWN_ENABLED && SPAWN_ROLE_OVERRIDES['luna.remoteMiner']);

var TaskLunaSettings = (CoreConfig && CoreConfig.settings && CoreConfig.settings.TaskLuna) || {};
var CONFIG = {
  maxHarvestersPerSource: (typeof TaskLunaSettings.maxHarvestersPerSource === 'number') ? TaskLunaSettings.maxHarvestersPerSource : 1,
  reserverRefreshAt: (typeof TaskLunaSettings.reserverRefreshAt === 'number') ? TaskLunaSettings.reserverRefreshAt : 1200,
  haulerTripTimeMax: (typeof TaskLunaSettings.haulerTripTimeMax === 'number') ? TaskLunaSettings.haulerTripTimeMax : 150,
  containerFullDropPolicy: (typeof TaskLunaSettings.containerFullDropPolicy === 'string') ? TaskLunaSettings.containerFullDropPolicy : 'avoid',
  containerFullDropThreshold: (typeof TaskLunaSettings.containerFullDropThreshold === 'number') ? TaskLunaSettings.containerFullDropThreshold : 0.85,
  logLevel: (TaskLunaSettings.logLevel != null) ? TaskLunaSettings.logLevel : 'BASIC',
  healthLogInterval: (typeof TaskLunaSettings.healthLogInterval === 'number') ? TaskLunaSettings.healthLogInterval : 150,
  memoryAuditInterval: (typeof TaskLunaSettings.memoryAuditInterval === 'number') ? TaskLunaSettings.memoryAuditInterval : 150,
  minerHandoffBuffer: (typeof TaskLunaSettings.minerHandoffBuffer === 'number') ? TaskLunaSettings.minerHandoffBuffer : 40,
  selfTestKey: (typeof TaskLunaSettings.selfTestKey === 'string') ? TaskLunaSettings.selfTestKey : 'lunaSelfTest'
};

var LOG_LEVEL = Logger.LOG_LEVEL;
var LUNA_LOG_LEVEL = LOG_LEVEL[String(CONFIG.logLevel).toUpperCase()] || LOG_LEVEL.BASIC;
var lunaLog = Logger.createLogger('Luna', LUNA_LOG_LEVEL);

var _cachedUsername = null;

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

function energyPerTickFromCapacity(capacity) {
  if (!capacity || capacity <= 0) return 0;
  return capacity / ENERGY_REGEN_TIME;
}

function estimateRemoteSourceCapacity(isReserved, isKeeperRoom) {
  if (isKeeperRoom) return 4000;
  return isReserved ? 3000 : 1500;
}

function estimateRoundTripTicks(pathLength, opts) {
  var length = pathLength || 0;
  if (length <= 0) return 0;
  var speed = (opts && opts.speedMultiplier) ? opts.speedMultiplier : 1;
  var buffer = (opts && opts.buffer != null) ? opts.buffer : 4;
  var travelTicks = Math.ceil((length * 2) / speed);
  return travelTicks + buffer;
}

function estimateHaulerRequirement(pathLength, energyPerTick, haulerCapacity, tripTimeMax) {
  var capacity = haulerCapacity || 0;
  if (capacity <= 0) {
    return { count: 0, roundTrip: 0, energyPerTrip: 0 };
  }
  var roundTrip = estimateRoundTripTicks(pathLength, { buffer: 6 });
  if (tripTimeMax && roundTrip > tripTimeMax) {
    roundTrip = tripTimeMax;
  }
  var energyPerTrip = energyPerTick * roundTrip;
  var count = 0;
  if (energyPerTrip > 0) {
    count = Math.ceil(energyPerTrip / capacity);
  }
  if (count < 1 && energyPerTick > 0) count = 1;
  return {
    count: count,
    roundTrip: roundTrip,
    energyPerTrip: energyPerTrip
  };
}

function estimateSpawnLeadTime(travelTicks, bodyLength) {
  var spawnTicks = (bodyLength || 0) * CREEP_SPAWN_TIME;
  if (spawnTicks < 0) spawnTicks = 0;
  var travel = travelTicks || 0;
  var buffer = 20;
  return spawnTicks + travel + buffer;
}

function isHighwayRoom(roomName) {
  if (!isValidRoomName(roomName)) return false;
  var parsed = /([WE])(\d+)([NS])(\d+)/.exec(roomName);
  if (!parsed) return false;
  var x = parseInt(parsed[2], 10);
  var y = parseInt(parsed[4], 10);
  return (x % 10 === 0) || (y % 10 === 0);
}

function cloneBody(body) {
  if (!Array.isArray(body)) return [];
  return body.slice();
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
  normalized.cost = (cost != null) ? cost : CoreSpawn.costOfBody(body);
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

function bodyCarryCapacity(body) {
  if (!body || !body.length) return 0;
  var total = 0;
  for (var i = 0; i < body.length; i++) {
    var part = body[i];
    var partType = part && part.type ? part.type : part;
    if (partType === CARRY) total += CARRY_CAPACITY;
  }
  return total;
}

function getMyUsername() {
  if (_cachedUsername) return _cachedUsername;
  var name = null;
  var k;
  for (k in Game.spawns) {
    if (!Game.spawns.hasOwnProperty(k)) continue;
    var sp = Game.spawns[k];
    if (sp && sp.owner && sp.owner.username) { name = sp.owner.username; break; }
  }
  if (!name) {
    for (k in Game.creeps) {
      if (!Game.creeps.hasOwnProperty(k)) continue;
      var c = Game.creeps[k];
      if (c && c.owner && c.owner.username) { name = c.owner.username; break; }
    }
  }
  _cachedUsername = name || 'me';
  return _cachedUsername;
}

function beeTravel(creep, target, range) {
  if (!creep || !target) return ERR_INVALID_TARGET;

  var destination = (target && target.pos) ? target.pos : target;
  var opts = {};
  if (typeof range === 'object') {
    opts = range || {};
  } else if (range != null) {
    opts.range = range;
  }

  var options = {
    range: (opts.range != null) ? opts.range : 1,
    ignoreCreeps: (opts.ignoreCreeps != null) ? opts.ignoreCreeps : true,
    useFindRoute: (opts.useFindRoute != null) ? opts.useFindRoute : true,
    stuckValue: (opts.stuckValue != null) ? opts.stuckValue : 2,
    repath: (opts.repath != null) ? opts.repath : 0.05,
    returnData: {}
  };

  for (var k in opts) {
    if (Object.prototype.hasOwnProperty.call(opts, k)) {
      options[k] = opts[k];
    }
  }

  try {
    if (Traveler && typeof Traveler.travelTo === 'function') {
      return Traveler.travelTo(creep, destination, options);
    }
  } catch (err) {}

  if (typeof creep.travelTo === 'function') {
    return creep.travelTo(destination, options);
  }

  if (destination && destination.x != null && destination.y != null) {
    return creep.moveTo(destination, { reusePath: 20, maxOps: 2000 });
  }

  return ERR_INVALID_TARGET;
}

var REMOTE_LEDGER_VERSION = 2;
var REMOTE_STATUS = { OK: 'OK', DEGRADED: 'DEGRADED', BLOCKED: 'BLOCKED' };
var ROLE_MINER = 'miner';
var ROLE_HAULER = 'hauler';
var ROLE_RESERVER = 'reserver';
var MINER_ROLE_KEY = 'remoteMiner';
var HAULER_ROLE_KEY = 'remoteHauler';
var RESERVER_ROLE_KEY = 'reserver';

var _phaseState = global.__lunaPhaseState;
if (!_phaseState || _phaseState.__ver !== 'LUNA_PHASE_v1') {
  _phaseState = { __ver: 'LUNA_PHASE_v1', tick: -1 };
}
global.__lunaPhaseState = _phaseState;
function ensurePhaseState(cache) {
  var tick = Game.time | 0;
  if (_phaseState.tick !== tick) {
    _phaseState = {
      tick: tick,
      cache: cache || null,
      plan: { remotes: {}, list: [] },
      spawnQueueByHome: {},
      creepNotes: Object.create(null),
      auditLog: [],
      spawnLogFlags: Object.create(null),
      traceFlags: Object.create(null)
    };
    global.__lunaPhaseState = _phaseState;
  } else if (cache && !_phaseState.cache) {
    _phaseState.cache = cache;
  } else if (_phaseState.spawnLogFlags == null) {
    _phaseState.spawnLogFlags = Object.create(null);
  }
  if (_phaseState.traceFlags == null) {
    _phaseState.traceFlags = Object.create(null);
  }
  return _phaseState;
}

function ensureLedgerRoot() {
  if (!Memory.remotes || typeof Memory.remotes !== 'object') {
    Memory.remotes = { version: REMOTE_LEDGER_VERSION };
  }
  if (Memory.remotes.version == null || Memory.remotes.version < REMOTE_LEDGER_VERSION) {
    Memory.remotes.version = REMOTE_LEDGER_VERSION;
  }
  return Memory.remotes;
}

function getRemoteLedger(remoteName) {
  if (!remoteName) return null;
  var root = ensureLedgerRoot();
  if (!root[remoteName] || typeof root[remoteName] !== 'object') {
    root[remoteName] = {
      version: REMOTE_LEDGER_VERSION,
      roomName: remoteName,
      created: Game.time,
      lastAudit: 0,
      status: REMOTE_STATUS.DEGRADED,
      statusReason: 'INIT',
      blockedUntil: 0,
      home: null,
      sources: {},
      miners: { lastBodyLength: 0 },
      haulers: { lastBodyLength: 0, lastBodyCapacity: 0 },
      reserver: { lastBodyLength: 0, targetId: null, lastTicks: 0 }
    };
  }
  var ledger = root[remoteName];
  if (!ledger.sources) ledger.sources = {};
  if (!ledger.miners) ledger.miners = { lastBodyLength: 0 };
  if (!ledger.haulers) ledger.haulers = { lastBodyLength: 0, lastBodyCapacity: 0 };
  if (!ledger.reserver) ledger.reserver = { lastBodyLength: 0, targetId: null, lastTicks: 0 };
  ledger.version = REMOTE_LEDGER_VERSION;
  return ledger;
}

function touchSourceEntry(ledger, sourceId, home) {
  if (!ledger || !sourceId) return null;
  var entry = ledger.sources[sourceId];
  if (!entry) {
    entry = {
      id: sourceId,
      home: home || ledger.home,
      pos: null,
      containerId: null,
      containerPos: null,
      linkId: null,
      routeLength: null,
      routeLengthTick: 0,
      energyPerTick: 0,
      minerSeat: {
        occupant: null,
        queue: [],
        lastAssign: 0,
        handoffThreshold: 0,
        handoffTtl: null
      },
      notes: {},
      lastSeen: 0
    };
    ledger.sources[sourceId] = entry;
  }
  return entry;
}

function updateSourceVision(entry, source) {
  if (!entry || !source) return;
  entry.lastSeen = Game.time;
  entry.pos = { x: source.pos.x, y: source.pos.y, roomName: source.pos.roomName };
  entry.containerId = null;
  entry.containerPos = null;
  entry.linkId = null;
  var structs = source.pos.findInRange(FIND_STRUCTURES, 1);
  for (var i = 0; i < structs.length; i++) {
    var s = structs[i];
    if (s.structureType === STRUCTURE_CONTAINER) {
      entry.containerId = s.id;
      entry.containerPos = { x: s.pos.x, y: s.pos.y, roomName: s.pos.roomName };
    } else if (s.structureType === STRUCTURE_LINK) {
      entry.linkId = s.id;
    }
  }
  if (!entry.containerId) {
    var sites = source.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
      filter: function (site) { return site.structureType === STRUCTURE_CONTAINER && site.my; }
    });
    if (sites && sites.length) {
      entry.containerPos = { x: sites[0].pos.x, y: sites[0].pos.y, roomName: sites[0].pos.roomName };
    }
  }
}

function estimateRouteLength(homeName, remoteName, entry) {
  if (!homeName || !remoteName) return null;
  if (entry && entry.routeLength && Game.time - (entry.routeLengthTick || 0) <= 500) {
    return entry.routeLength;
  }
  var best = null;
  var mem = Memory.rooms && Memory.rooms[homeName] && Memory.rooms[homeName].roadPlanner;
  if (mem && mem.paths) {
    for (var key in mem.paths) {
      if (!Object.prototype.hasOwnProperty.call(mem.paths, key)) continue;
      if (key.indexOf(homeName + ':remote:' + remoteName) === -1) continue;
      var rec = mem.paths[key];
      var len = rec && typeof rec.length === 'number' ? rec.length : null;
      if (!len && rec && rec.path && rec.path.length) len = rec.path.length;
      if (len && (best === null || len < best)) best = len;
    }
  }
  if (best === null && entry && entry.pos && homeName) {
    var homeRoom = Game.rooms[homeName];
    if (homeRoom && homeRoom.storage) {
      try {
        var search = PathFinder.search(homeRoom.storage.pos, { pos: new RoomPosition(entry.pos.x, entry.pos.y, entry.pos.roomName), range: 1 }, {
          plainCost: 2,
          swampCost: 10,
          maxRooms: 16,
          maxOps: 4000
        });
        if (!search.incomplete && search.path && search.path.length) {
          best = search.path.length;
        }
      } catch (e) {}
    }
  }
  if (best === null) {
    var dist = safeLinearDistance(homeName, remoteName, true);
    if (dist && dist < 9000) best = Math.max(10, dist * 45);
  }
  if (entry) {
    entry.routeLength = best;
    entry.routeLengthTick = Game.time;
  }
  return best;
}

function energyPerTick(entry, remoteRoom, reservedTicks) {
  var keeperRoom = remoteRoom && !remoteRoom.controller;
  var isReserved = reservedTicks && reservedTicks > 0;
  var capacity = estimateRemoteSourceCapacity(isReserved, keeperRoom);
  if (entry && entry.id) {
    var source = Game.getObjectById(entry.id);
    if (source && source.energyCapacity) capacity = source.energyCapacity;
  }
  return energyPerTickFromCapacity(capacity);
}

function minerHandoffThreshold(entry, ledger) {
  var route = entry && entry.routeLength ? entry.routeLength : 0;
  var bodyLength = ledger && ledger.miners && ledger.miners.lastBodyLength ? ledger.miners.lastBodyLength : 8;
  var lead = estimateSpawnLeadTime(route || 0, bodyLength || 0);
  return lead + CONFIG.minerHandoffBuffer;
}

function ensureRoomMemory(roomName) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  return Memory.rooms[roomName];
}

function traceFixLog(homeName, remoteName, action, extra) {
  if (!Memory || Memory.__traceFixes !== true) return;
  var state = ensurePhaseState(null);
  var flags = state.traceFlags || (state.traceFlags = Object.create(null));
  var key = action + ':' + (homeName || '-') + ':' + (remoteName || '-');
  if (flags[key] === Game.time) return;
  flags[key] = Game.time;
  var msg = '[LUNA_FIX] ' + action + ' home=' + (homeName || '-') + ' remote=' + (remoteName || '-');
  if (extra) msg += ' ' + extra;
  console.log(msg);
}

function detectThreat(remoteRoom, ledger) {
  if (!remoteRoom) {
    return { status: REMOTE_STATUS.DEGRADED, reason: 'NO_VISION' };
  }
  var hostiles = remoteRoom.find(FIND_HOSTILE_CREEPS, {
    filter: function (c) { return c && c.owner && c.owner.username !== getMyUsername(); }
  });
  if (hostiles && hostiles.length) {
    ledger.blockedUntil = Game.time + 50;
    return { status: REMOTE_STATUS.BLOCKED, reason: 'HOSTILES' };
  }
  var cores = remoteRoom.find(FIND_STRUCTURES, {
    filter: function (s) { return s.structureType === STRUCTURE_INVADER_CORE; }
  });
  if (cores && cores.length) {
    ledger.blockedUntil = Game.time + 150;
    return { status: REMOTE_STATUS.BLOCKED, reason: 'INVADER_CORE' };
  }
  if (remoteRoom.controller && remoteRoom.controller.owner && !remoteRoom.controller.my) {
    ledger.blockedUntil = Game.time + 400;
    return { status: REMOTE_STATUS.BLOCKED, reason: 'OWNER:' + remoteRoom.controller.owner.username };
  }
  if (remoteRoom.controller && remoteRoom.controller.reservation && remoteRoom.controller.reservation.username !== getMyUsername()) {
    return { status: REMOTE_STATUS.DEGRADED, reason: 'RESERVED:' + remoteRoom.controller.reservation.username };
  }
  if (ledger.blockedUntil && ledger.blockedUntil > Game.time) {
    return { status: REMOTE_STATUS.BLOCKED, reason: 'COOLDOWN' };
  }
  if (isHighwayRoom(remoteRoom.name)) {
    return { status: REMOTE_STATUS.DEGRADED, reason: 'HIGHWAY' };
  }
  return { status: REMOTE_STATUS.OK, reason: null };
}

function computeHaulerPlan(totalEnergyPerTick, avgRoute, ledger) {
  var capacity = ledger && ledger.haulers && ledger.haulers.lastBodyCapacity
    ? ledger.haulers.lastBodyCapacity
    : 400;
  var plan = estimateHaulerRequirement(avgRoute || 0, totalEnergyPerTick || 0, capacity, CONFIG.haulerTripTimeMax);
  if (plan.count < 0) plan.count = 0;
  return plan;
}

function planPhase(state) {
  var cache = state.cache || {};
  var remotesByHome = cache.remotesByHome || {};
  var ownedRooms = cache.roomsOwned || [];
  var homeSet = {};
  for (var i = 0; i < ownedRooms.length; i++) {
    homeSet[ownedRooms[i].name] = true;
  }

  for (var homeName in remotesByHome) {
    if (!Object.prototype.hasOwnProperty.call(remotesByHome, homeName)) continue;
    var remoteList = remotesByHome[homeName];
    if (!remoteList || !remoteList.length) continue;

    for (var r = 0; r < remoteList.length; r++) {
      var remoteName = remoteList[r];
      var ledger = getRemoteLedger(remoteName);
      ledger.home = homeName;
      ledger.lastAudit = Game.time;

      var remoteRoom = Game.rooms[remoteName] || null;
      var status = detectThreat(remoteRoom, ledger);
      ledger.status = status.status;
      ledger.statusReason = status.reason;

      var summary = {
        home: homeName,
        remote: remoteName,
        ledger: ledger,
        status: status.status,
        reason: status.reason,
        sources: [],
        quotas: { miners: 0, haulers: 0, reserver: 0 },
        actual: { miners: 0, haulers: 0, reserver: 0 },
        deficits: { miners: 0, haulers: 0, reserver: 0 },
        energyPerTick: 0,
        routeLength: 0,
        reserverNeed: false,
        reserverTicks: 0,
        haulerInfo: null,
        haulers: { live: [] },
        reservers: { live: [] }
      };

      if (remoteRoom && remoteRoom.controller) {
        ledger.reserver.targetId = remoteRoom.controller.id;
        if (remoteRoom.controller.reservation && remoteRoom.controller.reservation.username === getMyUsername()) {
          summary.reserverTicks = remoteRoom.controller.reservation.ticksToEnd || 0;
          ledger.reserver.lastTicks = summary.reserverTicks;
        } else {
          summary.reserverTicks = 0;
        }
      } else {
        summary.reserverTicks = ledger.reserver.lastTicks || 0;
      }
      summary.reserverNeed = (summary.reserverTicks < CONFIG.reserverRefreshAt) && (!!(remoteRoom && remoteRoom.controller));
      if (summary.reserverNeed) summary.quotas.reserver = 1;

      var sourceList = [];
      if (remoteRoom) {
        sourceList = remoteRoom.find(FIND_SOURCES) || [];
      } else {
        var roomMem = ensureRoomMemory(remoteName);
        if (roomMem.sources) {
          for (var sid in roomMem.sources) {
            if (!Object.prototype.hasOwnProperty.call(roomMem.sources, sid)) continue;
            sourceList.push({ id: sid, pos: roomMem.sources[sid].pos ? new RoomPosition(roomMem.sources[sid].pos.x, roomMem.sources[sid].pos.y, remoteName) : null });
          }
        }
      }

      var totalEnergy = 0;
      var totalRoute = 0;
      var routeCount = 0;

      for (var s = 0; s < sourceList.length; s++) {
        var src = sourceList[s];
        var sourceObj = src.id ? Game.getObjectById(src.id) : null;
        if (!sourceObj && remoteRoom && src.id) {
          var found = remoteRoom.find(FIND_SOURCES, { filter: function (o) { return o.id === src.id; } });
          if (found && found.length) sourceObj = found[0];
        }
        var sourceId = sourceObj ? sourceObj.id : src.id;
        if (!sourceId) continue;

        var entry = touchSourceEntry(ledger, sourceId, homeName);
        if (sourceObj) updateSourceVision(entry, sourceObj);

        var reservedTicks = summary.reserverTicks;
        entry.energyPerTick = energyPerTick(entry, remoteRoom, reservedTicks);
        totalEnergy += entry.energyPerTick;

        var route = estimateRouteLength(homeName, remoteName, entry) || 0;
        if (route > 0) {
          totalRoute += route;
          routeCount++;
        }
        entry.minerSeat.handoffThreshold = minerHandoffThreshold(entry, ledger);

        summary.sources.push({
          id: sourceId,
          entry: entry,
          minerQuota: CONFIG.maxHarvestersPerSource,
          energyPerTick: entry.energyPerTick,
          routeLength: route,
          handoffThreshold: entry.minerSeat.handoffThreshold,
          containerId: entry.containerId,
          containerPos: entry.containerPos,
          linkId: entry.linkId,
          live: [],
          queue: [],
          occupant: null,
          occupantTtl: null,
          needReplacement: false,
          containerFill: null
        });
        summary.quotas.miners += CONFIG.maxHarvestersPerSource;
      }

      summary.energyPerTick = totalEnergy;
      summary.routeLength = routeCount > 0 ? Math.ceil(totalRoute / routeCount) : 0;
      summary.haulerInfo = computeHaulerPlan(totalEnergy, summary.routeLength, ledger);
      summary.quotas.haulers = summary.haulerInfo.count;

      state.plan.remotes[remoteName] = summary;
      state.plan.list.push(summary);
    }
  }
}

function ensureRoleBuckets(summary) {
  if (!summary.haulers) summary.haulers = { live: [] };
  if (!summary.reservers) summary.reservers = { live: [] };
}

function assignMiner(creep, summary, seat) {
  if (!creep || !creep.memory || !summary || !seat) return;
  creep.memory.remoteRole = ROLE_MINER;
  creep.memory.remoteRoom = summary.remote;
  creep.memory.targetRoom = summary.remote;
  creep.memory.sourceId = seat.id;
  creep.memory.targetId = seat.id;
  seat.live.push(creep);
}

function assignHauler(creep, summary) {
  if (!creep || !creep.memory || !summary) return;
  creep.memory.remoteRole = ROLE_HAULER;
  creep.memory.remoteRoom = summary.remote;
  creep.memory.targetRoom = summary.remote;
  summary.haulers.live.push(creep);
}

function assignReserver(creep, summary) {
  if (!creep || !creep.memory || !summary) return;
  creep.memory.remoteRole = ROLE_RESERVER;
  creep.memory.remoteRoom = summary.remote;
  creep.memory.targetRoom = summary.remote;
  summary.reservers.live.push(creep);
}

function pushSpawnNeed(state, summary, type, amount, reason, seatId) {
  if (!state || !summary) return;
  if (amount <= 0) return;
  var queue = state.spawnQueueByHome[summary.home];
  if (!queue) {
    queue = [];
    state.spawnQueueByHome[summary.home] = queue;
  }
  var priority = 5;
  if (type === ROLE_MINER) priority = 1;
  else if (type === ROLE_RESERVER) priority = 2;
  else if (type === ROLE_HAULER) priority = 3;
  queue.push({
    type: type,
    remote: summary.remote,
    home: summary.home,
    deficit: amount,
    priority: priority,
    reason: reason || 'deficit',
    plannedAt: Game.time,
    seatId: seatId || null,
    status: summary.status,
    statusReason: summary.reason,
    spawnState: 'pending',
    waitingTick: 0,
    blockedUntil: summary.ledger && summary.ledger.blockedUntil ? summary.ledger.blockedUntil : 0,
    lastLogReason: null,
    lastLogTick: 0
  });
}

function assignPhase(state) {
  var cache = state.cache || {};
  var creeps = cache.creeps || [];
  var remoteByName = state.plan.remotes;

  var unassignedMiners = [];
  var unassignedHaulers = [];
  var unassignedReservers = [];

  for (var i = 0; i < state.plan.list.length; i++) {
    ensureRoleBuckets(state.plan.list[i]);
  }

  for (var c = 0; c < creeps.length; c++) {
    var creep = creeps[c];
    if (!creep || !creep.memory) continue;
    if (creep.memory.task !== 'luna') continue;
    var role = String(creep.memory.remoteRole || ROLE_MINER).toLowerCase();
    var remoteRoom = creep.memory.remoteRoom || creep.memory.targetRoom;
    var summary = remoteRoom ? remoteByName[remoteRoom] : null;
    if (!summary) {
      if (role === ROLE_HAULER) unassignedHaulers.push(creep);
      else if (role === ROLE_RESERVER) unassignedReservers.push(creep);
      else unassignedMiners.push(creep);
      continue;
    }
    ensureRoleBuckets(summary);

    if (role === ROLE_HAULER) {
      summary.haulers.live.push(creep);
      continue;
    }
    if (role === ROLE_RESERVER) {
      summary.reservers.live.push(creep);
      continue;
    }
    var sourceId = creep.memory.sourceId;
    if (!sourceId) {
      unassignedMiners.push(creep);
      continue;
    }
    var seat = null;
    for (var s = 0; s < summary.sources.length; s++) {
      if (summary.sources[s].id === sourceId) {
        seat = summary.sources[s];
        break;
      }
    }
    if (!seat) {
      unassignedMiners.push(creep);
      continue;
    }
    seat.live.push(creep);
  }

  for (var si = 0; si < state.plan.list.length; si++) {
    var summary = state.plan.list[si];
    ensureRoleBuckets(summary);

    for (var s2 = 0; s2 < summary.sources.length; s2++) {
      var seat = summary.sources[s2];
      if (seat.live.length === 0 && unassignedMiners.length) {
        assignMiner(unassignedMiners.shift(), summary, seat);
      }
    }
  }

  while (unassignedMiners.length && state.plan.list.length) {
    var target = state.plan.list[Game.time % state.plan.list.length];
    if (!target || !target.sources.length) break;
    assignMiner(unassignedMiners.shift(), target, target.sources[0]);
  }

  for (var sj = 0; sj < state.plan.list.length; sj++) {
    var summary2 = state.plan.list[sj];
    ensureRoleBuckets(summary2);

    summary2.haulers.live = summary2.haulers.live || [];
    summary2.reservers.live = summary2.reservers.live || [];

    while (summary2.haulers.live.length < summary2.quotas.haulers && unassignedHaulers.length) {
      assignHauler(unassignedHaulers.shift(), summary2);
    }
    if (summary2.reserverNeed && summary2.reservers.live.length === 0 && unassignedReservers.length) {
      assignReserver(unassignedReservers.shift(), summary2);
    }
  }

  for (var idx = 0; idx < state.plan.list.length; idx++) {
    var sum = state.plan.list[idx];
    ensureRoleBuckets(sum);

    for (var s3 = 0; s3 < sum.sources.length; s3++) {
      var seat3 = sum.sources[s3];
      seat3.live.sort(function (a, b) {
        var at = a.ticksToLive || 0;
        var bt = b.ticksToLive || 0;
        return bt - at;
      });
      seat3.queue = [];
      seat3.occupant = null;
      seat3.occupantTtl = null;
      seat3.needReplacement = false;

      if (seat3.live.length) {
        seat3.occupant = seat3.live[0].name;
        seat3.occupantTtl = seat3.live[0].ticksToLive;
        for (var li = 1; li < seat3.live.length; li++) seat3.queue.push(seat3.live[li].name);
        if (seat3.occupantTtl != null && seat3.occupantTtl <= seat3.handoffThreshold) {
          seat3.needReplacement = true;
        }
      }

      sum.actual.miners += seat3.live.length;
      var deficit = seat3.minerQuota - seat3.live.length;
      if (deficit > 0) {
        sum.deficits.miners += deficit;
        if (sum.status !== REMOTE_STATUS.BLOCKED) {
          pushSpawnNeed(state, sum, ROLE_MINER, deficit, 'missing', seat3.id);
        }
      } else if (seat3.needReplacement) {
        sum.deficits.miners += 1;
        if (sum.status !== REMOTE_STATUS.BLOCKED) {
          pushSpawnNeed(state, sum, ROLE_MINER, 1, 'handoff', seat3.id);
        }
      }

      seat3.entry.minerSeat.occupant = seat3.occupant;
      seat3.entry.minerSeat.queue = seat3.queue.slice();
      seat3.entry.minerSeat.lastAssign = Game.time;
      seat3.entry.minerSeat.handoffTtl = seat3.occupantTtl;
    }

    var haulerCount = sum.haulers.live.length;
    sum.actual.haulers = haulerCount;
    if (haulerCount < sum.quotas.haulers) {
      var missingHaulers = sum.quotas.haulers - haulerCount;
      sum.deficits.haulers += missingHaulers;
      if (sum.status !== REMOTE_STATUS.BLOCKED) {
        pushSpawnNeed(state, sum, ROLE_HAULER, missingHaulers, 'missing', null);
      }
    }
    if (haulerCount > 0) {
      var minTtl = null;
      for (var h = 0; h < sum.haulers.live.length; h++) {
        var ttl = sum.haulers.live[h].ticksToLive;
        if (ttl != null && (minTtl === null || ttl < minTtl)) minTtl = ttl;
      }
      var threshold = estimateSpawnLeadTime(sum.routeLength || 0, sum.ledger.haulers.lastBodyLength || 10);
      if (minTtl != null && minTtl <= threshold) {
        sum.deficits.haulers += 1;
        if (sum.status !== REMOTE_STATUS.BLOCKED) {
          pushSpawnNeed(state, sum, ROLE_HAULER, 1, 'handoff', null);
        }
      }
    }

    var reserverCount = sum.reservers.live.length;
    sum.actual.reserver = reserverCount;
    if (sum.reserverNeed && reserverCount === 0) {
      sum.deficits.reserver = 1;
      if (sum.status !== REMOTE_STATUS.BLOCKED) {
        pushSpawnNeed(state, sum, ROLE_RESERVER, 1, 'refresh', null);
      }
    }

    sum.ledger.lastSummary = {
      quotas: sum.quotas,
      actual: sum.actual,
      deficits: sum.deficits,
      reserverNeed: sum.reserverNeed,
      status: sum.status,
      reason: sum.reason,
      tick: Game.time
    };
  }
}

function recordCreepNote(state, creep, summary, seat) {
  if (!state || !creep) return;
  state.creepNotes[creep.name] = {
    role: creep.memory.remoteRole || ROLE_MINER,
    remote: summary ? summary.remote : null,
    seat: seat ? seat.id : null,
    ttl: creep.ticksToLive,
    load: creep.store ? creep.store.getUsedCapacity(RESOURCE_ENERGY) : null
  };
}

function travel(creep, target, range) {
  if (!creep || !target) return ERR_INVALID_TARGET;
  var opts = { range: range != null ? range : 1 };
  return beeTravel(creep, target, opts);
}

function logInvalidRemote(creep, remote, reason) {
  if (!creep) return;
  if (!creep.memory) creep.memory = {};
  var warnTick = creep.memory._lunaWarnTick || 0;
  if (warnTick === Game.time) return;
  creep.memory._lunaWarnTick = Game.time;
  console.log('[LUNA] invalid remote assignment creep=' + creep.name + ' remote=' + (remote || 'null') + ' reason=' + (reason || 'unknown'));
}

function findSeatForCreep(creep) {
  if (!creep || !creep.memory) return null;
  var remote = creep.memory.remoteRoom || creep.memory.targetRoom;
  if (!remote) {
    logInvalidRemote(creep, null, 'noRemoteMemory');
    return null;
  }
  var summary = _phaseState.plan.remotes[remote];
  if (!summary) {
    logInvalidRemote(creep, remote, 'missingSummary');
    return null;
  }
  var sourceId = creep.memory.sourceId || creep.memory.targetId;
  if (!sourceId) {
    if (summary.sources && summary.sources.length) {
      var reassigned = summary.sources[Game.time % summary.sources.length];
      creep.memory.sourceId = reassigned.id;
      creep.memory.targetId = reassigned.id;
      console.log('[LUNA] reassigned ' + creep.name + ' to source ' + reassigned.id + ' in ' + remote);
      return reassigned;
    }
    logInvalidRemote(creep, remote, 'noSourceId');
    return null;
  }
  for (var i = 0; i < summary.sources.length; i++) {
    if (summary.sources[i].id === sourceId) return summary.sources[i];
  }
  if (summary.sources && summary.sources.length) {
    var fallback = summary.sources[Game.time % summary.sources.length];
    creep.memory.sourceId = fallback.id;
    creep.memory.targetId = fallback.id;
    console.log('[LUNA] restored source assignment for ' + creep.name + ' → ' + fallback.id + ' in ' + remote);
    return fallback;
  }
  logInvalidRemote(creep, remote, 'seatNotFound');
  return null;
}

function ensureContainer(seat, creep) {
  if (!seat || !creep) return;
  if (seat.containerId) return;
  if (!seat.entry || !seat.entry.pos) return;
  var pos = new RoomPosition(seat.entry.pos.x, seat.entry.pos.y, seat.entry.pos.roomName);
  var structs = pos.findInRange(FIND_STRUCTURES, 1, {
    filter: function (s) { return s.structureType === STRUCTURE_CONTAINER; }
  });
  if (structs && structs.length) {
    seat.containerId = structs[0].id;
    seat.entry.containerId = structs[0].id;
    seat.entry.containerPos = { x: structs[0].pos.x, y: structs[0].pos.y, roomName: structs[0].pos.roomName };
    return;
  }
  if (!creep.getActiveBodyparts(WORK)) return;
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) return;
  var site = pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
    filter: function (s) { return s.structureType === STRUCTURE_CONTAINER && s.my; }
  });
  if (site && site.length) {
    if (!creep.pos.inRangeTo(site[0], 3)) {
      travel(creep, site[0].pos, 3);
    } else {
      creep.build(site[0]);
    }
    return;
  }
  if (creep.room && creep.room.controller && !creep.room.controller.my) {
    creep.room.createConstructionSite(pos.x, pos.y, STRUCTURE_CONTAINER);
  }
}

function selectBestContainer(summary) {
  if (!summary) return null;
  var best = null;
  for (var i = 0; i < summary.sources.length; i++) {
    var seat = summary.sources[i];
    if (!seat.containerId) continue;
    var container = Game.getObjectById(seat.containerId);
    if (!container || !container.store) continue;
    var stored = container.store[RESOURCE_ENERGY] || 0;
    if (!best || stored > best.amount) {
      best = { container: container, seat: seat, amount: stored };
    }
  }
  return best;
}

function _hasEnergyFreeCapacity(structure) {
  // Keep this helper central so every call treats legacy and modern stores consistently.
  if (!structure) return false;
  if (structure.store && typeof structure.store.getFreeCapacity === 'function') {
    return structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
  }
  if (typeof structure.energyCapacity === 'number') {
    var level = structure.energy || 0;
    return level < structure.energyCapacity;
  }
  return false;
}

function findHomeDeposit(creep, excludeId) {
  var homeName = creep.memory.home || creep.memory.spawnRoom || (creep.room ? creep.room.name : null);
  if (!homeName) return null;
  var room = Game.rooms[homeName];
  if (!room) return null;

  var avoidId = excludeId || null;
  var candidates = [];

  // Large buffers first – storage/terminal soak up remote surges without micro-managing creeps.
  if (room.storage && (!avoidId || room.storage.id !== avoidId) && _hasEnergyFreeCapacity(room.storage)) {
    candidates.push(room.storage);
  }
  if (room.terminal && (!avoidId || room.terminal.id !== avoidId) && _hasEnergyFreeCapacity(room.terminal)) {
    candidates.push(room.terminal);
  }

  // Consider every spawn with free energy slots so we do not hard-code index 0.
  var spawnList = [];
  if (room.spawns && room.spawns.length) {
    spawnList = room.spawns;
  } else {
    spawnList = room.find(FIND_MY_SPAWNS) || [];
  }
  var i;
  for (i = 0; i < spawnList.length; i++) {
    var spawn = spawnList[i];
    if (!spawn || (avoidId && spawn.id === avoidId)) continue;
    if (_hasEnergyFreeCapacity(spawn)) candidates.push(spawn);
  }

  // Edge-case: we might lack direct vision; fall back to any owned spawn that still has room.
  if (!candidates.length) {
    for (var name in Game.spawns) {
      if (!Game.spawns.hasOwnProperty(name)) continue;
      var alt = Game.spawns[name];
      if (!alt || (avoidId && alt.id === avoidId)) continue;
      if (alt.room && alt.room.name !== homeName) continue;
      if (_hasEnergyFreeCapacity(alt)) { candidates.push(alt); break; }
    }
  }

  if (!candidates.length) return null;

  // Always pick the closest valid sink so haulers do not shuffle between full structures mid-transfer.
  var chosen = candidates[0];
  if (candidates.length > 1) {
    var bestRange = null;
    for (i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!c || !c.pos) continue;
      var range = creep.pos.getRangeTo(c);
      if (bestRange === null || range < bestRange) {
        bestRange = range;
        chosen = c;
      }
    }
  }

  return chosen;
}

function travelHome(creep) {
  var homeName = creep.memory.home || creep.memory.spawnRoom;
  if (!homeName) return;
  var room = Game.rooms[homeName];
  if (room && room.storage) {
    travel(creep, room.storage.pos, 2);
  } else if (room && room.controller) {
    travel(creep, room.controller.pos, 3);
  }
}

function minerAct(creep) {
  if (!creep || !creep.memory) return;
  if (!creep.memory.remoteRoom && creep.memory.targetRoom) {
    creep.memory.remoteRoom = creep.memory.targetRoom;
  }
  var remoteName = creep.memory.remoteRoom || creep.memory.targetRoom;
  var summary = remoteName ? _phaseState.plan.remotes[remoteName] : null;
  var seat = findSeatForCreep(creep);
  recordCreepNote(_phaseState, creep, summary, seat);
  if (!seat || !summary) {
    if (!summary) logInvalidRemote(creep, remoteName, 'noSummaryInAct');
    travelHome(creep);
    return;
  }
  if (summary.status === REMOTE_STATUS.BLOCKED) {
    travelHome(creep);
    return;
  }
  var source = Game.getObjectById(seat.id);
  if (seat && seat.id && creep.memory.targetId !== seat.id) creep.memory.targetId = seat.id;
  ensureContainer(seat, creep);
  var container = seat.containerId ? Game.getObjectById(seat.containerId) : null;
  var targetPos = null;
  if (container && container.pos) {
    targetPos = container.pos;
  } else if (source && source.pos) {
    targetPos = source.pos;
  } else if (seat.entry && seat.entry.pos) {
    targetPos = new RoomPosition(seat.entry.pos.x, seat.entry.pos.y, seat.entry.pos.roomName);
  }
  if (!targetPos) {
    logInvalidRemote(creep, summary.remote, 'noTargetPosition');
    travel(creep, new RoomPosition(25, 25, summary.remote), 5);
    return;
  }
  if (!creep.pos.isEqualTo(targetPos) && creep.pos.getRangeTo(targetPos) > 0) {
    travel(creep, targetPos, container ? 0 : 1);
    return;
  }
  if (source) {
    var harvestResult = creep.harvest(source);
    if (harvestResult === ERR_NOT_ENOUGH_RESOURCES) {
      creep.say('⏳');
    }
  } else if (seat.entry && seat.entry.pos) {
    creep.say('⛏️?');
  }
  if (container) {
    if (container.store && container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        creep.transfer(container, RESOURCE_ENERGY);
      }
    } else {
      if (CONFIG.containerFullDropPolicy === 'allow') {
        creep.drop(RESOURCE_ENERGY);
      } else {
        creep.say('full');
      }
    }
    if (container.store) {
      var used = container.store[RESOURCE_ENERGY] || 0;
      var free = container.store.getCapacity ? container.store.getCapacity(RESOURCE_ENERGY) : 0;
      if (free > 0) seat.containerFill = used / free;
    }
  } else if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    creep.drop(RESOURCE_ENERGY);
  }
}

function haulerAct(creep) {
  if (!creep || !creep.memory) return;
  var remote = creep.memory.remoteRoom;
  if (!remote) {
    logInvalidRemote(creep, null, 'haulerNoRemote');
    travelHome(creep);
    return;
  }
  var summary = _phaseState.plan.remotes[remote];
  recordCreepNote(_phaseState, creep, summary, null);
  if (!summary) {
    logInvalidRemote(creep, remote, 'haulerNoSummary');
    travelHome(creep);
    return;
  }
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
    var pickup = selectBestContainer(summary);
    if (!pickup || pickup.amount === 0) {
      travel(creep, new RoomPosition(25, 25, remote), 4);
      return;
    }
    if (!creep.pos.inRangeTo(pickup.container, 1)) {
      travel(creep, pickup.container.pos, 1);
      return;
    }
    creep.withdraw(pickup.container, RESOURCE_ENERGY);
    return;
  }
  var deposit = findHomeDeposit(creep);
  if (!deposit) {
    // When every deposit is saturated we dump immediately to keep remotes flowing.
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      creep.drop(RESOURCE_ENERGY);
    }
    return;
  }
  if (!creep.pos.inRangeTo(deposit, 1)) {
    travel(creep, deposit.pos || deposit, 1);
    return;
  }
  var transferResult = creep.transfer(deposit, RESOURCE_ENERGY);
  if (transferResult === ERR_FULL || transferResult === ERR_INVALID_TARGET) {
    // Reselect after walking; the spawn might have filled while we travelled.
    var alternate = findHomeDeposit(creep, deposit.id);
    if (alternate && alternate.id !== deposit.id) {
      if (!creep.pos.inRangeTo(alternate, 1)) {
        travel(creep, alternate.pos || alternate, 1);
        return;
      }
      transferResult = creep.transfer(alternate, RESOURCE_ENERGY);
    }
    if (transferResult === ERR_FULL || transferResult === ERR_INVALID_TARGET) {
      // No structure can take it; drop to avoid blocking the remote chain.
      creep.drop(RESOURCE_ENERGY);
    }
  }
}

function reserverAct(creep) {
  if (!creep || !creep.memory) return;
  var remote = creep.memory.remoteRoom;
  if (!remote) {
    logInvalidRemote(creep, null, 'reserverNoRemote');
    travelHome(creep);
    return;
  }
  var summary = _phaseState.plan.remotes[remote];
  recordCreepNote(_phaseState, creep, summary, null);
  if (!summary) {
    logInvalidRemote(creep, remote, 'reserverNoSummary');
    travelHome(creep);
    return;
  }
  var controller = null;
  if (Game.rooms[remote] && Game.rooms[remote].controller) {
    controller = Game.rooms[remote].controller;
  } else if (summary.ledger.reserver.targetId) {
    controller = Game.getObjectById(summary.ledger.reserver.targetId);
  }
  if (!controller) {
    travel(creep, new RoomPosition(25, 25, remote), 3);
    return;
  }
  if (!creep.pos.inRangeTo(controller, 1)) {
    travel(creep, controller.pos, 1);
    return;
  }
  var result = creep.reserveController(controller);
  if (result === ERR_NOT_OWNER) {
    creep.attackController(controller);
  }
}

function reportPhase(state) {
  // Visuals removed: legacy visuals module deleted (see PR #XXXX).
  if (CONFIG.healthLogInterval > 0 && (Game.time % CONFIG.healthLogInterval) === 0) {
    for (var i = 0; i < state.plan.list.length; i++) {
      var summary = state.plan.list[i];
      var msg = '[LUNA] remote=' + summary.remote + ' status=' + summary.status + ' miners=' + summary.actual.miners + '/' + summary.quotas.miners + ' haulers=' + summary.actual.haulers + '/' + summary.quotas.haulers + ' reserver=' + summary.actual.reserver + '/' + summary.quotas.reserver + ' resv=' + summary.reserverTicks + ' reason=' + (summary.reason || '-');
      lunaLog.info(msg);
    }
  }
  if (CONFIG.memoryAuditInterval > 0 && (Game.time % CONFIG.memoryAuditInterval) === 0) {
    var audit = [];
    for (var j = 0; j < state.plan.list.length; j++) {
      var s = state.plan.list[j];
      audit.push({ remote: s.remote, status: s.status, quotas: s.quotas, actual: s.actual, deficits: s.deficits });
    }
    state.auditLog = audit;
    Memory.lunaAudit = audit;
  }
}

function runSelfTest(state) {
  if (!Memory[CONFIG.selfTestKey]) return;
  var ledger = { haulers: { lastBodyCapacity: 500 } };
  var plan = computeHaulerPlan(20, 50, ledger);
  if (plan.count <= 0) {
    lunaLog.error('[LUNA-TEST] hauler sizing failed');
  }
}

function mapRemoteTypeToTaskKey(remoteType) {
  if (remoteType === ROLE_MINER) return 'remoteMiner';
  if (remoteType === ROLE_HAULER) return 'remoteHauler';
  if (remoteType === ROLE_RESERVER) return 'reserver';
  return null;
}

function getRemoteRoleModule(remoteType) {
  if (!remoteType) return null;
  var key = String(remoteType).toLowerCase();
  if (key === 'remoteminer' || key === 'remote_miner' || key === ROLE_MINER) {
    return TaskBaseHarvest;
  }
  if (key === 'remotehauler' || key === 'remote_hauler' || key === ROLE_HAULER) {
    return TaskCourier;
  }
  if (key === 'reserver' || key === ROLE_RESERVER) {
    return TaskClaimer;
  }
  return null;
}

function getRemoteBodyTiers(remoteType) {
  var mod = getRemoteRoleModule(remoteType);
  if (!mod) return [];
  var tiers = [];
  var source = mod.BODY_TIERS;
  if (Array.isArray(source)) {
    for (var i = 0; i < source.length; i++) {
      var tier = source[i];
      if (Array.isArray(tier)) {
        tiers.push(cloneBody(tier));
      } else if (tier && Array.isArray(tier.body)) {
        tiers.push(cloneBody(tier.body));
      }
    }
  }
  return tiers;
}

function cloneContextObject(source) {
  if (!source || typeof source !== 'object') return {};
  var copy = {};
  for (var key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    copy[key] = source[key];
  }
  return copy;
}

function createRemoteMinerSpawnContext(room, plan, baseContext, available, capacity) {
  var contextCopy = cloneContextObject(baseContext);
  if (room) {
    contextCopy.room = room;
  } else if (baseContext && baseContext.room) {
    contextCopy.room = baseContext.room;
  }
  if (!contextCopy.plan && plan) {
    contextCopy.plan = plan;
  }
  if (!contextCopy.remote && baseContext && baseContext.remote) {
    contextCopy.remote = baseContext.remote;
  }
  contextCopy.availableEnergy = available;
  contextCopy.capacityEnergy = capacity;
  var resolvedRole = (plan && plan.remoteRole) || (plan && plan.type) || (baseContext && baseContext.remoteRole) || ROLE_MINER;
  contextCopy.remoteRole = resolvedRole;
  if (!contextCopy.remoteRoom) {
    if (baseContext && typeof baseContext.remoteRoom === 'string') {
      contextCopy.remoteRoom = baseContext.remoteRoom;
    } else if (plan && typeof plan.remote === 'string') {
      contextCopy.remoteRoom = plan.remote;
    } else if (typeof contextCopy.remote === 'string') {
      contextCopy.remoteRoom = contextCopy.remote;
    }
  }
  if (contextCopy.limit == null) {
    if (baseContext && baseContext.limit != null) {
      contextCopy.limit = baseContext.limit;
    } else if (plan && plan.desired != null) {
      contextCopy.limit = plan.desired;
    } else if (plan && plan.limit != null) {
      contextCopy.limit = plan.limit;
    }
  }
  if (contextCopy.current == null) {
    if (baseContext && baseContext.current != null) {
      contextCopy.current = baseContext.current;
    } else if (plan && plan.actual && plan.type && plan.actual[plan.type] != null) {
      contextCopy.current = plan.actual[plan.type];
    }
  }
  if (!contextCopy.seatId && plan && plan.seatId) {
    contextCopy.seatId = plan.seatId;
  }
  if (!contextCopy.sourceId && plan && plan.seatId) {
    contextCopy.sourceId = plan.seatId;
  }
  if (!contextCopy.request || typeof contextCopy.request !== 'object') {
    contextCopy.request = {};
  }
  var req = contextCopy.request;
  if (req.remoteRole == null) {
    if (plan && plan.remoteRole != null) {
      req.remoteRole = plan.remoteRole;
    } else if (plan && plan.type != null) {
      req.remoteRole = plan.type;
    }
  }
  if (req.remoteRoom == null && plan && plan.remote) {
    req.remoteRoom = plan.remote;
  }
  if (req.targetRoom == null && plan && plan.remote) {
    req.targetRoom = plan.remote;
  }
  if (req.sourceId == null && plan && plan.seatId) {
    req.sourceId = plan.seatId;
  }
  if (req.seatId == null && plan && plan.seatId) {
    req.seatId = plan.seatId;
  }
  if (room && room.name) {
    if (!contextCopy.home) {
      contextCopy.home = room.name;
    }
    if (!req.home) {
      req.home = room.name;
    }
  }
  if (contextCopy.remoteRoom && !req.remoteRoom) {
    req.remoteRoom = contextCopy.remoteRoom;
  }
  return contextCopy;
}

function selectRemoteBody(remoteType, energy, context) {
  var mod = getRemoteRoleModule(remoteType);
  if (!mod || typeof mod.getSpawnBody !== 'function') {
    return [];
  }
  var room = context && context.room ? context.room : null;
  var specContext = {
    availableEnergy: energy,
    capacityEnergy: context && context.capacity != null ? context.capacity : null,
    current: context && context.current != null ? context.current : null,
    limit: context && context.limit != null ? context.limit : null,
    plan: context && context.plan ? context.plan : null,
    remote: context && context.remote ? context.remote : null,
    remoteRole: remoteType
  };
  var body = mod.getSpawnBody(energy, room, specContext);
  return Array.isArray(body) ? cloneBody(body) : [];
}

function evaluateRemoteBodyPlan(remoteType, available, capacity, context) {
  var taskKey = mapRemoteTypeToTaskKey(remoteType);
  var result = {
    configKey: taskKey,
    body: [],
    cost: 0,
    idealBody: [],
    idealCost: 0,
    minCost: 0,
    availableEnergy: available || 0,
    capacityEnergy: capacity || 0
  };

  if (!taskKey) {
    return result;
  }

  var tiers = getRemoteBodyTiers(taskKey || remoteType);
  var tierInfo = evaluateBodyTiers(tiers, available, capacity);
  if (tierInfo.minCost) {
    result.minCost = tierInfo.minCost;
  } else if (tiers.length) {
    var lastEntry = tiers[tiers.length - 1];
    result.minCost = CoreSpawn.costOfBody(Array.isArray(lastEntry.body) ? lastEntry.body : lastEntry) || 0;
  }

  if (CENTRAL_REMOTE_MINER_ENABLED && taskKey === 'remoteMiner' && TaskSpawn && typeof TaskSpawn.getBodyFor === 'function') {
    var room = context && context.room ? context.room : null;
    var plan = context && context.plan ? context.plan : null;
    var workingCtx = createRemoteMinerSpawnContext(room, plan, context, available, capacity);
    var workingSelection = TaskSpawn.getBodyFor('luna.remoteMiner', room, workingCtx);
    var workingBody = (workingSelection && Array.isArray(workingSelection.parts)) ? cloneBody(workingSelection.parts) : [];
    var workingCost = (workingSelection && typeof workingSelection.cost === 'number') ? workingSelection.cost : CoreSpawn.costOfBody(workingBody);
    if ((!workingBody.length || workingCost > available) && tierInfo.availableBody.length) {
      workingBody = cloneBody(tierInfo.availableBody);
      workingCost = tierInfo.availableCost;
    }
    if ((!workingBody.length || workingCost > available) && tiers.length) {
      var minerFallback = tiers[tiers.length - 1];
      workingBody = cloneBody(Array.isArray(minerFallback.body) ? minerFallback.body : minerFallback);
      workingCost = CoreSpawn.costOfBody(workingBody);
    }

    var idealCtx = createRemoteMinerSpawnContext(room, plan, context, capacity, capacity);
    var idealSelection = TaskSpawn.getBodyFor('luna.remoteMiner', room, idealCtx);
    var idealBody = (idealSelection && Array.isArray(idealSelection.parts)) ? cloneBody(idealSelection.parts) : [];
    var idealCost = (idealSelection && typeof idealSelection.cost === 'number') ? idealSelection.cost : CoreSpawn.costOfBody(idealBody);
    if ((!idealBody.length || idealCost > capacity) && tierInfo.capacityBody.length) {
      idealBody = cloneBody(tierInfo.capacityBody);
      idealCost = tierInfo.capacityCost;
    }
    if ((!idealBody.length || idealCost > capacity) && tiers.length) {
      var lastTier = tiers[tiers.length - 1];
      idealBody = cloneBody(Array.isArray(lastTier.body) ? lastTier.body : lastTier);
      idealCost = CoreSpawn.costOfBody(idealBody);
    }

    result.body = workingBody;
    result.cost = workingCost;
    result.idealBody = idealBody;
    result.idealCost = idealCost;

    if (!result.minCost && tiers.length) {
      var tail = tiers[tiers.length - 1];
      result.minCost = CoreSpawn.costOfBody(Array.isArray(tail.body) ? tail.body : tail) || 0;
    }

    return result;
  }

  var evalContext = context || {};
  evalContext.capacity = capacity;
  evalContext.available = available;
  evalContext.remote = evalContext.remote || (context && context.remote);
  var idealBody = selectRemoteBody(taskKey || remoteType, capacity, evalContext);
  var idealCost = CoreSpawn.costOfBody(idealBody);
  if ((!idealBody.length || idealCost > capacity) && tierInfo.capacityBody.length) {
    idealBody = cloneBody(tierInfo.capacityBody);
    idealCost = tierInfo.capacityCost;
  }
  if (!idealBody.length && tiers.length) {
    var lastTierFallback = tiers[tiers.length - 1];
    idealBody = cloneBody(Array.isArray(lastTierFallback.body) ? lastTierFallback.body : lastTierFallback);
    idealCost = CoreSpawn.costOfBody(idealBody);
  }
  result.idealBody = idealBody;
  result.idealCost = idealCost;

  var workingBody = selectRemoteBody(taskKey || remoteType, available, evalContext);
  var workingCost = CoreSpawn.costOfBody(workingBody);
  if ((!workingBody.length || workingCost > available) && tierInfo.availableBody.length) {
    workingBody = cloneBody(tierInfo.availableBody);
    workingCost = tierInfo.availableCost;
  }
  if ((!workingBody.length || workingCost > available) && tiers.length) {
    var fallbackTier = tiers[tiers.length - 1];
    workingBody = cloneBody(Array.isArray(fallbackTier.body) ? fallbackTier.body : fallbackTier);
    workingCost = CoreSpawn.costOfBody(workingBody);
  }
  result.body = workingBody;
  result.cost = workingCost;

  if (!result.minCost && tiers.length) {
    var tailTier = tiers[tiers.length - 1];
    result.minCost = CoreSpawn.costOfBody(Array.isArray(tailTier.body) ? tailTier.body : tailTier) || 0;
  }

  return result;
}

function markQueueWaiting(homeName, reason) {
  if (!homeName) return null;
  var state = ensurePhaseState(null);
  var queue = state.spawnQueueByHome[homeName];
  if (!queue || !queue.length) return null;
  var head = queue[0];
  head.spawnState = 'waiting';
  head.waitingTick = Game.time;
  if (reason) head.statusReason = reason;
  return head;
}

function logSpawnSkip(spawn, plan, reason, details) {
  if (!lunaLog || typeof lunaLog.info !== 'function') return;
  var state = ensurePhaseState(null);
  if (!state.spawnLogFlags) state.spawnLogFlags = Object.create(null);
  var home = (spawn && spawn.room && spawn.room.name) || 'unknown';
  var remote = (plan && (plan.remote || plan.remoteRoom)) || '-';
  var role = (plan && (plan.type || plan.remoteRole)) || '-';
  var key = home + ':' + remote + ':' + role + ':' + reason;
  if (state.spawnLogFlags[key] === Game.time) return;
  state.spawnLogFlags[key] = Game.time;
  var spawnName = (spawn && spawn.name) || 'spawn';
  var message = '[LUNA] spawn skip ' + reason + ' spawn=' + spawnName + ' home=' + home + ' remote=' + remote + ' role=' + role;
  if (details) message += ' ' + details;
  lunaLog.info(message);
}

function planSpawnForRoom(spawn, context) {
  var state = ensurePhaseState(null);
  var home = spawn && spawn.room ? spawn.room.name : null;
  if (!home) return { shouldSpawn: false };
  var queue = state.spawnQueueByHome[home];
  if (!queue || !queue.length) {
    logSpawnSkip(spawn, null, 'QUEUE_EMPTY', null);
    return { shouldSpawn: false };
  }
  var homeMem = ensureRoomMemory(home);
  var block = homeMem.__lunaSpawnBlock;
  if (block && typeof block.until === 'number') {
    if (block.until <= Game.time) {
      delete homeMem.__lunaSpawnBlock;
    } else {
      if (queue[0]) {
        queue[0].spawnState = 'waiting';
        queue[0].waitingTick = Game.time;
      }
      if (Memory && Memory.__traceLuna === true) {
        console.log('[LUNA] spawn gated by cooldown home=' + home + ' until=' + block.until);
      }
      traceFixLog(home, null, 'spawn-cooldown', 'until=' + block.until);
      return { shouldSpawn: false, reason: 'SPAWN_BLOCK', until: block.until };
    }
  }
  queue.sort(function (a, b) {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.plannedAt - b.plannedAt;
  });
  var maxRotations = 3;
  var rotations = 0;
  var plan;
  while (queue.length) {
    if (queue.length <= 1) {
      plan = queue[0];
      break;
    }
    plan = queue[0];
    if (!plan) break;
    var ledger = plan.remote ? getRemoteLedger(plan.remote) : null;
    var blockedUntil = 0;
    if (plan.blockedUntil && plan.blockedUntil > blockedUntil) blockedUntil = plan.blockedUntil;
    if (ledger && ledger.blockedUntil && ledger.blockedUntil > blockedUntil) blockedUntil = ledger.blockedUntil;
    var status = plan.status || (ledger ? ledger.status : null);
    var ledgerBlocked = ledger && ledger.status === REMOTE_STATUS.BLOCKED && ledger.blockedUntil && ledger.blockedUntil > Game.time;
    var isBlocked = false;
    if (status === REMOTE_STATUS.BLOCKED) isBlocked = true;
    if (!isBlocked && blockedUntil > Game.time) isBlocked = true;
    if (!isBlocked && ledgerBlocked) isBlocked = true;
    if (!isBlocked) break;

    var rotated = queue.shift();
    if (!rotated) break;
    rotated.spawnState = 'waiting';
    rotated.waitingTick = Game.time;
    rotated.blockedUntil = blockedUntil;
    queue.push(rotated);
    rotations++;
    traceFixLog(home, rotated.remote, 'rotate-blocked', 'until=' + blockedUntil);
    if (Memory && Memory.__traceLuna === true && rotated.remote) {
      console.log('[LUNA] rotated blocked remote home=' + home + ' remote=' + rotated.remote + ' until=' + blockedUntil);
    }
    if (rotations >= maxRotations) break;
  }
  plan = queue[0];
  if (!plan) {
    return { shouldSpawn: false };
  }
  if (plan.remote) {
    var activeLedger = getRemoteLedger(plan.remote);
    if (activeLedger && activeLedger.blockedUntil && (!plan.blockedUntil || plan.blockedUntil < activeLedger.blockedUntil)) {
      plan.blockedUntil = activeLedger.blockedUntil;
    }
  }
  if (plan.spawnState === 'waiting' && plan.waitingTick !== Game.time) {
    plan.spawnState = 'pending';
  }
  if (plan.status === REMOTE_STATUS.BLOCKED) {
    logSpawnSkip(spawn, plan, 'REMOTE_BLOCKED', plan.statusReason || '');
    plan.spawnState = 'waiting';
    plan.waitingTick = Game.time;
    markQueueWaiting(home, plan.statusReason || 'BLOCKED');
    return { shouldSpawn: false, skipReason: 'REMOTE_BLOCKED' };
  }
  var available = context && context.availableEnergy != null ? context.availableEnergy : spawn.room.energyAvailable;
  var capacity = context && context.capacityEnergy != null ? context.capacityEnergy : spawn.room.energyCapacityAvailable;
  var planContext = {
    room: spawn.room,
    remote: plan.remote,
    plan: plan,
    limit: plan.desired || plan.limit || null,
    current: plan.actual && plan.type ? plan.actual[plan.type] : null
  };
  var bodyPlan = evaluateRemoteBodyPlan(plan.type, available, capacity, planContext);
  if (!bodyPlan.idealBody.length || bodyPlan.idealCost > capacity) {
    var detail = 'idealCost=' + bodyPlan.idealCost + ' capacity=' + capacity;
    logSpawnSkip(spawn, plan, 'BODY_TOO_LARGE', detail);
    plan.spawnState = 'waiting';
    plan.waitingTick = Game.time;
    markQueueWaiting(home, 'CAPACITY');
    return { shouldSpawn: false, skipReason: 'BODY_TOO_LARGE', idealCost: bodyPlan.idealCost };
  }
  if (!bodyPlan.body.length || bodyPlan.cost > available) {
    var needed = bodyPlan.minCost || bodyPlan.idealCost || 0;
    var energyDetail = 'need=' + needed + ' have=' + available + '/' + capacity;
    logSpawnSkip(spawn, plan, 'INSUFFICIENT_ENERGY', energyDetail);
    plan.spawnState = 'waiting';
    plan.waitingTick = Game.time;
    markQueueWaiting(home, 'WAIT_ENERGY');
    return { shouldSpawn: false, skipReason: 'INSUFFICIENT_ENERGY', minCost: needed };
  }
  plan.spawnState = 'ready';
  plan.waitingTick = Game.time;
  return {
    shouldSpawn: true,
    body: bodyPlan.body,
    bodyCost: bodyPlan.cost,
    energyAvailable: available,
    energyCapacity: capacity,
    remote: plan.remote,
    remoteRole: plan.type,
    priority: plan.priority,
    seatId: plan.seatId || null,
    reason: plan.reason,
    configKey: bodyPlan.configKey,
    idealBody: bodyPlan.idealBody,
    idealCost: bodyPlan.idealCost,
    minCost: bodyPlan.minCost
  };
}

function spawnFromPlan(spawn, plan) {
  if (!spawn || !plan || !plan.body || !plan.body.length) return ERR_INVALID_ARGS;
  var room = spawn.room;
  var available = room && room.energyAvailable != null ? room.energyAvailable : 0;
  var capacity = room && room.energyCapacityAvailable != null ? room.energyCapacityAvailable : available;
  var remoteRole = plan.remoteRole || plan.type || 'worker';
  remoteRole = (remoteRole != null) ? String(remoteRole) : 'worker';
  var sanitizedRole = remoteRole.replace(/[^A-Za-z0-9]/g, '');
  if (!sanitizedRole) sanitizedRole = 'Role';
  var roomKey = plan.remote || (room && room.name) || (spawn && spawn.room && spawn.room.name) || 'home';
  roomKey = String(roomKey || 'home').replace(/[^A-Za-z0-9]/g, '');
  if (!roomKey) roomKey = 'Home';
  var prefix = 'Luna_' + sanitizedRole + '_' + roomKey;
  prefix = prefix.replace(/__+/g, '_');
  var body = plan.body.slice();
  var cost = plan.bodyCost != null ? plan.bodyCost : CoreSpawn.costOfBody(body);
  if (cost > available) {
    var fallbackContext = {
      room: room,
      remote: plan.remote,
      plan: plan,
      limit: plan.desired || plan.limit || null,
      current: plan.actual && plan.remoteRole ? plan.actual[plan.remoteRole] : null
    };
    var fallback = null;
    var useCentral = CENTRAL_REMOTE_MINER_ENABLED && TaskSpawn && typeof TaskSpawn.getBodyFor === 'function' && (plan.remoteRole === ROLE_MINER || plan.type === ROLE_MINER);
    if (useCentral) {
      var spawnCtx = createRemoteMinerSpawnContext(room, plan, fallbackContext, available, capacity);
      var centralSelection = TaskSpawn.getBodyFor('luna.remoteMiner', room, spawnCtx);
      if (centralSelection && Array.isArray(centralSelection.parts) && centralSelection.parts.length && centralSelection.cost > 0 && centralSelection.cost <= available) {
        body = centralSelection.parts.slice();
        cost = centralSelection.cost;
      } else {
        fallback = evaluateRemoteBodyPlan(plan.remoteRole || plan.type, available, capacity, fallbackContext);
      }
    } else {
      fallback = evaluateRemoteBodyPlan(plan.remoteRole || plan.type, available, capacity, fallbackContext);
    }
    if (fallback && fallback.body.length && fallback.cost > 0 && fallback.cost <= available) {
      body = fallback.body.slice();
      cost = fallback.cost;
    }
  }
  if (!body.length || cost > available) {
    var queueHead = markQueueWaiting(room && room.name, 'WAIT_ENERGY');
    var detail = 'have=' + available + '/' + capacity + ' planCost=' + cost;
    logSpawnSkip(spawn, queueHead || plan, 'AFFORDABILITY', detail);
    return ERR_NOT_ENOUGH_ENERGY;
  }
  plan.body = body.slice();
  plan.bodyCost = cost;
  var specMemory = {
    role: 'Worker_Bee',
    task: 'luna',
    bornTask: 'luna',
    remoteRole: plan.remoteRole,
    remoteRoom: plan.remote,
    targetRoom: plan.remote,
    home: spawn.room && spawn.room.name,
    birthBody: body.slice(),
    sourceId: plan.seatId || null,
    targetId: plan.seatId || null
  };
  var spec = {
    body: body.slice(),
    namePrefix: prefix,
    memory: specMemory
  };
  var result = CoreSpawn.spawnFromSpec(spawn, remoteRole, spec);
  if (result === OK) {
    var ledger = getRemoteLedger(plan.remote);
    if (plan.remoteRole === ROLE_HAULER) {
      ledger.haulers.lastBodyCapacity = bodyCarryCapacity(body);
      ledger.haulers.lastBodyLength = body.length;
    } else if (plan.remoteRole === ROLE_MINER) {
      ledger.miners.lastBodyLength = body.length;
    } else if (plan.remoteRole === ROLE_RESERVER) {
      ledger.reserver.lastBodyLength = body.length;
    }
    var queue = _phaseState && _phaseState.spawnQueueByHome ? _phaseState.spawnQueueByHome[spawn.room.name] : null;
    if (queue && queue.length && queue[0].remote === plan.remote && queue[0].type === plan.remoteRole) {
      queue.shift();
    }
    var spawnName = (spawn && spawn.spawning && spawn.spawning.name) ? spawn.spawning.name : null;
    lunaLog.info('[LUNA] spawn ' + plan.remoteRole + ' ' + (spawnName || prefix) + ' → ' + plan.remote + ' (cost=' + cost + ')');
    if (room) {
      var homeMem = ensureRoomMemory(room.name);
      if (homeMem && homeMem.__lunaSpawnBlock) {
        delete homeMem.__lunaSpawnBlock;
        traceFixLog(room.name, null, 'spawn-unblock', 'name=' + (spawnName || prefix));
      }
    }
    return OK;
  }
  if (result === ERR_NOT_ENOUGH_ENERGY) {
    markQueueWaiting(room && room.name, 'WAIT_ENERGY');
    logSpawnSkip(spawn, plan, 'AFFORDABILITY_RETRY', 'result=ERR_NOT_ENOUGH_ENERGY');
  }
  return result;
}

function noteSpawnBlocked(homeName, reason, until, available, capacity) {
  if (!homeName) return;
  var state = ensurePhaseState(null);
  var queue = state.spawnQueueByHome[homeName];
  if (queue && queue.length) {
    queue[0].statusReason = reason;
    queue[0].spawnState = 'waiting';
    queue[0].waitingTick = Game.time;
  }

  var mem = ensureRoomMemory(homeName);
  var targetUntil = (typeof until === 'number') ? until : (Game.time + 1);
  mem.__lunaSpawnBlock = {
    reason: reason || 'BLOCKED',
    until: targetUntil,
    available: (available != null) ? available : null,
    capacity: (capacity != null) ? capacity : null,
    t: Game.time
  };

  if (Memory && Memory.__traceLuna === true) {
    console.log('[LUNA] spawn block noted home=' + homeName + ' reason=' + (reason || 'BLOCKED') + ' until=' + targetUntil);
  }
  traceFixLog(homeName, null, 'spawn-block', 'until=' + targetUntil);
}

function tick(cache) {
  var state = ensurePhaseState(cache);
  if (state.planTick === Game.time) return;
  state.planTick = Game.time;
  state.plan.remotes = {};
  state.plan.list = [];
  state.spawnQueueByHome = {};
  state.creepNotes = Object.create(null);
  planPhase(state);
  assignPhase(state);
  runSelfTest(state);
}

function run(creep) {
  if (!creep) return;
  ensurePhaseState(null);
  if (!creep.memory.remoteRole) creep.memory.remoteRole = ROLE_MINER;
  if (!creep.memory.remoteRoom && creep.memory.targetRoom) {
    creep.memory.remoteRoom = creep.memory.targetRoom;
  }
  var role = String(creep.memory.remoteRole || ROLE_MINER).toLowerCase();
  if (role === ROLE_HAULER) haulerAct(creep);
  else if (role === ROLE_RESERVER) reserverAct(creep);
  else minerAct(creep);
}

function report(cache) {
  var state = ensurePhaseState(cache);
  reportPhase(state);
}

function getHomeQuota(homeName) {
  if (!homeName) return 0;
  var state = ensurePhaseState(null);
  var total = 0;
  for (var i = 0; i < state.plan.list.length; i++) {
    var summary = state.plan.list[i];
    if (summary.home !== homeName) continue;
    total += (summary.quotas.miners || 0) + (summary.quotas.haulers || 0) + (summary.quotas.reserver || 0);
  }
  return total;
}

var TaskLuna = {
  CONFIG: CONFIG,
  tick: tick,
  run: run,
  report: report,
  planSpawnForRoom: planSpawnForRoom,
  spawnFromPlan: spawnFromPlan,
  noteSpawnBlocked: noteSpawnBlocked,
  MAX_LUNA_PER_SOURCE: CONFIG.maxHarvestersPerSource,
  getHomeQuota: getHomeQuota
};

module.exports = TaskLuna;

