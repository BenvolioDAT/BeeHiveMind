'use strict';

/**
 * What changed & why:
 * - Hardened empire logistics by deduping haul intents, attaching TTL metadata, and publishing summaries once per tick.
 * - Added light documentation of threshold rules so callers understand when overflow or refill actions trigger.
 * - Keeps Memory writes namespaced under Memory.__BHM with issued/expiry ticks for downstream consumers (couriers, trade).
 */

if (!global.__BHM) global.__BHM = { caches: {} };
if (!global.__BHM.caches) global.__BHM.caches = {};
if (typeof global.__BHM.getCached !== 'function') {
  global.__BHM.getCached = function (key, ttl, compute) {
    var caches = global.__BHM.caches;
    var entry = caches[key];
    var now = Game.time;
    if (entry && entry.expireTick >= now) return entry.value;
    var value = compute();
    caches[key] = { value: value, expireTick: (ttl > 0) ? (now + ttl) : now };
    return value;
  };
}

var THRESHOLDS = {
  STORAGE_ENERGY_FLOOR: 30000,
  STORAGE_ENERGY_TARGET: 80000,
  STORAGE_ENERGY_OVERFLOW: 250000,
  STORAGE_FREE_FLOOR: 20000,
  TERMINAL_ENERGY_FLOOR: 1000,
  TERMINAL_ENERGY_TARGET: 6000,
  MIN_SEND_AMOUNT: 2000
};

var HAUL_REQUEST_TTL = 10;

function summarizeRoom(room) {
  if (!room) return null;
  var key = 'logistics:summary:' + room.name;
  return global.__BHM.getCached(key, 1, function () {
    var storage = room.storage || null;
    var terminal = room.terminal || null;
    var storageStore = storage ? storage.store : null;
    var terminalStore = terminal ? terminal.store : null;
    var storageEnergy = storageStore ? (storageStore[RESOURCE_ENERGY] | 0) : 0;
    var terminalEnergy = terminalStore ? (terminalStore[RESOURCE_ENERGY] | 0) : 0;
    var storageFree = storageStore ? storage.store.getFreeCapacity() : 0;
    var terminalFree = terminalStore ? terminal.store.getFreeCapacity() : 0;
    var nonEnergy = {};
    if (storageStore) {
      for (var res in storageStore) {
        if (!Object.prototype.hasOwnProperty.call(storageStore, res)) continue;
        if (res === RESOURCE_ENERGY) continue;
        nonEnergy[res] = storageStore[res] | 0;
      }
    }
    if (terminalStore) {
      for (var tres in terminalStore) {
        if (!Object.prototype.hasOwnProperty.call(terminalStore, tres)) continue;
        if (tres === RESOURCE_ENERGY) continue;
        nonEnergy[tres] = (nonEnergy[tres] || 0) + (terminalStore[tres] | 0);
      }
    }
    return {
      room: room,
      storage: storage,
      terminal: terminal,
      storageEnergy: storageEnergy,
      storageFree: storageFree,
      terminalEnergy: terminalEnergy,
      terminalFree: terminalFree,
      nonEnergy: nonEnergy
    };
  });
}

function chooseOverflowResource(summary) {
  var bestRes = RESOURCE_ENERGY;
  var bestAmount = summary.storageEnergy;
  for (var res in summary.nonEnergy) {
    if (!Object.prototype.hasOwnProperty.call(summary.nonEnergy, res)) continue;
    var amt = summary.nonEnergy[res];
    if (amt > bestAmount) {
      bestRes = res;
      bestAmount = amt;
    }
  }
  return { resource: bestRes, amount: bestAmount };
}

function dedupeHaul(intents, request) {
  if (!intents._haulSet) intents._haulSet = {};
  var key = request.room + '|' + request.type + '|' + request.resource;
  if (intents._haulSet[key]) {
    intents._haulSet[key].amount = Math.max(intents._haulSet[key].amount, request.amount | 0);
    return;
  }
  intents._haulSet[key] = request;
  intents.haulRequests.push(request);
}

var LogisticsManager = {
  beginTick: function (context) {
    var empire = { energy: 0, rooms: {} };
    for (var i = 0; i < context.roomsOwned.length; i++) {
      var room = context.roomsOwned[i];
      var summary = summarizeRoom(room);
      if (!summary) continue;
      empire.rooms[room.name] = summary;
      empire.energy += summary.storageEnergy + summary.terminalEnergy;
    }
    return empire;
  },

  plan: function (context) {
    var intents = { terminalSends: [], haulRequests: [], empire: context.logistics };
    var donors = [];
    var receivers = [];
    var overflowRooms = [];
    var i;
    for (i = 0; i < context.roomsOwned.length; i++) {
      var room = context.roomsOwned[i];
      var summary = summarizeRoom(room);
      if (!summary) continue;
      if (summary.storageEnergy > THRESHOLDS.STORAGE_ENERGY_TARGET) donors.push(summary);
      if (summary.storageEnergy < THRESHOLDS.STORAGE_ENERGY_FLOOR) receivers.push(summary);
      if (summary.storage && summary.storageFree <= THRESHOLDS.STORAGE_FREE_FLOOR) overflowRooms.push(summary);
      if (summary.terminal && summary.terminalEnergy < THRESHOLDS.TERMINAL_ENERGY_FLOOR && summary.storageEnergy > THRESHOLDS.STORAGE_ENERGY_TARGET) {
        var refillAmount = Math.min(summary.storageEnergy - THRESHOLDS.STORAGE_ENERGY_TARGET, THRESHOLDS.TERMINAL_ENERGY_TARGET - summary.terminalEnergy);
        if (refillAmount > 0) {
          dedupeHaul(intents, {
            room: summary.room.name,
            type: 'push',
            resource: RESOURCE_ENERGY,
            amount: refillAmount,
            reason: 'terminal-floor'
          });
        }
      }
    }
    if (donors.length && receivers.length) {
      donors.sort(function (a, b) { return b.storageEnergy - a.storageEnergy; });
      receivers.sort(function (a, b) { return a.storageEnergy - b.storageEnergy; });
      var donor = donors[0];
      var receiver = receivers[0];
      if (donor.room.name !== receiver.room.name && donor.terminal && receiver.terminal) {
        var available = donor.terminal.store[RESOURCE_ENERGY] | 0;
        var amount = Math.min(available, THRESHOLDS.STORAGE_ENERGY_TARGET - receiver.storageEnergy);
        amount = Math.max(0, amount);
        if (amount >= THRESHOLDS.MIN_SEND_AMOUNT) {
          intents.terminalSends.push({
            from: donor.room.name,
            to: receiver.room.name,
            resource: RESOURCE_ENERGY,
            amount: amount,
            reason: 'storage-floor'
          });
          dedupeHaul(intents, {
            room: receiver.room.name,
            type: 'pull',
            resource: RESOURCE_ENERGY,
            amount: amount,
            reason: 'storage-floor'
          });
        }
      }
    }
    if (!intents.terminalSends.length && overflowRooms.length) {
      overflowRooms.sort(function (a, b) { return a.storageFree - b.storageFree; });
      var overflow = overflowRooms[0];
      var target = null;
      for (i = 0; i < context.roomsOwned.length; i++) {
        var candidate = summarizeRoom(context.roomsOwned[i]);
        if (!candidate || candidate.room.name === overflow.room.name) continue;
        if (candidate.storage && candidate.storageFree > THRESHOLDS.STORAGE_FREE_FLOOR * 2) {
          target = candidate;
          break;
        }
      }
      if (target && overflow.terminal && target.terminal) {
        var choice = chooseOverflowResource(overflow);
        var sendAmount = Math.min(choice.amount, overflow.terminal.store[choice.resource] | 0);
        if (choice.resource === RESOURCE_ENERGY) {
          sendAmount = Math.min(sendAmount, THRESHOLDS.STORAGE_ENERGY_OVERFLOW - target.storageEnergy);
        }
        if (sendAmount >= THRESHOLDS.MIN_SEND_AMOUNT) {
          intents.terminalSends.push({
            from: overflow.room.name,
            to: target.room.name,
            resource: choice.resource,
            amount: sendAmount,
            reason: 'overflow'
          });
          dedupeHaul(intents, {
            room: target.room.name,
            type: 'pull',
            resource: choice.resource,
            amount: sendAmount,
            reason: 'overflow'
          });
        }
      }
    }
    return intents;
  },

  execute: function (intents, context) {
    if (!intents) return;
    if (intents.haulRequests && intents.haulRequests.length) {
      if (!Memory.__BHM) Memory.__BHM = {};
      Memory.__BHM.haul = {
        issuedAt: Game.time,
        expires: Game.time + HAUL_REQUEST_TTL,
        requests: intents.haulRequests
      };
    }
    if (!intents.terminalSends || !intents.terminalSends.length) return;
    for (var i = 0; i < intents.terminalSends.length; i++) {
      var order = intents.terminalSends[i];
      var fromRoom = Game.rooms[order.from];
      var toRoom = order.to;
      if (!fromRoom || !fromRoom.terminal) continue;
      var terminal = fromRoom.terminal;
      if (terminal.cooldown > 0) continue;
      var amount = Math.min(order.amount, terminal.store[order.resource] | 0);
      if (amount < THRESHOLDS.MIN_SEND_AMOUNT) continue;
      var res = terminal.send(order.resource, amount, toRoom, 'BHM:' + order.reason);
      if (res === OK) {
        var logMsg = '[Logistics] Sent ' + amount + ' ' + order.resource + ' from ' + order.from + ' to ' + toRoom + ' (' + order.reason + ')';
        console.log(logMsg);
      }
    }
  }
};

module.exports = LogisticsManager;
