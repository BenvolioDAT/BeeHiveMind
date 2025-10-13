// -----------------------------------------------------------------------------
// Task.Luna.js - Remote Mining Orchestrator
// CHANGELOG
// 2024-05-19: Rebuilt Luna around Memory.remotes ledger, phased lifecycle, and
//             remote-role spawning (miners, haulers, reservers) with diagnostics.
// README (short):
//   plan()   → audit Memory.remotes entries, refresh source intel, compute quotas.
//   assign() → bind creeps to seats, queue replacements when TTL < travel lead.
//   act()    → role handlers (miner / hauler / reserver) invoked per creep.
//   report() → health logs, Memory audits, BeeVisuals overlays (toggle via CONFIG).
// -----------------------------------------------------------------------------

'use strict';

var CONFIG_VIS = {
  enabled: true,
  drawBudgetRemote: 120,
  drawBudgetBase: 60,
  showPathsRemote: true,
  showPathsBase: false
};

var BeeToolbox = require('BeeToolbox');
var BeeVisuals = require('BeeVisuals');
var Logger = require('core.logger');
var spawnLogic = require('spawn.logic');
try { require('Traveler'); } catch (e) {}

var LUNA_UI = {
  enabled: CONFIG_VIS.enabled,
  drawBudget: CONFIG_VIS.drawBudgetRemote,
  showPaths: CONFIG_VIS.showPathsRemote,
  anchor: { x: 1, y: 1 },
  showLegend: true
};

CONFIG.visualsEnabled = CONFIG_VIS.enabled;

var CONFIG = {
  maxHarvestersPerSource: 1,
  reserverRefreshAt: 1200,
  haulerTripTimeMax: 150,
  containerFullDropPolicy: 'avoid',
  containerFullDropThreshold: 0.85,
  visualsEnabled: true,
  logLevel: 'BASIC',
  healthLogInterval: 150,
  memoryAuditInterval: 150,
  minerHandoffBuffer: 40,
  selfTestKey: 'lunaSelfTest'
};

var LOG_LEVEL = Logger.LOG_LEVEL;
var LUNA_LOG_LEVEL = LOG_LEVEL[String(CONFIG.logLevel).toUpperCase()] || LOG_LEVEL.BASIC;
var lunaLog = Logger.createLogger('Luna', LUNA_LOG_LEVEL);

var REMOTE_LEDGER_VERSION = 2;
var REMOTE_STATUS = { OK: 'OK', DEGRADED: 'DEGRADED', BLOCKED: 'BLOCKED' };
var ROLE_MINER = 'miner';
var ROLE_HAULER = 'hauler';
var ROLE_RESERVER = 'reserver';
var MINER_ROLE_KEY = 'remoteMiner';
var HAULER_ROLE_KEY = 'remoteHauler';
var RESERVER_ROLE_KEY = 'reserver';

var _phaseState = global.__lunaPhaseState || (global.__lunaPhaseState = { tick: -1 });
var _visualCache = global.__lunaVisualCache || (global.__lunaVisualCache = { tick: -1, remotes: {}, byHome: {} });

function ensurePhaseState(cache) {
  var tick = Game.time | 0;
  if (_phaseState.tick !== tick) {
    _phaseState = {
      tick: tick,
      cache: cache || null,
      plan: { remotes: {}, list: [] },
      spawnQueueByHome: {},
      creepNotes: Object.create(null),
      auditLog: []
    };
    global.__lunaPhaseState = _phaseState;
  } else if (cache && !_phaseState.cache) {
    _phaseState.cache = cache;
  }
  return _phaseState;
}

function ensureVisualCacheTick() {
  if (_visualCache.tick !== Game.time) {
    _visualCache.tick = Game.time;
    _visualCache.remotes = {};
    _visualCache.byHome = {};
  }
  return _visualCache;
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
    var dist = BeeToolbox.safeLinearDistance(homeName, remoteName, true);
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
  var capacity = BeeToolbox.estimateRemoteSourceCapacity(isReserved, keeperRoom);
  if (entry && entry.id) {
    var source = Game.getObjectById(entry.id);
    if (source && source.energyCapacity) capacity = source.energyCapacity;
  }
  return BeeToolbox.energyPerTickFromCapacity(capacity);
}

function minerHandoffThreshold(entry, ledger) {
  var route = entry && entry.routeLength ? entry.routeLength : 0;
  var bodyLength = ledger && ledger.miners && ledger.miners.lastBodyLength ? ledger.miners.lastBodyLength : 8;
  var lead = BeeToolbox.estimateSpawnLeadTime(route || 0, bodyLength || 0);
  return lead + CONFIG.minerHandoffBuffer;
}

function ensureRoomMemory(roomName) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  return Memory.rooms[roomName];
}

function detectThreat(remoteRoom, ledger) {
  if (!remoteRoom) {
    return { status: REMOTE_STATUS.DEGRADED, reason: 'NO_VISION' };
  }
  var hostiles = remoteRoom.find(FIND_HOSTILE_CREEPS, {
    filter: function (c) { return c && c.owner && c.owner.username !== BeeToolbox.getMyUsername(); }
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
  if (remoteRoom.controller && remoteRoom.controller.reservation && remoteRoom.controller.reservation.username !== BeeToolbox.getMyUsername()) {
    return { status: REMOTE_STATUS.DEGRADED, reason: 'RESERVED:' + remoteRoom.controller.reservation.username };
  }
  if (ledger.blockedUntil && ledger.blockedUntil > Game.time) {
    return { status: REMOTE_STATUS.BLOCKED, reason: 'COOLDOWN' };
  }
  if (BeeToolbox.isHighwayRoom(remoteRoom.name)) {
    return { status: REMOTE_STATUS.DEGRADED, reason: 'HIGHWAY' };
  }
  return { status: REMOTE_STATUS.OK, reason: null };
}

function computeHaulerPlan(totalEnergyPerTick, avgRoute, ledger) {
  var capacity = ledger && ledger.haulers && ledger.haulers.lastBodyCapacity
    ? ledger.haulers.lastBodyCapacity
    : 400;
  var plan = BeeToolbox.estimateHaulerRequirement(avgRoute || 0, totalEnergyPerTick || 0, capacity, CONFIG.haulerTripTimeMax);
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
        if (remoteRoom.controller.reservation && remoteRoom.controller.reservation.username === BeeToolbox.getMyUsername()) {
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
    statusReason: summary.reason
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
      var threshold = BeeToolbox.estimateSpawnLeadTime(sum.routeLength || 0, sum.ledger.haulers.lastBodyLength || 10);
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
  if (BeeToolbox && typeof BeeToolbox.BeeTravel === 'function') {
    return BeeToolbox.BeeTravel(creep, target, opts.range);
  }
  if (typeof creep.travelTo === 'function') {
    return creep.travelTo(target, { range: opts.range, reusePath: 15 });
  }
  var pos = target.x != null ? target : target.pos;
  return creep.moveTo(pos, { reusePath: 15, range: opts.range });
}

function findSeatForCreep(creep) {
  if (!creep || !creep.memory) return null;
  var remote = creep.memory.remoteRoom || creep.memory.targetRoom;
  if (!remote) return null;
  var summary = _phaseState.plan.remotes[remote];
  if (!summary) return null;
  var sourceId = creep.memory.sourceId;
  if (!sourceId) return null;
  for (var i = 0; i < summary.sources.length; i++) {
    if (summary.sources[i].id === sourceId) return summary.sources[i];
  }
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

function findHomeDeposit(creep) {
  var homeName = creep.memory.home || creep.memory.spawnRoom || (creep.room ? creep.room.name : null);
  if (!homeName) return null;
  var room = Game.rooms[homeName];
  if (!room) return null;
  if (room.storage && room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return room.storage;
  if (room.terminal && room.terminal.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return room.terminal;
  if (room.spawns && room.spawns.length) return room.spawns[0];
  var spawns = room.find(FIND_MY_SPAWNS);
  if (spawns && spawns.length) return spawns[0];
  for (var name in Game.spawns) {
    if (Game.spawns.hasOwnProperty(name)) return Game.spawns[name];
  }
  return null;
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
  var seat = findSeatForCreep(creep);
  var summary = seat ? _phaseState.plan.remotes[creep.memory.remoteRoom] : null;
  recordCreepNote(_phaseState, creep, summary, seat);
  if (!seat || !summary) {
    travelHome(creep);
    return;
  }
  if (summary.status === REMOTE_STATUS.BLOCKED) {
    travelHome(creep);
    return;
  }
  var source = Game.getObjectById(seat.id);
  if (!source && seat.entry && seat.entry.pos) {
    var pos = new RoomPosition(seat.entry.pos.x, seat.entry.pos.y, seat.entry.pos.roomName);
    travel(creep, pos, 1);
    return;
  }
  ensureContainer(seat, creep);
  var container = seat.containerId ? Game.getObjectById(seat.containerId) : null;
  var target = container ? container.pos : (source ? source.pos : null);
  if (!target) {
    travel(creep, new RoomPosition(25, 25, summary.remote), 5);
    return;
  }
  if (!creep.pos.isEqualTo(target) && creep.pos.getRangeTo(target) > 0) {
    travel(creep, target, container ? 0 : 1);
    return;
  }
  if (source) {
    var harvestResult = creep.harvest(source);
    if (harvestResult === ERR_NOT_ENOUGH_RESOURCES) {
      creep.say('⏳');
    }
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
    travelHome(creep);
    return;
  }
  var summary = _phaseState.plan.remotes[remote];
  recordCreepNote(_phaseState, creep, summary, null);
  if (!summary) {
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
    travelHome(creep);
    return;
  }
  if (!creep.pos.inRangeTo(deposit, 1)) {
    travel(creep, deposit.pos || deposit, 1);
    return;
  }
  creep.transfer(deposit, RESOURCE_ENERGY);
}

function reserverAct(creep) {
  if (!creep || !creep.memory) return;
  var remote = creep.memory.remoteRoom;
  if (!remote) {
    travelHome(creep);
    return;
  }
  var summary = _phaseState.plan.remotes[remote];
  recordCreepNote(_phaseState, creep, summary, null);
  if (!summary) {
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

function buildRemoteHudLedger(summary) {
  if (!summary) return null;
  var ledger = summary.ledger || {};
  var remoteRoom = Game.rooms[summary.remote] || null;
  var status = summary.status || REMOTE_STATUS.DEGRADED;
  if (!remoteRoom && status === REMOTE_STATUS.OK) status = 'NOVISION';
  var normalized = {
    roomName: summary.remote,
    homeName: summary.home,
    status: status,
    notes: summary.reason || (ledger.statusReason || ''),
    sources: [],
    haulers: {
      countHave: (summary.actual && summary.actual.haulers != null) ? summary.actual.haulers : 0,
      countNeed: (summary.quotas && summary.quotas.haulers != null) ? summary.quotas.haulers : 0,
      avgLoadPct: 0,
      avgEtaTicks: 0
    },
    reserver: {
      needed: (summary.quotas && summary.quotas.reserver != null) ? summary.quotas.reserver : (summary.reserverNeed ? 1 : 0),
      have: (summary.actual && summary.actual.reserver != null) ? summary.actual.reserver : 0,
      ttl: summary.reserverTicks != null ? summary.reserverTicks : 0,
      refreshAt: CONFIG.reserverRefreshAt
    },
    energyFlow: {
      inPerTick: 0,
      outPerTick: summary.energyPerTick != null ? summary.energyPerTick : 0
    },
    lastUpdate: Game.time,
    minersHave: (summary.actual && summary.actual.miners != null) ? summary.actual.miners : 0,
    minersNeed: (summary.quotas && summary.quotas.miners != null) ? summary.quotas.miners : 0
  };

  var haulerPlan = summary.haulerInfo || null;
  var capacity = (ledger && ledger.haulers && ledger.haulers.lastBodyCapacity) ? ledger.haulers.lastBodyCapacity : 0;
  if (haulerPlan) {
    if (haulerPlan.roundTrip != null) {
      normalized.haulers.avgEtaTicks = haulerPlan.roundTrip > 0 ? Math.round(haulerPlan.roundTrip / 2) : 0;
    }
    if (capacity > 0 && haulerPlan.energyPerTrip != null && haulerPlan.count > 0) {
      var perHauler = haulerPlan.energyPerTrip / Math.max(1, haulerPlan.count);
      normalized.haulers.avgLoadPct = Math.max(0, Math.min(100, Math.round((perHauler / capacity) * 100)));
    }
    if (haulerPlan.count != null) {
      var need = normalized.haulers.countNeed;
      if (haulerPlan.count > need) normalized.haulers.countNeed = haulerPlan.count;
    }
  }

  var sourceList = summary.sources || [];
  for (var i = 0; i < sourceList.length; i++) {
    var seat = sourceList[i];
    if (!seat) continue;
    var seatState = 'FREE';
    if (seat.needReplacement || (seat.queue && seat.queue.length)) seatState = 'QUEUED';
    else if (seat.occupant) seatState = 'OCCUPIED';
    var ttl = seat.occupantTtl != null ? seat.occupantTtl : 0;
    if (ttl < 0) ttl = 0;
    var entry = {
      id: seat.id,
      pos: null,
      containerId: seat.containerId || null,
      containerPos: seat.containerPos || (seat.entry && seat.entry.containerPos ? seat.entry.containerPos : null),
      linkId: seat.linkId || null,
      seatState: seatState,
      minerTtl: ttl,
      containerFill: seat.containerFill != null ? seat.containerFill : null,
      linkEnergy: 0
    };
    if (seat.entry && seat.entry.pos) {
      entry.pos = {
        x: seat.entry.pos.x,
        y: seat.entry.pos.y,
        roomName: seat.entry.pos.roomName || summary.remote
      };
    } else if (seat.pos) {
      entry.pos = {
        x: seat.pos.x,
        y: seat.pos.y,
        roomName: seat.pos.roomName || summary.remote
      };
    } else if (remoteRoom && seat.id) {
      var srcObj = Game.getObjectById(seat.id);
      if (srcObj && srcObj.pos) {
        entry.pos = { x: srcObj.pos.x, y: srcObj.pos.y, roomName: srcObj.pos.roomName };
      }
    }
    if (entry.pos && !entry.pos.roomName) entry.pos.roomName = summary.remote;
    if (remoteRoom) {
      if (entry.containerId) {
        var container = Game.getObjectById(entry.containerId);
        if (container && container.pos) {
          entry.containerPos = { x: container.pos.x, y: container.pos.y, roomName: container.pos.roomName };
        }
        if (container && container.store) {
          if (typeof container.store.getCapacity === 'function') {
            var cap = container.store.getCapacity(RESOURCE_ENERGY);
            if (cap > 0) {
              var used = container.store[RESOURCE_ENERGY] || 0;
              entry.containerFill = used / cap;
            }
          } else if (container.storeCapacity != null && container.storeCapacity > 0) {
            entry.containerFill = (container.store[RESOURCE_ENERGY] || 0) / container.storeCapacity;
          }
        }
      }
      if (entry.linkId) {
        var link = Game.getObjectById(entry.linkId);
        if (link) {
          if (link.store && link.store[RESOURCE_ENERGY] != null) entry.linkEnergy = link.store[RESOURCE_ENERGY];
          else if (link.energy != null) entry.linkEnergy = link.energy;
        }
      }
    }
    if (entry.containerFill != null) {
      if (entry.containerFill < 0) entry.containerFill = 0;
      if (entry.containerFill > 1) entry.containerFill = 1;
    }
    normalized.sources.push(entry);
  }

  return normalized;
}

function gatherVisualData(state) {
  var cache = ensureVisualCacheTick();
  for (var i = 0; i < state.plan.list.length; i++) {
    var summary = state.plan.list[i];
    var hud = buildRemoteHudLedger(summary);
    cache.remotes[summary.remote] = {
      status: summary.status,
      reason: summary.reason,
      quotas: summary.quotas,
      actual: summary.actual,
      deficits: summary.deficits,
      reserverNeed: summary.reserverNeed,
      reserverTicks: summary.reserverTicks,
      sources: (function () {
        var arr = [];
        for (var s = 0; s < summary.sources.length; s++) {
          var seat = summary.sources[s];
          arr.push({
            id: seat.id,
            occupant: seat.occupant,
            queue: seat.queue.slice(0, 2),
            ttl: seat.occupantTtl,
            energyPerTick: seat.energyPerTick,
            containerFill: seat.containerFill,
            minerQuota: seat.minerQuota,
            pos: seat.entry && seat.entry.pos ? seat.entry.pos : null
          });
        }
        return arr;
      })(),
      hud: hud
    };
    if (hud) {
      if (!cache.byHome[summary.home]) cache.byHome[summary.home] = [];
      cache.byHome[summary.home].push(hud);
    }
  }
}

function reportPhase(state) {
  gatherVisualData(state);
  if (CONFIG.visualsEnabled && BeeVisuals && typeof BeeVisuals.drawRemoteStatus === 'function') {
    BeeVisuals.drawRemoteStatus();
  }
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

function getVisualLedgersForHome(homeName) {
  if (!homeName) return [];
  var cache = ensureVisualCacheTick();
  var bucket = cache.byHome && cache.byHome[homeName];
  if (!bucket || !bucket.length) return [];
  return bucket.slice();
}

function selectBodyForRole(roleKey, available, capacity) {
  var generator = null;
  if (roleKey === MINER_ROLE_KEY) generator = spawnLogic.Generate_RemoteMiner_Body;
  else if (roleKey === HAULER_ROLE_KEY) generator = spawnLogic.Generate_RemoteHauler_Body;
  else if (roleKey === RESERVER_ROLE_KEY) generator = spawnLogic.Generate_Reserver_Body;
  if (generator) {
    var body = generator(Math.min(available, capacity));
    var cost = 0;
    for (var i = 0; i < body.length; i++) cost += BODYPART_COST[body[i]] || 0;
    return { body: body, cost: cost };
  }
  return { body: [], cost: 0 };
}

function planSpawnForRoom(spawn, context) {
  var state = ensurePhaseState(null);
  var home = spawn && spawn.room ? spawn.room.name : null;
  if (!home) return { shouldSpawn: false };
  var queue = state.spawnQueueByHome[home];
  if (!queue || !queue.length) return { shouldSpawn: false };
  queue.sort(function (a, b) {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.plannedAt - b.plannedAt;
  });
  var plan = queue[0];
  var roleKey = MINER_ROLE_KEY;
  if (plan.type === ROLE_HAULER) roleKey = HAULER_ROLE_KEY;
  else if (plan.type === ROLE_RESERVER) roleKey = RESERVER_ROLE_KEY;
  var available = context && context.availableEnergy != null ? context.availableEnergy : spawn.room.energyAvailable;
  var capacity = context && context.capacityEnergy != null ? context.capacityEnergy : spawn.room.energyCapacityAvailable;
  var bodyPlan = selectBodyForRole(roleKey, available, capacity);
  if (!bodyPlan.body.length || bodyPlan.cost > available) {
    if (Logger && Logger.shouldLog && Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      lunaLog.debug('[LUNA] defer spawn role=' + plan.type + ' remote=' + plan.remote + ' energy=' + available + ' cost=' + bodyPlan.cost);
    }
    return { shouldSpawn: false };
  }
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
    reason: plan.reason
  };
}

function spawnFromPlan(spawn, plan) {
  if (!spawn || !plan || !plan.body || !plan.body.length) return ERR_INVALID_ARGS;
  var name = spawnLogic.Generate_Creep_Name('Luna');
  if (!name) return ERR_FULL;
  var memory = {
    role: 'Worker_Bee',
    task: 'luna',
    remoteRole: plan.remoteRole,
    remoteRoom: plan.remote,
    targetRoom: plan.remote,
    home: spawn.room.name,
    birthBody: plan.body.slice(),
    sourceId: plan.seatId || null
  };
  var result = spawn.spawnCreep(plan.body, name, { memory: memory });
  if (result === OK) {
    var ledger = getRemoteLedger(plan.remote);
    if (plan.remoteRole === ROLE_HAULER) {
      ledger.haulers.lastBodyCapacity = BeeToolbox.bodyCarryCapacity(plan.body);
      ledger.haulers.lastBodyLength = plan.body.length;
    } else if (plan.remoteRole === ROLE_MINER) {
      ledger.miners.lastBodyLength = plan.body.length;
    } else if (plan.remoteRole === ROLE_RESERVER) {
      ledger.reserver.lastBodyLength = plan.body.length;
    }
    var queue = _phaseState.spawnQueueByHome[spawn.room.name];
    if (queue && queue.length && queue[0].remote === plan.remote && queue[0].type === plan.remoteRole) {
      queue.shift();
    }
    lunaLog.info('[LUNA] spawn ' + plan.remoteRole + ' ' + name + ' → ' + plan.remote);
    return OK;
  }
  return result;
}

function noteSpawnBlocked(homeName, reason) {
  if (!homeName) return;
  var state = ensurePhaseState(null);
  var queue = state.spawnQueueByHome[homeName];
  if (!queue || !queue.length) return;
  queue[0].statusReason = reason;
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
  getHomeQuota: getHomeQuota,
  getVisualLedgersForHome: getVisualLedgersForHome,
  LUNA_UI: LUNA_UI,
  CONFIG_VIS: CONFIG_VIS
};

module.exports = TaskLuna;

