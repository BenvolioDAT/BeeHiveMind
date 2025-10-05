"use strict";

const Logger = require('core.logger');
const LOG_LEVEL = Logger.LOG_LEVEL;
const econLog = Logger.createLogger('Economy', LOG_LEVEL.BASIC);

const HISTORY_LIMIT = 50;
const MIN_HISTORY_FOR_AVERAGE = 5;
const MIN_BUFFER_FOR_NON_ESSENTIAL = 500;

const ESSENTIAL_TASKS = new Set([
  'baseharvest',
  'courier',
  'queen',
]);

function ensureMemory(roomName) {
  if (!Memory.energyLedger) Memory.energyLedger = {};
  if (!Memory.energyLedger[roomName]) {
    Memory.energyLedger[roomName] = {
      history: [],
      lastTotal: null,
      pendingSpawnSpend: 0,
      currentStored: 0,
      averageIncome: 0,
      averageSpend: 0,
      averageNet: 0,
      lastUpdated: 0,
    };
  }
  return Memory.energyLedger[roomName];
}

function averageFromHistory(history, key) {
  if (!history || !history.length) return 0;
  let sum = 0;
  for (let i = 0; i < history.length; i++) {
    sum += history[i][key] || 0;
  }
  return sum / history.length;
}

function getRoomEnergyTotal(room) {
  if (!room) return 0;
  let total = room.energyAvailable || 0;
  if (room.storage && room.storage.store) {
    total += room.storage.store[RESOURCE_ENERGY] || 0;
  }
  if (room.terminal && room.terminal.store) {
    total += room.terminal.store[RESOURCE_ENERGY] || 0;
  }

  const roomMem = room.memory || {};
  const containerIds = roomMem.sourceContainers ? Object.keys(roomMem.sourceContainers) : null;
  if (containerIds && containerIds.length) {
    for (let i = 0; i < containerIds.length; i++) {
      const container = Game.getObjectById(containerIds[i]);
      if (container && container.store) {
        total += container.store[RESOURCE_ENERGY] || 0;
      }
    }
  } else {
    const containers = room.find(FIND_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_CONTAINER,
    });
    for (let i = 0; i < containers.length; i++) {
      const container = containers[i];
      if (container && container.store) {
        total += container.store[RESOURCE_ENERGY] || 0;
      }
    }
  }

  if (room.controller && room.controller.level >= 5) {
    const links = room.find(FIND_MY_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_LINK,
    });
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      if (link && link.store) {
        total += link.store[RESOURCE_ENERGY] || 0;
      }
    }
  }

  return total;
}

function updateRoom(room) {
  if (!room) return null;
  const ledger = ensureMemory(room.name);
  const total = getRoomEnergyTotal(room);

  if (ledger.lastTotal === null) {
    ledger.lastTotal = total;
    ledger.currentStored = total;
    ledger.lastUpdated = Game.time;
    return ledger;
  }

  const rawDelta = total - ledger.lastTotal;
  const spawnSpend = ledger.pendingSpawnSpend || 0;
  const netDelta = rawDelta + spawnSpend;

  const income = netDelta > 0 ? netDelta : 0;
  const otherSpend = netDelta < 0 ? -netDelta : 0;
  const spent = spawnSpend + otherSpend;
  const net = income - spent;

  ledger.history.push({
    time: Game.time,
    income,
    spent,
    spawnSpend,
    rawDelta,
    netDelta,
    net,
    stored: total,
  });
  if (ledger.history.length > HISTORY_LIMIT) {
    ledger.history.shift();
  }

  ledger.lastTotal = total;
  ledger.pendingSpawnSpend = 0;
  ledger.currentStored = total;
  ledger.averageIncome = averageFromHistory(ledger.history, 'income');
  ledger.averageSpend = averageFromHistory(ledger.history, 'spent');
  ledger.averageNet = ledger.averageIncome - ledger.averageSpend;
  ledger.lastUpdated = Game.time;

  return ledger;
}

function recordSpawnCost(roomOrName, bodyCost) {
  if (!bodyCost) return;
  let roomName = null;
  if (typeof roomOrName === 'string') {
    roomName = roomOrName;
  } else if (roomOrName) {
    if (roomOrName.name) roomName = roomOrName.name;
    else if (roomOrName.room && roomOrName.room.name) roomName = roomOrName.room.name;
  }
  if (!roomName) return;

  const ledger = ensureMemory(roomName);
  ledger.pendingSpawnSpend = (ledger.pendingSpawnSpend || 0) + bodyCost;
}

function getLedger(roomOrName) {
  const roomName = typeof roomOrName === 'string' ? roomOrName : roomOrName && roomOrName.name;
  if (!roomName || !Memory.energyLedger) return null;
  return Memory.energyLedger[roomName] || null;
}

function isEssential(taskName) {
  if (!taskName) return false;
  const key = taskName.toLowerCase();
  return ESSENTIAL_TASKS.has(key);
}

function shouldSpawn(room, taskName, bodyCost) {
  if (!room) return true;
  const ledger = getLedger(room);
  const essential = isEssential(taskName);
  if (!ledger) return true;

  const stored = ledger.currentStored || 0;
  const avgNet = ledger.averageNet || 0;
  const avgIncome = ledger.averageIncome || 0;
  const avgSpend = ledger.averageSpend || 0;
  const historyLength = ledger.history ? ledger.history.length : 0;

  if (essential) return true;

  if (historyLength >= MIN_HISTORY_FOR_AVERAGE) {
    if (avgNet < 0 && stored < Math.max(MIN_BUFFER_FOR_NON_ESSENTIAL, bodyCost)) {
      if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
        econLog.debug('Throttling spawn for', taskName, 'due to negative economy in', room.name);
      }
      return false;
    }
    if (stored < bodyCost && avgIncome <= avgSpend) {
      if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
        econLog.debug('Not enough sustained income to support', taskName, 'in', room.name);
      }
      return false;
    }
  }

  const pending = ledger.pendingSpawnSpend || 0;
  if (stored - pending < bodyCost && avgNet <= 0 && historyLength >= MIN_HISTORY_FOR_AVERAGE) {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      econLog.debug('Insufficient buffer after pending spends for', taskName, 'in', room.name);
    }
    return false;
  }

  return true;
}

module.exports = {
  updateRoom,
  recordSpawnCost,
  shouldSpawn,
  getLedger,
  getRoomEnergyTotal,
};
