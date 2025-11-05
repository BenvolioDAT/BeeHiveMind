'use strict';

/**
 * What changed & why:
 * - Converted the remote harvester into the shared _task envelope so travel/harvest/deliver steps persist until satisfied.
 * - Replaced bespoke pathing with Movement.Manager intents and BeeActions wrappers, keeping compatibility with Traveler.
 * - Simplified remote source assignment via SRC-* flags while preserving legacy memory fields (homeRoom, targetRoom, sourceId).
 */

var BeeSelectors = require('BeeSelectors');
var BeeActions = require('BeeActions');
var MovementManager = require('Movement.Manager');

var CFG = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,
  DRAW: {
    TRAVEL: '#8ab6ff',
    HARVEST: '#ff9a6e',
    DELIVER: '#6effa1',
    DROP: '#ffe66e',
    IDLE: '#bfbfbf',
    WIDTH: 0.12,
    OPACITY: 0.45,
    FONT: 0.6
  },
  STUCK_TICKS: 6,
  ASSIGN_RETRY: 25,
  MAX_PER_SOURCE: 1,
  MOVE_PRIORITIES: {
    travel: 70,
    harvest: 60,
    deliver: 45,
    drop: 40,
    idle: 5
  }
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

function ensureTaskSlot(creep) {
  if (!creep || !creep.memory) return;
  if (!creep.memory._task) creep.memory._task = null;
}

function setTask(creep, task) {
  if (!creep || !creep.memory) return;
  creep.memory._task = task;
}

function clearTask(creep) {
  if (!creep || !creep.memory) return;
  creep.memory._task = null;
}

function createTask(type, targetId, data) {
  return {
    type: type,
    targetId: targetId || null,
    since: Game.time,
    data: data || {}
  };
}

function createTravelTask(posRec, range, extra) {
  if (!posRec) return null;
  var data = {
    pos: { x: posRec.x, y: posRec.y, roomName: posRec.roomName },
    range: (range != null) ? range : 1
  };
  if (extra) {
    for (var k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) {
        data[k] = extra[k];
      }
    }
  }
  return createTask('travel', null, data);
}

function createIdleTask(creep) {
  var anchor = getIdleAnchorPos(creep);
  if (!anchor) return createTask('idle', null, null);
  var data = {
    pos: { x: anchor.x, y: anchor.y, roomName: anchor.roomName },
    range: anchor.range != null ? anchor.range : 2
  };
  return createTask('idle', null, data);
}

function getHomeRoom(creep) {
  if (!creep || !creep.memory) return null;
  if (creep.memory.homeRoom) return creep.memory.homeRoom;
  if (creep.memory.home) {
    creep.memory.homeRoom = creep.memory.home;
    return creep.memory.homeRoom;
  }
  for (var name in Game.spawns) {
    var spawn = Game.spawns[name];
    if (spawn && spawn.room) {
      creep.memory.homeRoom = spawn.room.name;
      return creep.memory.homeRoom;
    }
  }
  if (creep.room) {
    creep.memory.homeRoom = creep.room.name;
    return creep.memory.homeRoom;
  }
  return null;
}

function getHomeAnchorPos(homeName) {
  if (!homeName) return null;
  var room = Game.rooms[homeName];
  if (room) {
    if (room.storage) return { x: room.storage.pos.x, y: room.storage.pos.y, roomName: room.storage.pos.roomName };
    var spawns = room.find(FIND_MY_SPAWNS);
    if (spawns && spawns.length) {
      var sp = spawns[0];
      return { x: sp.pos.x, y: sp.pos.y, roomName: sp.pos.roomName };
    }
    if (room.controller) {
      return { x: room.controller.pos.x, y: room.controller.pos.y, roomName: room.controller.pos.roomName };
    }
  }
  return { x: 25, y: 25, roomName: homeName };
}

function getIdleAnchorPos(creep) {
  var assignment = getAssignmentPosition(creep);
  if (assignment) return { x: assignment.x, y: assignment.y, roomName: assignment.roomName, range: 3 };
  if (creep && creep.pos) return { x: creep.pos.x, y: creep.pos.y, roomName: creep.pos.roomName, range: 2 };
  return null;
}

function countAssignments(flagName, exclude) {
  var total = 0;
  for (var name in Game.creeps) {
    var other = Game.creeps[name];
    if (!other || !other.memory) continue;
    if (exclude && other.name === exclude) continue;
    if (other.memory.task !== 'luna') continue;
    if (other.memory.remoteFlag === flagName) total++;
  }
  return total;
}

function ensureRemoteAssignment(creep) {
  if (!creep || !creep.memory) return null;
  var home = getHomeRoom(creep);
  if (!home) return null;

  if (creep.memory.remoteFlag) {
    var flag = Game.flags[creep.memory.remoteFlag];
    if (flag) {
      creep.memory.targetRoom = flag.pos.roomName;
      creep.memory.sourcePos = { x: flag.pos.x, y: flag.pos.y, roomName: flag.pos.roomName };
      return flag;
    }
    creep.memory.remoteFlag = null;
    creep.memory.targetRoom = null;
    creep.memory.sourceId = null;
  }

  var cooldown = creep.memory._assignCooldown || 0;
  if (Game.time < cooldown) return null;

  var prefix = 'SRC-' + home + '-';
  var bestFlag = null;
  var bestScore = null;

  for (var name in Game.flags) {
    var f = Game.flags[name];
    if (!f || typeof f.name !== 'string') continue;
    if (f.name.indexOf(prefix) !== 0) continue;
    var load = countAssignments(f.name, creep.name);
    if (load >= CFG.MAX_PER_SOURCE) continue;
    var dist = Game.map.getRoomLinearDistance(home, f.pos.roomName, true) || 0;
    var score = (load * 1000) + dist;
    if (!bestFlag || score < bestScore) {
      bestFlag = f;
      bestScore = score;
    }
  }

  if (bestFlag) {
    creep.memory.remoteFlag = bestFlag.name;
    creep.memory.targetRoom = bestFlag.pos.roomName;
    creep.memory.sourcePos = { x: bestFlag.pos.x, y: bestFlag.pos.y, roomName: bestFlag.pos.roomName };
    creep.memory.sourceId = null;
    creep.memory._assignCooldown = Game.time + CFG.ASSIGN_RETRY;
    return bestFlag;
  }

  creep.memory._assignCooldown = Game.time + CFG.ASSIGN_RETRY;
  return null;
}

function getAssignmentPosition(creep) {
  if (!creep || !creep.memory) return null;
  if (creep.memory.sourcePos) return creep.memory.sourcePos;
  if (creep.memory.remoteFlag) {
    var flag = Game.flags[creep.memory.remoteFlag];
    if (flag) return { x: flag.pos.x, y: flag.pos.y, roomName: flag.pos.roomName };
  }
  return null;
}

function resolveSource(creep) {
  if (!creep || !creep.memory) return null;
  if (creep.memory.sourceId) {
    var obj = Game.getObjectById(creep.memory.sourceId);
    if (obj) return obj;
  }
  var posRec = getAssignmentPosition(creep);
  if (!posRec) return null;
  var room = Game.rooms[posRec.roomName];
  if (!room) return null;
  var pos = new RoomPosition(posRec.x, posRec.y, posRec.roomName);
  var sources = pos.lookFor(LOOK_SOURCES);
  var source = sources && sources.length ? sources[0] : null;
  if (!source) {
    var nearby = pos.findInRange(FIND_SOURCES, 1);
    if (nearby && nearby.length) source = nearby[0];
  }
  if (source) {
    creep.memory.sourceId = source.id;
    creep.memory.sourcePos = { x: source.pos.x, y: source.pos.y, roomName: source.pos.roomName };
    return source;
  }
  return null;
}

function findRemoteDropoff(creep, source) {
  if (!source || !source.pos || !source.room) return null;
  var structs = source.pos.findInRange(FIND_STRUCTURES, 1);
  var best = null;
  var bestFree = 0;
  for (var i = 0; i < structs.length; i++) {
    var s = structs[i];
    if (!s) continue;
    var free = 0;
    if (s.store && s.store.getFreeCapacity) {
      free = s.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
    } else if (s.energyCapacity != null) {
      free = (s.energyCapacity | 0) - (s.energy | 0);
    }
    if (free > bestFree) {
      best = s;
      bestFree = free;
    }
  }
  if (best && bestFree > 0) return best;
  return null;
}

function findHomeDeliveryTarget(creep, homeRoom) {
  if (!creep || !homeRoom) return null;
  var spawnLike = BeeSelectors.findSpawnLikeNeedingEnergy(homeRoom);
  var chosen = BeeSelectors.selectClosestByRange(creep.pos, spawnLike);
  if (chosen) return chosen;
  var towers = BeeSelectors.findTowersNeedingEnergy(homeRoom);
  chosen = BeeSelectors.selectClosestByRange(creep.pos, towers);
  if (chosen) return chosen;
  var storageNeed = BeeSelectors.findStorageNeedingEnergy(homeRoom);
  if (storageNeed) return storageNeed;
  if (homeRoom.storage) return homeRoom.storage;
  if (homeRoom.terminal) return homeRoom.terminal;
  return null;
}

function getFreeEnergyCapacity(structure) {
  if (!structure) return 0;
  if (structure.store && structure.store.getFreeCapacity) {
    return structure.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
  }
  if (structure.energyCapacity != null) {
    return (structure.energyCapacity | 0) - (structure.energy | 0);
  }
  return 0;
}

function needsNewTask(creep, task) {
  if (!task) return true;
  if (!task.data) task.data = {};
  var target = task.targetId ? Game.getObjectById(task.targetId) : null;

  if (task.type === 'harvest') {
    if (!target) return true;
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return true;
  } else if (task.type === 'deliver') {
    if (!target) return true;
    if ((creep.store[RESOURCE_ENERGY] || 0) === 0) return true;
    if (getFreeEnergyCapacity(target) === 0) return true;
  } else if (task.type === 'travel') {
    var posRec = task.data.pos;
    if (!posRec) return true;
    var range = (task.data.range != null) ? task.data.range : 1;
    if (creep.pos.roomName === posRec.roomName) {
      var dest = new RoomPosition(posRec.x, posRec.y, posRec.roomName);
      if (creep.pos.getRangeTo(dest) <= range) return true;
    }
  } else if (task.type === 'drop') {
    if ((creep.store[RESOURCE_ENERGY] || 0) === 0) return true;
  } else if (task.type === 'idle') {
    // Always re-evaluate idling when we have energy or assignments.
    if ((creep.store[RESOURCE_ENERGY] || 0) > 0) return true;
  }

  var data = task.data;
  if (data.lastPosX === creep.pos.x && data.lastPosY === creep.pos.y) {
    data.stuck = (data.stuck || 0) + 1;
    if (data.stuck >= CFG.STUCK_TICKS) return true;
  } else {
    data.stuck = 0;
    data.lastPosX = creep.pos.x;
    data.lastPosY = creep.pos.y;
  }

  return false;
}

function chooseGatherTask(creep) {
  ensureRemoteAssignment(creep);
  var source = resolveSource(creep);
  var posRec = getAssignmentPosition(creep);
  if (!source) {
    if (posRec) return createTravelTask(posRec, 1, { label: 'SRC' });
    return null;
  }
  if (creep.pos.roomName !== source.pos.roomName) {
    return createTravelTask({ x: source.pos.x, y: source.pos.y, roomName: source.pos.roomName }, 1, { label: 'SRC' });
  }
  return createTask('harvest', source.id, { kind: 'source' });
}

function chooseDeliveryTask(creep) {
  var energy = creep.store[RESOURCE_ENERGY] || 0;
  if (energy === 0) return null;
  var source = resolveSource(creep);
  var remoteDrop = findRemoteDropoff(creep, source);
  if (remoteDrop && getFreeEnergyCapacity(remoteDrop) > 0) {
    return createTask('deliver', remoteDrop.id, { mode: 'remote' });
  }
  var homeName = getHomeRoom(creep);
  if (homeName && creep.pos.roomName !== homeName) {
    var anchor = getHomeAnchorPos(homeName);
    if (anchor) return createTravelTask(anchor, 1, { label: 'HOME' });
  }
  var homeRoom = homeName ? Game.rooms[homeName] : null;
  if (!homeRoom && creep.room && creep.room.name === homeName) homeRoom = creep.room;
  if (homeRoom) {
    var deliverTarget = findHomeDeliveryTarget(creep, homeRoom);
    if (deliverTarget) return createTask('deliver', deliverTarget.id, { mode: 'home' });
  }
  if (creep.room && creep.room.storage && creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    return createTask('deliver', creep.room.storage.id, { mode: 'localStorage' });
  }
  if (creep.room && creep.room.terminal && creep.room.terminal.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    return createTask('deliver', creep.room.terminal.id, { mode: 'localTerminal' });
  }
  return createTask('drop', null, { reason: 'noTarget' });
}

function chooseNextTask(creep) {
  if (creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    var gather = chooseGatherTask(creep);
    if (gather) return gather;
  }
  if ((creep.store[RESOURCE_ENERGY] || 0) > 0) {
    var deliver = chooseDeliveryTask(creep);
    if (deliver) return deliver;
  }
  return createIdleTask(creep);
}

function executeTask(creep, task) {
  if (!task) return;
  var priority = CFG.MOVE_PRIORITIES[task.type] || 0;
  var target = task.targetId ? Game.getObjectById(task.targetId) : null;

  if (task.type === 'travel') {
    var posRec = task.data && task.data.pos;
    if (!posRec) { clearTask(creep); return; }
    var dest = new RoomPosition(posRec.x, posRec.y, posRec.roomName);
    drawLine(creep, dest, CFG.DRAW.TRAVEL, 'GO');
    debugSay(creep, '➡️');
    MovementManager.request(creep, dest, priority, { range: task.data.range || 1, reusePath: 50 });
    return;
  }

  if (task.type === 'harvest') {
    if (!target) { clearTask(creep); return; }
    drawLine(creep, target, CFG.DRAW.HARVEST, 'HAR');
    debugSay(creep, '⛏️');
    var rc = BeeActions.safeHarvest(creep, target, { priority: priority, reusePath: 10 });
    if (rc === OK && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) clearTask(creep);
    if (rc === ERR_INVALID_TARGET) clearTask(creep);
    return;
  }

  if (task.type === 'deliver') {
    if (!target) { clearTask(creep); return; }
    drawLine(creep, target, CFG.DRAW.DELIVER, 'DEL');
    debugSay(creep, '📦');
    var tr = BeeActions.safeTransfer(creep, target, RESOURCE_ENERGY, null, { priority: priority, reusePath: 20 });
    if (tr === OK && (creep.store[RESOURCE_ENERGY] || 0) === 0) clearTask(creep);
    if (tr === ERR_FULL || tr === ERR_INVALID_TARGET) clearTask(creep);
    return;
  }

  if (task.type === 'drop') {
    debugSay(creep, '💧');
    if ((creep.store[RESOURCE_ENERGY] || 0) > 0) creep.drop(RESOURCE_ENERGY);
    clearTask(creep);
    return;
  }

  if (task.type === 'idle') {
    var idlePos = task.data && task.data.pos;
    if (!idlePos) return;
    var anchor = new RoomPosition(idlePos.x, idlePos.y, idlePos.roomName);
    drawLine(creep, anchor, CFG.DRAW.IDLE, 'ID');
    MovementManager.request(creep, anchor, priority, { range: task.data.range || 2, reusePath: 30 });
    return;
  }
}

var TaskLuna = {
  run: function (creep) {
    if (!creep || creep.spawning) return;
    ensureTaskSlot(creep);
    ensureRemoteAssignment(creep);

    var task = creep.memory._task;
    if (needsNewTask(creep, task)) {
      task = chooseNextTask(creep);
      setTask(creep, task);
    }

    task = creep.memory._task;
    if (!task) {
      setTask(creep, createIdleTask(creep));
      task = creep.memory._task;
    }

    executeTask(creep, task);
  }
};

module.exports = TaskLuna;
