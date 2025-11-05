'use strict';

/**
 * What changed & why:
 * - Rebuilt Luna into a remote container miner that sticks to one source, reserves its container tile, and feeds Truckers.
 * - Added hostile avoidance, seat reservations, and container construction so miners never wander or double-stack.
 * - Persisted metadata (seat position/container id) in room memory while keeping every movement request inside Movement.Manager.
 */

var BeeSelectors = null;
var BeeActions = null;
var Movement = null;

try { BeeSelectors = require('BeeSelectors'); } catch (err) {}
try { BeeActions = require('BeeActions'); } catch (err2) {}
try { Movement = require('Movement.Manager'); } catch (err3) {}

var AVOID_RANGE = 5;
var AVOID_TTL = 30;
var MOVE_PRIORITY = 95;
var HARVEST_PRIORITY = 100;
var TRANSFER_PRIORITY = 96;
var BUILD_PRIORITY = 94;
var IDLE_PRIORITY = 20;
var STUCK_WINDOW = 3;

function ensureRemoteMemory() {
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.remotesByHome) Memory.__BHM.remotesByHome = {};
  if (!Memory.__BHM.remoteSourceClaims) Memory.__BHM.remoteSourceClaims = {};
  if (!Memory.__BHM.avoidSources) Memory.__BHM.avoidSources = {};
  if (!Memory.__BHM.seatReservations) Memory.__BHM.seatReservations = {};
}

function inferHome(creep) {
  if (!creep) return null;
  if (creep.memory && creep.memory.homeRoom) return creep.memory.homeRoom;
  if (creep.memory && creep.memory.home) return creep.memory.home;
  if (creep.room && creep.room.controller && creep.room.controller.my) return creep.room.name;
  var names = Object.keys(Game.spawns || {});
  if (names.length) return Game.spawns[names[0]].room.name;
  return null;
}

function ensureTask(creep) {
  if (!creep || !creep.memory) return null;
  if (!creep.memory._task || creep.memory._task.type !== 'luna') {
    creep.memory._task = {
      type: 'luna',
      homeRoom: inferHome(creep),
      sourceId: null,
      containerId: null,
      seatPos: null,
      since: Game.time,
      stuckSince: null,
      seatKey: null
    };
  }
  return creep.memory._task;
}

function bodyHasCarry(creep) {
  if (!creep || !creep.body) return false;
  for (var i = 0; i < creep.body.length; i++) {
    if (creep.body[i].type === CARRY) return true;
  }
  return false;
}

function seatKeyFromPos(pos) {
  if (!pos) return null;
  return pos.roomName + ':' + pos.x + ',' + pos.y;
}

function queueMove(creep, pos, priority, range) {
  if (!creep || !pos) return;
  var opts = { range: (range != null) ? range : 1, intentType: 'harvest', reusePath: 10 };
  if (Movement && Movement.request) {
    Movement.request(creep, { x: pos.x, y: pos.y, roomName: pos.roomName }, priority || MOVE_PRIORITY, opts);
  } else if (typeof creep.travelTo === 'function') {
    creep.travelTo(new RoomPosition(pos.x, pos.y, pos.roomName), { range: opts.range });
  } else {
    creep.moveTo(pos.x, pos.y, { range: opts.range });
  }
}

function safeHarvest(creep, source) {
  if (BeeActions && BeeActions.safeHarvest) {
    return BeeActions.safeHarvest(creep, source, HARVEST_PRIORITY);
  }
  var res = creep.harvest(source);
  if (res === ERR_NOT_IN_RANGE && source && source.pos) queueMove(creep, source.pos, HARVEST_PRIORITY, 1);
  return res;
}

function safeTransfer(creep, target) {
  if (BeeActions && BeeActions.safeTransfer) {
    return BeeActions.safeTransfer(creep, target, RESOURCE_ENERGY, null, TRANSFER_PRIORITY);
  }
  var res = creep.transfer(target, RESOURCE_ENERGY);
  if (res === ERR_NOT_IN_RANGE && target && target.pos) queueMove(creep, target.pos, TRANSFER_PRIORITY, 1);
  return res;
}

function safeBuild(creep, site) {
  if (BeeActions && BeeActions.safeBuild) {
    return BeeActions.safeBuild(creep, site, BUILD_PRIORITY);
  }
  var res = creep.build(site);
  if (res === ERR_NOT_IN_RANGE && site && site.pos) queueMove(creep, site.pos, BUILD_PRIORITY, 1);
  return res;
}

function rememberSourceMetadata(source, container, seatPos) {
  if (!source || !source.pos) return;
  Memory.rooms = Memory.rooms || {};
  var rm = Memory.rooms[source.pos.roomName] = Memory.rooms[source.pos.roomName] || {};
  rm.sources = rm.sources || {};
  var rec = rm.sources[source.id] = rm.sources[source.id] || {};
  rec.x = source.pos.x;
  rec.y = source.pos.y;
  rec.roomName = source.pos.roomName;
  if (seatPos) {
    rec.seat = { x: seatPos.x, y: seatPos.y, roomName: seatPos.roomName };
  }
  if (container) {
    rec.container = rec.container || {};
    rec.container.containerId = container.id;
  }
}

function cleanupClaims() {
  ensureRemoteMemory();
  var claims = Memory.__BHM.remoteSourceClaims;
  for (var sid in claims) {
    if (!Object.prototype.hasOwnProperty.call(claims, sid)) continue;
    var claim = claims[sid];
    if (!claim) { delete claims[sid]; continue; }
    if (claim.creepName && !Game.creeps[claim.creepName]) {
      delete claims[sid];
    }
  }
}

function releaseAssignment(task, reason) {
  if (!task || !task.sourceId) return;
  ensureRemoteMemory();
  var claims = Memory.__BHM.remoteSourceClaims;
  if (claims[task.sourceId] && claims[task.sourceId].creepName === task.creepName) {
    delete claims[task.sourceId];
  }
  if (reason === 'avoid') {
    Memory.__BHM.avoidSources[task.sourceId] = Game.time + AVOID_TTL;
  }
  task.sourceId = null;
  task.containerId = null;
  task.seatPos = null;
  task.since = Game.time;
  task.stuckSince = null;
  task.seatKey = null;
}

function detectThreat(source) {
  if (!source || !source.pos || !source.room) return false;
  var pos = source.pos;
  var hostiles = pos.findInRange(FIND_HOSTILE_CREEPS, AVOID_RANGE);
  if (hostiles && hostiles.length) return true;
  var cores = pos.findInRange(FIND_HOSTILE_STRUCTURES, AVOID_RANGE, {
    filter: function (s) { return s.structureType === STRUCTURE_INVADER_CORE; }
  });
  if (cores && cores.length) return true;
  return false;
}

function controllerOwnedByOther(room) {
  if (!room || !room.controller) return false;
  if (!room.controller.owner) return false;
  return !room.controller.my;
}

function tryReserveSeat(task, seatPos) {
  if (!seatPos) return true;
  ensureRemoteMemory();
  var key = seatKeyFromPos(seatPos);
  if (!key) return true;
  var reservations = Memory.__BHM.seatReservations;
  var existing = reservations[key];
  if (existing && existing === Game.time && task.seatKey !== key) {
    return false;
  }
  reservations[key] = Game.time;
  task.seatKey = key;
  return true;
}

function seatPosFromTask(task) {
  if (!task || !task.seatPos) return null;
  return new RoomPosition(task.seatPos.x, task.seatPos.y, task.seatPos.roomName);
}

function assignSource(creep, task) {
  ensureRemoteMemory();
  cleanupClaims();
  var homeRoom = task.homeRoom || inferHome(creep);
  task.homeRoom = homeRoom;
  if (!homeRoom || !BeeSelectors || typeof BeeSelectors.getRemoteSourcesSnapshot !== 'function') return;
  var entries = BeeSelectors.getRemoteSourcesSnapshot(homeRoom) || [];
  var claims = Memory.__BHM.remoteSourceClaims;
  var avoid = Memory.__BHM.avoidSources;
  var flagged = [];
  var unflagged = [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (!entry || !entry.sourceId) continue;
    if (avoid[entry.sourceId] && avoid[entry.sourceId] > Game.time) continue;
    var claim = claims[entry.sourceId];
    if (claim && claim.creepName && claim.creepName !== creep.name) continue;
    if (entry.flag) flagged.push(entry);
    else unflagged.push(entry);
  }
  var order = flagged.concat(unflagged);
  for (var j = 0; j < order.length; j++) {
    var pick = order[j];
    if (!pick) continue;
    var sourceObj = pick.source || Game.getObjectById(pick.sourceId);
    if (sourceObj && sourceObj.room && controllerOwnedByOther(sourceObj.room)) continue;
    claims[pick.sourceId] = {
      creepName: creep.name,
      homeRoom: homeRoom,
      since: Game.time
    };
    task.sourceId = pick.sourceId;
    task.seatPos = pick.seatPos ? { x: pick.seatPos.x, y: pick.seatPos.y, roomName: pick.seatPos.roomName } : null;
    task.containerId = (pick.container && pick.container.id) ? pick.container.id : null;
    task.since = Game.time;
    task.stuckSince = null;
    task.seatKey = task.seatPos ? seatKeyFromPos(task.seatPos) : null;
    return;
  }
}

function refreshSeatInfo(task) {
  if (!task || !task.sourceId) return;
  var source = Game.getObjectById(task.sourceId);
  if (!source) return;
  if (!BeeSelectors || typeof BeeSelectors.getSourceContainerOrSite !== 'function') return;
  var info = BeeSelectors.getSourceContainerOrSite(source);
  if (info && info.seatPos) {
    task.seatPos = { x: info.seatPos.x, y: info.seatPos.y, roomName: info.seatPos.roomName };
    task.seatKey = seatKeyFromPos(task.seatPos);
  }
  if (info && info.container) {
    task.containerId = info.container.id;
    rememberSourceMetadata(source, info.container, info.seatPos || info.container.pos);
  } else if (info && info.site) {
    task.containerId = null;
    rememberSourceMetadata(source, null, info.seatPos);
  } else if (info && info.seatPos) {
    rememberSourceMetadata(source, null, info.seatPos);
  }
}

function maintainAssignment(creep, task) {
  if (!task.sourceId) {
    assignSource(creep, task);
    return;
  }
  ensureRemoteMemory();
  var claims = Memory.__BHM.remoteSourceClaims;
  var claim = claims[task.sourceId];
  if (!claim || claim.creepName !== creep.name) {
    releaseAssignment(task, null);
    assignSource(creep, task);
    return;
  }
  var source = Game.getObjectById(task.sourceId);
  if (!source) return;
  if (source.room && controllerOwnedByOther(source.room)) {
    releaseAssignment(task, 'avoid');
    return;
  }
  if (detectThreat(source)) {
    releaseAssignment(task, 'avoid');
    return;
  }
  refreshSeatInfo(task);
}

function buildContainerIfNeeded(creep, task, seatPos) {
  if (!seatPos || !creep.room || creep.room.name !== seatPos.roomName) return;
  var site = creep.room.lookForAt(LOOK_CONSTRUCTION_SITES, seatPos.x, seatPos.y);
  if (site && site.length) return;
  var structures = creep.room.lookForAt(LOOK_STRUCTURES, seatPos.x, seatPos.y);
  if (structures && structures.length) return;
  creep.room.createConstructionSite(seatPos.x, seatPos.y, STRUCTURE_CONTAINER);
}

function handleHarvestLoop(creep, task) {
  var source = Game.getObjectById(task.sourceId);
  if (!source) return;
  var seatPos = seatPosFromTask(task);
  if (!seatPos) {
    queueMove(creep, source.pos, MOVE_PRIORITY, 1);
    return;
  }
  var seatReserved = tryReserveSeat(task, seatPos);
  if (!seatReserved && !creep.pos.isEqualTo(seatPos)) {
    queueMove(creep, seatPos, MOVE_PRIORITY, 1);
    return;
  }
  if (!creep.pos.isEqualTo(seatPos)) {
    queueMove(creep, seatPos, MOVE_PRIORITY, 0);
    return;
  }
  var container = task.containerId ? Game.getObjectById(task.containerId) : null;
  if (!container) {
    buildContainerIfNeeded(creep, task, seatPos);
  }
  var seatInfoSource = Game.getObjectById(task.sourceId);
  if (container) {
    safeHarvest(creep, seatInfoSource);
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      safeTransfer(creep, container);
    }
  } else {
    var site = null;
    if (creep.room && creep.room.name === seatPos.roomName) {
      var sites = creep.room.lookForAt(LOOK_CONSTRUCTION_SITES, seatPos.x, seatPos.y);
      if (sites && sites.length) site = sites[0];
    }
    if (site) {
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        safeBuild(creep, site);
      } else {
        safeHarvest(creep, seatInfoSource);
      }
    } else {
      safeHarvest(creep, seatInfoSource);
    }
  }
  task.stuckSince = null;
}

function handleTravel(creep, task) {
  var source = task.sourceId ? Game.getObjectById(task.sourceId) : null;
  if (source) {
    var seatPos = seatPosFromTask(task);
    if (seatPos) {
      queueMove(creep, seatPos, MOVE_PRIORITY, 0);
      return;
    }
    queueMove(creep, source.pos, MOVE_PRIORITY, 1);
    return;
  }
  var home = task.homeRoom || inferHome(creep);
  if (home && creep.pos.roomName !== home) {
    queueMove(creep, { x: 25, y: 25, roomName: home }, IDLE_PRIORITY, 1);
  }
}

function updateStuckState(creep, task) {
  if (!task) return;
  var last = task._lastPos;
  if (!last || last.x !== creep.pos.x || last.y !== creep.pos.y || last.roomName !== creep.pos.roomName) {
    task._lastPos = { x: creep.pos.x, y: creep.pos.y, roomName: creep.pos.roomName, tick: Game.time };
    task.stuckSince = null;
    return;
  }
  if (!task.stuckSince) {
    task.stuckSince = Game.time;
  } else if (Game.time - task.stuckSince >= STUCK_WINDOW) {
    releaseAssignment(task, null);
  }
}

var TaskLuna = {
  run: function (creep) {
    if (!creep) return;
    var task = ensureTask(creep);
    if (!task) return;
    task.creepName = creep.name;
    if (!bodyHasCarry(creep) && !task.warnedNoCarry) {
      console.log('⚠️ Luna ' + creep.name + ' lacks CARRY parts; add at least one to avoid idle harvesting.');
      task.warnedNoCarry = true;
    }
    maintainAssignment(creep, task);
    if (!task.sourceId) {
      handleTravel(creep, task);
      return;
    }
    var source = Game.getObjectById(task.sourceId);
    if (!source) {
      handleTravel(creep, task);
      return;
    }
    rememberSourceMetadata(source, task.containerId ? Game.getObjectById(task.containerId) : null, task.seatPos);
    if (source.room && controllerOwnedByOther(source.room)) {
      releaseAssignment(task, 'avoid');
      return;
    }
    if (detectThreat(source)) {
      releaseAssignment(task, 'avoid');
      return;
    }
    handleHarvestLoop(creep, task);
    updateStuckState(creep, task);
  }
};

module.exports = TaskLuna;
