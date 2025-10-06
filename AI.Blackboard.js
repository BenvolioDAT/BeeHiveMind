"use strict";

var BeeToolbox = require('BeeToolbox');
var RoadPlanner = require('Planner.Road');
var CoreLogger = require('core.logger');

var LOG_LEVEL = CoreLogger.LOG_LEVEL;
var logger = CoreLogger.createLogger('AI.Blackboard', LOG_LEVEL.BASIC);

var HEAVY_INTERVAL = 10;
var HOSTILE_MEMORY_TTL = 150;
var EMA_ALPHA = 0.2;

var __bbCache = { tick: -1, rooms: Object.create(null) };

function ensureMemory() {
  if (!Memory.ai) Memory.ai = {};
  if (!Memory.ai.rooms) Memory.ai.rooms = {};
  return Memory.ai.rooms;
}

function ensureRoomMemory(roomName) {
  var rooms = ensureMemory();
  if (!rooms[roomName]) {
    rooms[roomName] = { kpis: {}, state: {} };
  } else {
    if (!rooms[roomName].kpis) rooms[roomName].kpis = {};
    if (!rooms[roomName].state) rooms[roomName].state = {};
  }
  return rooms[roomName];
}

function readEnergy(struct) {
  if (!struct) return 0;
  if (struct.store && typeof struct.store.getUsedCapacity === 'function') {
    var used = struct.store.getUsedCapacity(RESOURCE_ENERGY);
    return used || 0;
  }
  if (struct.store && typeof struct.store[RESOURCE_ENERGY] === 'number') {
    return struct.store[RESOURCE_ENERGY];
  }
  if (typeof struct.energy === 'number') {
    return struct.energy;
  }
  return 0;
}

function readCapacity(struct) {
  if (!struct) return 0;
  if (struct.store && typeof struct.store.getCapacity === 'function') {
    var cap = struct.store.getCapacity(RESOURCE_ENERGY);
    return cap || 0;
  }
  if (struct.store && typeof struct.store.getFreeCapacity === 'function') {
    var used = struct.store.getUsedCapacity ? struct.store.getUsedCapacity(RESOURCE_ENERGY) : 0;
    var free = struct.store.getFreeCapacity(RESOURCE_ENERGY);
    return (used || 0) + (free || 0);
  }
  if (typeof struct.energyCapacity === 'number') {
    return struct.energyCapacity;
  }
  return 0;
}

function heavyCache(roomMem) {
  if (!roomMem.state.heavy) roomMem.state.heavy = {};
  return roomMem.state.heavy;
}

function computeEnergyTotals(room, heavyData) {
  var total = room.energyAvailable || 0;
  if (room.storage) total += readEnergy(room.storage);
  if (room.terminal) total += readEnergy(room.terminal);
  if (room.factory) total += readEnergy(room.factory);
  if (room.nuker) total += readEnergy(room.nuker);

  var towerEnergy = 0;
  var towerCapacity = 0;
  var towerIds = heavyData.towerIds || [];
  for (var ti = 0; ti < towerIds.length; ti++) {
    var tower = Game.getObjectById(towerIds[ti]);
    if (!tower) continue;
    var e = readEnergy(tower);
    total += e;
    towerEnergy += e;
    towerCapacity += readCapacity(tower);
  }

  var containerIds = heavyData.containerIds || [];
  for (var ci = 0; ci < containerIds.length; ci++) {
    var container = Game.getObjectById(containerIds[ci]);
    if (!container) continue;
    total += readEnergy(container);
  }

  var linkIds = heavyData.linkIds || [];
  for (var li = 0; li < linkIds.length; li++) {
    var link = Game.getObjectById(linkIds[li]);
    if (!link) continue;
    total += readEnergy(link);
  }

  return { total: total, towerEnergy: towerEnergy, towerCapacity: towerCapacity };
}

function scanStructures(room, heavyData) {
  var structs = room.find(FIND_STRUCTURES);
  var containerIds = [];
  var linkIds = [];
  var towerIds = [];
  for (var i = 0; i < structs.length; i++) {
    var s = structs[i];
    if (!s) continue;
    if (s.structureType === STRUCTURE_CONTAINER) {
      containerIds.push(s.id);
    } else if (s.structureType === STRUCTURE_LINK) {
      linkIds.push(s.id);
    } else if (s.structureType === STRUCTURE_TOWER) {
      towerIds.push(s.id);
    }
  }
  heavyData.containerIds = containerIds;
  heavyData.linkIds = linkIds;
  heavyData.towerIds = towerIds;
}

function countCreepsForRoom(roomName) {
  var counts = Object.create(null);
  for (var name in Game.creeps) {
    if (!Game.creeps.hasOwnProperty(name)) continue;
    var creep = Game.creeps[name];
    if (!creep) continue;
    var mem = creep.memory || {};
    var home = mem.home || mem._home || null;
    if (home && home !== roomName) continue;
    if (!home && creep.room && creep.room.name !== roomName) continue;
    var role = mem.task || mem.role || 'unknown';
    counts[role] = (counts[role] || 0) + 1;
  }
  return counts;
}

function summarizeRemotes(room, roomMem, heavyData) {
  var result = Object.create(null);
  var remoteState = roomMem.state.remotes || (roomMem.state.remotes = {});
  var remotes = [];
  if (RoadPlanner && typeof RoadPlanner.getActiveRemoteRooms === 'function') {
    remotes = RoadPlanner.getActiveRemoteRooms(room) || [];
  }
  var myName = (room.controller && room.controller.owner) ? room.controller.owner.username : null;
  for (var i = 0; i < remotes.length; i++) {
    var remoteName = remotes[i];
    if (!remoteName) continue;
    if (!remoteState[remoteName]) remoteState[remoteName] = {};
    var remoteMemState = remoteState[remoteName];
    var dist = BeeToolbox.safeLinearDistance(room.name, remoteName, true);
    var visible = Game.rooms[remoteName];
    if (visible) {
      remoteMemState.lastVision = Game.time;
      var hostiles = visible.find(FIND_HOSTILE_CREEPS);
      if (hostiles && hostiles.length) {
        remoteMemState.lastHostile = Game.time;
      }
      if (visible.controller && visible.controller.reservation) {
        remoteMemState.reserved = (myName && visible.controller.reservation.username === myName) ? 1 : 0;
      } else if (visible.controller && visible.controller.owner) {
        remoteMemState.reserved = (myName && visible.controller.owner.username === myName) ? 1 : 0;
      } else {
        remoteMemState.reserved = 0;
      }
      var hostileStructs = visible.find(FIND_HOSTILE_STRUCTURES);
      if (hostileStructs && hostileStructs.length) {
        remoteMemState.lastHostile = Game.time;
      }
      remoteMemState.sourceCount = visible.find(FIND_SOURCES).length;
    }
    var memRemote = (Memory.rooms && Memory.rooms[remoteName]) || {};
    if (!remoteMemState.sourceCount && memRemote.sources) {
      var sc = 0;
      for (var key in memRemote.sources) {
        if (Object.prototype.hasOwnProperty.call(memRemote.sources, key)) sc++;
      }
      remoteMemState.sourceCount = sc;
    }
    var lastVision = remoteMemState.lastVision || 0;
    var lastHostile = remoteMemState.lastHostile || 0;
    var hostilesSeen = (lastHostile && (Game.time - lastHostile) <= HOSTILE_MEMORY_TTL) ? 1 : 0;
    var reserved = remoteMemState.reserved ? 1 : 0;
    var roadsPct = 0;
    if (RoadPlanner && typeof RoadPlanner._memory === 'function') {
      var mem = RoadPlanner._memory(room);
      if (mem && mem.paths) {
        var keys = Object.keys(mem.paths);
        var built = 0;
        var total = 0;
        for (var k = 0; k < keys.length; k++) {
          var key = keys[k];
          if (key.indexOf(remoteName + ':') !== 0) continue;
          var rec = mem.paths[key];
          if (!rec || !rec.path) continue;
          total += rec.path.length;
          if (rec.done) {
            built += rec.path.length;
          } else if (typeof rec.i === 'number') {
            built += rec.i;
          }
        }
        if (total > 0) {
          roadsPct = built / total;
        }
      }
    }
    result[remoteName] = {
      d: dist,
      s: remoteMemState.sourceCount || 0,
      lv: lastVision,
      hs: hostilesSeen,
      rb: reserved,
      road: roadsPct
    };
  }
  heavyData.remoteSummary = result;
  return result;
}

function updateDefense(room, energyTotals) {
  var hostiles = room.find(FIND_HOSTILE_CREEPS);
  var hostileSeen = hostiles && hostiles.length ? 1 : 0;
  var towerPct = 0;
  if (energyTotals.towerCapacity > 0) {
    towerPct = energyTotals.towerEnergy / energyTotals.towerCapacity;
  }
  return { towerPct: towerPct, hostiles: hostileSeen };
}

function storageFill(room) {
  if (room.storage && room.storage.store) {
    var total = room.storage.store.getCapacity ? room.storage.store.getCapacity(RESOURCE_ENERGY) : room.storage.storeCapacity;
    if (!total && room.storage.store.getCapacity) total = room.storage.store.getCapacity();
    if (!total) total = 0;
    if (total <= 0) return 0;
    var used = room.storage.store.getUsedCapacity ? room.storage.store.getUsedCapacity(RESOURCE_ENERGY) : room.storage.store[RESOURCE_ENERGY];
    if (!used) used = 0;
    return used / total;
  }
  if (room.energyCapacityAvailable > 0) {
    return (room.energyAvailable || 0) / room.energyCapacityAvailable;
  }
  return 0;
}

function getTerminalEnergy(room) {
  if (!room.terminal || !room.terminal.store) return 0;
  if (typeof room.terminal.store.getUsedCapacity === 'function') {
    return room.terminal.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
  }
  if (typeof room.terminal.store[RESOURCE_ENERGY] === 'number') {
    return room.terminal.store[RESOURCE_ENERGY];
  }
  return 0;
}

function summarizeController(room) {
  var controller = room.controller;
  var level = controller ? (controller.level | 0) : 0;
  var pct = 0;
  if (controller && controller.progressTotal > 0) {
    pct = controller.progress / controller.progressTotal;
  } else if (controller && controller.level === 8) {
    pct = 1;
  }
  return { level: level, pct: pct };
}

function computeEnergyFlows(roomMem, totals) {
  var state = roomMem.state;
  if (!state.flow) state.flow = {};
  var flow = state.flow;
  var previousTotal = typeof flow.lastTotal === 'number' ? flow.lastTotal : totals.total;
  var delta = totals.total - previousTotal;
  var gain = delta > 0 ? delta : 0;
  var spend = delta < 0 ? -delta : 0;
  var incomePer100 = gain * 100;
  var spendPer100 = spend * 100;
  flow.lastTotal = totals.total;
  flow.lastTick = Game.time;
  flow.income = BeeToolbox.ema(flow.income, incomePer100, EMA_ALPHA);
  flow.spend = BeeToolbox.ema(flow.spend, spendPer100, EMA_ALPHA);
  return { income: flow.income, spend: flow.spend };
}

function buildSnapshot(room, roomMem, heavyData, totals) {
  var flows = computeEnergyFlows(roomMem, totals);
  var controllerInfo = summarizeController(room);
  var defense = updateDefense(room, totals);
  var storagePct = storageFill(room);
  var terminalEnergy = getTerminalEnergy(room);
  var spawnAvail = room.energyAvailable || 0;
  var spawnCap = room.energyCapacityAvailable || spawnAvail;
  var creepCounts;
  if (heavyData.creepCounts) {
    creepCounts = heavyData.creepCounts;
  } else {
    creepCounts = countCreepsForRoom(room.name);
  }
  var remoteSummary = heavyData.remoteSummary || Object.create(null);

  var kpis = roomMem.kpis;
  kpis.energyIncomePer100 = flows.income || 0;
  kpis.energySpendingPer100 = flows.spend || 0;
  kpis.storageFillPct = storagePct || 0;
  kpis.terminalEnergy = terminalEnergy || 0;
  kpis.spawnEnergyAvail = spawnAvail;
  kpis.spawnEnergyCap = spawnCap;
  kpis.controllerLevel = controllerInfo.level;
  kpis.controllerProgressPct = controllerInfo.pct || 0;
  kpis.creepCounts = creepCounts;
  kpis.remoteSummary = remoteSummary;
  kpis.defenseReadiness = { towerEnergyPctAvg: defense.towerPct || 0, activeHostiles: defense.hostiles };
  kpis.lastUpdated = Game.time;

  return kpis;
}

function cloneKPIs(kpis) {
  var snapshot = {
    energyIncomePer100: kpis.energyIncomePer100 || 0,
    energySpendingPer100: kpis.energySpendingPer100 || 0,
    storageFillPct: kpis.storageFillPct || 0,
    terminalEnergy: kpis.terminalEnergy || 0,
    spawnEnergyAvail: kpis.spawnEnergyAvail || 0,
    spawnEnergyCap: kpis.spawnEnergyCap || 0,
    controllerLevel: kpis.controllerLevel || 0,
    controllerProgressPct: kpis.controllerProgressPct || 0,
    lastUpdated: kpis.lastUpdated || 0,
    defenseReadiness: {
      towerEnergyPctAvg: (kpis.defenseReadiness && kpis.defenseReadiness.towerEnergyPctAvg) || 0,
      activeHostiles: !!(kpis.defenseReadiness && kpis.defenseReadiness.activeHostiles)
    },
    creepCounts: {},
    remoteSummary: Object.create(null)
  };
  var counts = kpis.creepCounts || {};
  for (var key in counts) {
    if (Object.prototype.hasOwnProperty.call(counts, key)) {
      snapshot.creepCounts[key] = counts[key];
    }
  }
  var remotes = kpis.remoteSummary || {};
  for (var r in remotes) {
    if (!Object.prototype.hasOwnProperty.call(remotes, r)) continue;
    var entry = remotes[r];
    snapshot.remoteSummary[r] = {
      distance: entry.d || 0,
      sources: entry.s || 0,
      lastVision: entry.lv || 0,
      hostilesSeen: entry.hs ? true : false,
      reservedByMe: entry.rb ? true : false,
      roadsBuiltPct: entry.road || 0
    };
  }
  return snapshot;
}

var Blackboard = {
  /**
   * Gather and smooth per-room KPIs with throttled heavy scans.
   * @param {Room} room Owned room to evaluate.
   * @returns {object|null} KPI snapshot for the room.
   * @cpu Heavy recompute every HEAVY_INTERVAL ticks, light otherwise.
   */
  tick: function (room) {
    if (!room || !room.controller || !room.controller.my) return null;
    var roomMem = ensureRoomMemory(room.name);
    var heavyData = heavyCache(roomMem);
    var lastHeavy = heavyData.lastHeavy || 0;
    var doHeavy = (Game.time - lastHeavy) >= HEAVY_INTERVAL;
    if (doHeavy) {
      heavyData.lastHeavy = Game.time;
      scanStructures(room, heavyData);
      heavyData.creepCounts = countCreepsForRoom(room.name);
      summarizeRemotes(room, roomMem, heavyData);
    }
    var totals = computeEnergyTotals(room, heavyData);
    var kpis = buildSnapshot(room, roomMem, heavyData, totals);

    if (__bbCache.tick !== Game.time) {
      __bbCache.tick = Game.time;
      __bbCache.rooms = Object.create(null);
    }
    __bbCache.rooms[room.name] = cloneKPIs(kpis);

    if (CoreLogger.shouldLog(LOG_LEVEL.DEBUG) && Game.time % 50 === 0) {
      var hint = 'steady';
      if (kpis.storageFillPct < 0.2) hint = 'low-store';
      else if (kpis.energyIncomePer100 < kpis.energySpendingPer100) hint = 'deficit';
      var msg = '[AI] ' + room.name + ' inc:' + (kpis.energyIncomePer100 | 0) + '/100 spend:' + (kpis.energySpendingPer100 | 0) + '/100 store:' + Math.round(kpis.storageFillPct * 100) + '% next:' + hint;
      logger.debug(msg);
    }

    return __bbCache.rooms[room.name];
  },

  /**
   * Retrieve the most recent KPI snapshot for a room.
   * @param {string} roomName Room identifier.
   * @returns {object|null} Snapshot object with derived booleans.
   */
  get: function (roomName) {
    if (__bbCache.tick !== Game.time) {
      __bbCache.tick = Game.time;
      __bbCache.rooms = Object.create(null);
    }
    if (__bbCache.rooms[roomName]) {
      return __bbCache.rooms[roomName];
    }
    var rooms = ensureMemory();
    var roomMem = rooms[roomName];
    if (!roomMem || !roomMem.kpis) return null;
    var snapshot = cloneKPIs(roomMem.kpis);
    __bbCache.rooms[roomName] = snapshot;
    return snapshot;
  }
};

module.exports = Blackboard;
