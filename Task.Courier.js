'use strict';

/**
 * What changed & why:
 * - Tightened courier haul integration by consuming Logistics.Manager TTL-backed requests with per-tick claims.
 * - Swapped ad-hoc priorities for Movement.Manager intent types so traffic ordering stays consistent across roles.
 * - Keeps persistent _task envelopes while leaning on BeeSelectors/BeeActions for cached targets and safe actions.
 */

var BeeSelectors = require('BeeSelectors');
var BeeActions = require('BeeActions');

var CFG = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,
  DRAW: {
    WITHDRAW: '#6ec1ff',
    DELIVER: '#6effa1',
    PICKUP: '#ffe66e',
    IDLE: '#bfbfbf',
    WIDTH: 0.12,
    OPACITY: 0.45,
    FONT: 0.6
  },
  STUCK_TICKS: 6,
  HAUL_GRACE: 2
});

function debugSay(creep, msg) {
  if (CFG.DEBUG_SAY && creep && msg) creep.say(msg, true);
}

function drawLine(creep, target, color, label) {
  if (!CFG.DEBUG_DRAW || !creep || !target) return;
  var room = creep.room;
  if (!room || !room.visual) return;
  var pos = target.pos || target;
  if (!pos || pos.roomName !== room.name) return;
  try {
    room.visual.line(creep.pos, pos, {
      color: color,
      width: CFG.DRAW.WIDTH,
      opacity: CFG.DRAW.OPACITY,
      lineStyle: 'solid'
    });
    if (label) {
      room.visual.text(label, pos.x, pos.y - 0.3, {
        color: color,
        opacity: CFG.DRAW.OPACITY,
        font: CFG.DRAW.FONT,
        align: 'center'
      });
    }
  } catch (e) {}
}

function ensureTask(creep) {
  if (!creep.memory) return;
  if (!creep.memory._task) creep.memory._task = null;
}

// Expansion helper: detect haulers earmarked for forward base work.
function isExpansionAssignment(creep) {
  if (!creep || !creep.memory) return false;
  if (creep.memory.task === 'expand' && creep.memory.target) return true;
  if (creep.memory.expand && creep.memory.expand.target) {
    if (!creep.memory.target) creep.memory.target = creep.memory.expand.target;
    creep.memory.task = 'expand';
    return true;
  }
  return false;
}

// Expansion helper: centralized room-to-room routing with Traveler if available.
function travelToRoomCenter(creep, roomName) {
  if (!creep || !roomName) return;
  var targetPos = new RoomPosition(25, 25, roomName);
  if (creep.travelTo) {
    creep.travelTo(targetPos, { range: 20, reusePath: 40 });
  } else {
    creep.moveTo(targetPos, { reusePath: 40 });
  }
}

// Expansion helper: identify any spawn asset (structure/site) in the target room.
function locateExpansionSpawn(room) {
  if (!room) return null;
  var built = room.find(FIND_MY_STRUCTURES, {
    filter: function (s) { return s.structureType === STRUCTURE_SPAWN; }
  });
  if (built && built.length > 0) return built[0];
  var sites = room.find(FIND_MY_CONSTRUCTION_SITES, {
    filter: function (s) { return s.structureType === STRUCTURE_SPAWN; }
  });
  if (sites && sites.length > 0) return sites[0];
  return null;
}

// Expansion helper: determine whether the fledgling room is stable enough to hand back to defaults.
function expansionRoomStable(room) {
  if (!room) return false;
  var spawn = room.find(FIND_MY_STRUCTURES, {
    filter: function (s) { return s.structureType === STRUCTURE_SPAWN; }
  });
  if (!spawn || spawn.length === 0) return false;
  if (!room.controller || !room.controller.my) return false;
  return room.controller.level >= 2 && room.controller.ticksToDowngrade > CONTROLLER_DOWNGRADE[room.controller.level] / 2;
}

// Expansion helper: pick the best home-side withdrawal target so couriers stay efficient.
function chooseHomeEnergySource(room) {
  if (!room) return null;
  if (room.storage && room.storage.store && room.storage.store[RESOURCE_ENERGY] > 0) {
    return { target: room.storage, action: 'withdraw' };
  }
  if (room.terminal && room.terminal.store && room.terminal.store[RESOURCE_ENERGY] > 0) {
    return { target: room.terminal, action: 'withdraw' };
  }
  var spawns = room.find(FIND_MY_STRUCTURES, {
    filter: function (s) { return s.structureType === STRUCTURE_SPAWN && s.store[RESOURCE_ENERGY] > 0; }
  });
  if (spawns && spawns.length > 0) return { target: spawns[0], action: 'withdraw' };
  var containers = room.find(FIND_STRUCTURES, {
    filter: function (s) {
      return s.structureType === STRUCTURE_CONTAINER && s.store && s.store[RESOURCE_ENERGY] > 0;
    }
  });
  if (containers && containers.length > 0) return { target: containers[0], action: 'withdraw' };
  var drops = room.find(FIND_DROPPED_RESOURCES, {
    filter: function (r) { return r.resourceType === RESOURCE_ENERGY && r.amount > 100; }
  });
  if (drops && drops.length > 0) return { target: drops[0], action: 'pickup' };
  return null;
}

// Expansion helper: provide a sink inside the target room (spawn, builders, or a drop spot).
function deliverExpansionEnergy(creep, room, expansionAnchor) {
  if (!creep || !room) return true;
  var spawnAsset = locateExpansionSpawn(room);
  if (spawnAsset && spawnAsset.structureType === STRUCTURE_SPAWN) {
    if (!creep.pos.inRangeTo(spawnAsset, 1)) {
      if (creep.travelTo) {
        creep.travelTo(spawnAsset, { range: 1, reusePath: 15 });
      } else {
        creep.moveTo(spawnAsset, { reusePath: 15 });
      }
      return true;
    }
    BeeActions.safeTransfer(creep, spawnAsset, RESOURCE_ENERGY);
    return true;
  }
  var builders = room.find(FIND_MY_CREEPS, {
    filter: function (c) {
      if (c === creep) return false;
      if (!isExpansionAssignment(c)) return false;
      if (!c.store || c.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return false;
      if (c.memory.expand && c.memory.expand.role && c.memory.expand.role !== 'builder') return false;
      return true;
    }
  });
  if (builders && builders.length > 0) {
    var buddy = builders[0];
    if (!creep.pos.inRangeTo(buddy, 1)) {
      if (creep.travelTo) {
        creep.travelTo(buddy, { range: 1, reusePath: 10 });
      } else {
        creep.moveTo(buddy, { reusePath: 10 });
      }
      return true;
    }
    creep.transfer(buddy, RESOURCE_ENERGY);
    return true;
  }
  if (spawnAsset && spawnAsset.pos) {
    if (!creep.pos.inRangeTo(spawnAsset.pos, 1)) {
      if (creep.travelTo) {
        creep.travelTo(spawnAsset.pos, { range: 1, reusePath: 10 });
      } else {
        creep.moveTo(spawnAsset.pos, { reusePath: 10 });
      }
      return true;
    }
  } else if (expansionAnchor) {
    if (!creep.pos.inRangeTo(expansionAnchor, 1)) {
      if (creep.travelTo) {
        creep.travelTo(expansionAnchor, { range: 1, reusePath: 10 });
      } else {
        creep.moveTo(expansionAnchor, { reusePath: 10 });
      }
      return true;
    }
  }
  creep.drop(RESOURCE_ENERGY);
  return true;
}

// Expansion-specific behavior: shuttle energy from home to target until the spawn is online and controller is steady.
function handleExpansionCourier(creep) {
  if (!isExpansionAssignment(creep)) return false;
  var targetRoomName = creep.memory.target;
  if (!targetRoomName) return false;
  var targetRoom = Game.rooms[targetRoomName];
  if (expansionRoomStable(targetRoom)) return false;
  var anchor = null;
  if (targetRoom) {
    var spawnAsset = locateExpansionSpawn(targetRoom);
    if (spawnAsset && spawnAsset.pos) {
      anchor = spawnAsset.pos;
    } else if (targetRoom.controller) {
      anchor = targetRoom.controller.pos;
    }
  }
  var homeName = creep.memory.home;
  if (!homeName) {
    if (creep.memory.expand && creep.memory.expand.home) {
      homeName = creep.memory.expand.home;
      creep.memory.home = homeName;
    } else if (creep.memory.homeRoom) {
      homeName = creep.memory.homeRoom;
    }
  }
  if (creep.store[RESOURCE_ENERGY] === 0) {
    if (homeName && creep.room.name !== homeName) {
      travelToRoomCenter(creep, homeName);
      return true;
    }
    var homeRoom = homeName ? Game.rooms[homeName] : creep.room;
    if (!homeRoom) {
      if (homeName) travelToRoomCenter(creep, homeName);
      return true;
    }
    var source = chooseHomeEnergySource(homeRoom);
    if (!source || !source.target) {
      if (homeRoom.controller) {
        if (!creep.pos.inRangeTo(homeRoom.controller, 3)) {
          travelToRoomCenter(creep, homeRoom.name);
        }
      }
      return true;
    }
    var target = source.target;
    if (source.action === 'pickup') {
      if (!creep.pos.inRangeTo(target, 1)) {
        if (creep.travelTo) {
          creep.travelTo(target, { range: 1, reusePath: 10 });
        } else {
          creep.moveTo(target, { reusePath: 10 });
        }
        return true;
      }
      BeeActions.safePickup(creep, target);
      return true;
    }
    if (!creep.pos.inRangeTo(target, 1)) {
      if (creep.travelTo) {
        creep.travelTo(target, { range: 1, reusePath: 10 });
      } else {
        creep.moveTo(target, { reusePath: 10 });
      }
      return true;
    }
    BeeActions.safeWithdraw(creep, target, RESOURCE_ENERGY);
    return true;
  }
  if (creep.room.name !== targetRoomName) {
    travelToRoomCenter(creep, targetRoomName);
    return true;
  }
  if (!targetRoom) {
    travelToRoomCenter(creep, targetRoomName);
    return true;
  }
  deliverExpansionEnergy(creep, targetRoom, anchor);
  return true;
}

function releaseHaulKey(key) {
  if (!key) return;
  if (!Memory.__BHM || !Memory.__BHM.haul || !Memory.__BHM.haul.entries) return;
  delete Memory.__BHM.haul.entries[key];
  var entries = Memory.__BHM.haul.entries;
  var remaining = false;
  for (var k in entries) {
    if (Object.prototype.hasOwnProperty.call(entries, k)) { remaining = true; break; }
  }
  if (!remaining) delete Memory.__BHM.haul;
}

function clearTask(creep) {
  if (!creep || !creep.memory) return;
  var existing = creep.memory._task;
  if (existing && existing.data && existing.data.request && existing.data.request.key) {
    releaseHaulKey(existing.data.request.key);
  }
  creep.memory._task = null;
}

function haulMemoryValid(entry) {
  if (!entry) return false;
  if (entry.expires != null && Game.time > entry.expires) return false;
  if (entry.issued != null && entry.issued < Game.time - 1) return false;
  return true;
}

function getHaulRequests() {
  if (!Memory.__BHM || !Memory.__BHM.haul) return null;
  var haul = Memory.__BHM.haul;
  if (!haul || !haul.entries) return null;
  if (haul.expires != null && Game.time > haul.expires) return null;
  return haul;
}

function initHaulClaims() {
  if (!global.__BHM) global.__BHM = { caches: {} };
  if (global.__BHM.haulClaimsTick !== Game.time) {
    global.__BHM.haulClaimsTick = Game.time;
    global.__BHM.haulClaims = {};
  }
}

function claimHaulRequest(creep) {
  var haul = getHaulRequests();
  if (!haul) return null;
  initHaulClaims();
  var claims = global.__BHM.haulClaims;
  var entries = haul.entries;
  for (var key in entries) {
    if (!Object.prototype.hasOwnProperty.call(entries, key)) continue;
    var req = entries[key];
    if (!req || req.room !== creep.room.name) continue;
    if (req.resource !== RESOURCE_ENERGY) continue;
    if (!haulMemoryValid(req)) {
      releaseHaulKey(key);
      continue;
    }
    if (claims[key]) continue;
    claims[key] = creep.name;
    return {
      room: req.room,
      type: req.type,
      resource: req.resource,
      amount: req.amount,
      reason: req.reason,
      expires: (req.expires != null) ? req.expires : (Game.time + CFG.HAUL_GRACE),
      targetId: req.targetId,
      key: key
    };
  }
  return null;
}

function pickWithdrawTask(creep) {
  var room = creep.room;
  var sources = BeeSelectors.getEnergySourcePriority(room);
  for (var i = 0; i < sources.length; i++) {
    var entry = sources[i];
    if (!entry || !entry.target) continue;
    if (entry.kind === 'source') continue; // couriers lack WORK parts normally; skip harvest fallback.
    if (entry.kind === 'drop') {
      return { type: 'pickup', targetId: entry.target.id, since: Game.time, data: { source: 'drop' } };
    }
    if (entry.kind === 'tomb') {
      return { type: 'withdraw', targetId: entry.target.id, since: Game.time, data: { source: 'tomb' } };
    }
    if (entry.kind === 'ruin') {
      return { type: 'withdraw', targetId: entry.target.id, since: Game.time, data: { source: 'ruin' } };
    }
    return { type: 'withdraw', targetId: entry.target.id, since: Game.time, data: { source: entry.kind || 'energy' } };
  }
  return null;
}

function targetFromHaul(room, haul) {
  if (!haul || !haul.targetId) return null;
  var obj = Game.getObjectById(haul.targetId);
  if (obj) return obj;
  if (haul.type === 'pull') return room.storage || room.terminal || null;
  if (haul.type === 'push') return room.terminal || room.storage || null;
  return null;
}

function pickDeliverTask(creep) {
  var room = creep.room;
  var targets = BeeSelectors.findSpawnLikeNeedingEnergy(room);
  var chosen = BeeSelectors.selectClosestByRange(creep.pos, targets);
  if (chosen) {
    return { type: 'deliver', targetId: chosen.id, since: Game.time, data: { sink: 'spawnLike' } };
  }
  var towers = BeeSelectors.findTowersNeedingEnergy(room);
  chosen = BeeSelectors.selectClosestByRange(creep.pos, towers);
  if (chosen) {
    return { type: 'deliver', targetId: chosen.id, since: Game.time, data: { sink: 'tower' } };
  }
  var haul = claimHaulRequest(creep);
  if (haul) {
    var haulTarget = targetFromHaul(room, haul);
    if (haulTarget) {
      return { type: 'deliver', targetId: haulTarget.id, since: Game.time, data: { sink: 'haul', request: haul } };
    }
  }
  var storage = BeeSelectors.findStorageNeedingEnergy(room);
  if (storage) {
    return { type: 'deliver', targetId: storage.id, since: Game.time, data: { sink: 'storage' } };
  }
  if (room.terminal) {
    return { type: 'deliver', targetId: room.terminal.id, since: Game.time, data: { sink: 'terminal' } };
  }
  return null;
}

function needsNewDueToHaul(task) {
  if (!task || !task.data || !task.data.request) return false;
  var haul = task.data.request;
  if (!haulMemoryValid(haul)) return true;
  var mem = getHaulRequests();
  if (!mem || !mem.entries) return true;
  if (!haul.key) return true;
  if (!mem.entries[haul.key]) return true;
  return false;
}

function needNewTask(creep, task) {
  if (!task) return true;
  var target = Game.getObjectById(task.targetId);
  if (!target) return true;
  if (task.type === 'withdraw' || task.type === 'pickup') {
    if (creep.store.getFreeCapacity() === 0) return true;
    if (task.type === 'withdraw' && target.store && (target.store[RESOURCE_ENERGY] | 0) === 0) return true;
    if (task.type === 'pickup' && target.amount <= 0) return true;
  }
  if (task.type === 'deliver') {
    if (creep.store[RESOURCE_ENERGY] === 0) return true;
    if (needsNewDueToHaul(task)) return true;
    if (target.store && target.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return true;
    if (target.energyCapacity != null && (target.energy | 0) >= (target.energyCapacity | 0)) return true;
  }
  if (!task.data) task.data = {};
  if (task.data.lastPosX === creep.pos.x && task.data.lastPosY === creep.pos.y) {
    task.data.stuck = (task.data.stuck | 0) + 1;
    if (task.data.stuck >= CFG.STUCK_TICKS) return true;
  } else {
    task.data.stuck = 0;
    task.data.lastPosX = creep.pos.x;
    task.data.lastPosY = creep.pos.y;
  }
  return false;
}

function executeTask(creep, task) {
  if (!task) return;
  var target = Game.getObjectById(task.targetId);
  if (!target) {
    clearTask(creep);
    return;
  }
  if (task.type === 'withdraw') {
    drawLine(creep, target, CFG.DRAW.WITHDRAW, 'WD');
    debugSay(creep, '📦');
    var withdrawOpts = { reusePath: 20 };
    var rc = BeeActions.safeWithdraw(creep, target, RESOURCE_ENERGY, withdrawOpts);
    if (rc === OK && creep.store.getFreeCapacity() === 0) clearTask(creep);
    return;
  }
  if (task.type === 'pickup') {
    drawLine(creep, target, CFG.DRAW.PICKUP, 'DROP');
    debugSay(creep, '🍪');
    var pickupOpts = { reusePath: 10 };
    var pc = BeeActions.safePickup(creep, target, pickupOpts);
    if (pc === OK && creep.store.getFreeCapacity() === 0) clearTask(creep);
    return;
  }
  if (task.type === 'deliver') {
    drawLine(creep, target, CFG.DRAW.DELIVER, 'DEL');
    debugSay(creep, '🚚');
    var transferOpts = { reusePath: 20 };
    var tr = BeeActions.safeTransfer(creep, target, RESOURCE_ENERGY, null, transferOpts);
    if (tr === OK && creep.store[RESOURCE_ENERGY] === 0) clearTask(creep);
    return;
  }
}

var TaskCourier = {
  run: function (creep) {
    if (!creep || creep.spawning) return;
    if (handleExpansionCourier(creep)) return;
    ensureTask(creep);
    var task = creep.memory._task;
    if (needNewTask(creep, task)) {
      clearTask(creep);
      var newTask = null;
      if (creep.store[RESOURCE_ENERGY] > 0) {
        newTask = pickDeliverTask(creep);
      }
      if (!newTask) {
        newTask = pickWithdrawTask(creep);
      }
      if (!newTask && creep.store[RESOURCE_ENERGY] > 0) {
        var storage = creep.room.storage || creep.room.terminal;
        if (storage) newTask = { type: 'deliver', targetId: storage.id, since: Game.time, data: { sink: 'fallback' } };
      }
      if (!newTask) {
        debugSay(creep, '🧘');
        if (CFG.DEBUG_DRAW) drawLine(creep, creep.pos, CFG.DRAW.IDLE, 'IDLE');
        clearTask(creep);
        return;
      }
      creep.memory._task = newTask;
      task = newTask;
    }
    executeTask(creep, task);
  }
};

module.exports = TaskCourier;
