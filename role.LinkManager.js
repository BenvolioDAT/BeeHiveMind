'use strict';

/**
 * What changed & why:
 * - Categorized room links (source/storage/controller) once per interval so link I/O follows empire logistics policies.
 * - Controller links are topped from storage when buffers are healthy; source links drip to storage first, controller second.
 * - Avoids spamming tiny sends by enforcing minimum energy thresholds and cooldown-aware routing.
 */

var RESCAN_INTERVAL = 500;
var MIN_SEND = 100;
var STORAGE_BUFFER = 2000;

function ensureRoomMem(roomName) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  if (!Memory.rooms[roomName].linkMgr) Memory.rooms[roomName].linkMgr = { nextScan: 0, controller: null, storage: null, sources: [] };
  return Memory.rooms[roomName].linkMgr;
}

function classifyLinks(room, mem) {
  if (!room) return;
  var links = room.find(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_LINK } });
  if (!links.length) {
    mem.controller = null;
    mem.storage = null;
    mem.sources = [];
    mem.nextScan = Game.time + RESCAN_INTERVAL;
    return;
  }
  var controller = room.controller;
  var storage = room.storage || (room.find(FIND_MY_SPAWNS)[0] || null);
  var sources = room.find(FIND_SOURCES);
  var bestController = null;
  var bestControllerDist = 1e9;
  var bestStorage = null;
  var bestStorageDist = 1e9;
  var sourceLinks = [];
  for (var i = 0; i < links.length; i++) {
    var link = links[i];
    if (!link) continue;
    if (controller) {
      var dCtrl = controller.pos.getRangeTo(link);
      if (dCtrl < bestControllerDist) {
        bestControllerDist = dCtrl;
        bestController = link;
      }
    }
    if (storage) {
      var dStore = storage.pos.getRangeTo(link);
      if (dStore < bestStorageDist) {
        bestStorageDist = dStore;
        bestStorage = link;
      }
    }
  }
  for (i = 0; i < links.length; i++) {
    var candidate = links[i];
    if (!candidate) continue;
    if (bestController && candidate.id === bestController.id) continue;
    if (bestStorage && candidate.id === bestStorage.id) continue;
    var nearSource = false;
    for (var s = 0; s < sources.length; s++) {
      if (sources[s].pos.inRangeTo(candidate.pos, 2)) { nearSource = true; break; }
    }
    if (nearSource) sourceLinks.push(candidate.id);
  }
  mem.controller = bestController ? bestController.id : null;
  mem.storage = bestStorage ? bestStorage.id : null;
  mem.sources = sourceLinks;
  mem.nextScan = Game.time + RESCAN_INTERVAL;
}

function getLink(id) {
  return id ? Game.getObjectById(id) : null;
}

function sendEnergy(from, to) {
  if (!from || !to) return;
  if (from.cooldown > 0) return;
  var available = (from.store && from.store[RESOURCE_ENERGY]) | 0;
  if (available < MIN_SEND) return;
  var free = to.store ? to.store.getFreeCapacity(RESOURCE_ENERGY) : 0;
  if (free <= 0) return;
  from.transferEnergy(to);
}

var roleLinkManager = {
  run: function () {
    for (var rn in Game.rooms) {
      if (!Game.rooms.hasOwnProperty(rn)) continue;
      var room = Game.rooms[rn];
      if (!room.controller || !room.controller.my) continue;
      var mem = ensureRoomMem(rn);
      if (Game.time >= (mem.nextScan | 0)) classifyLinks(room, mem);
      var controllerLink = getLink(mem.controller);
      var storageLink = getLink(mem.storage);
      var sourceLinks = [];
      for (var i = 0; i < mem.sources.length; i++) {
        var obj = getLink(mem.sources[i]);
        if (obj) sourceLinks.push(obj);
      }
      var storageEnergy = room.storage ? (room.storage.store[RESOURCE_ENERGY] | 0) : 0;
      if (storageLink && controllerLink && storageEnergy >= STORAGE_BUFFER) {
        sendEnergy(storageLink, controllerLink);
      }
      for (i = 0; i < sourceLinks.length; i++) {
        var srcLink = sourceLinks[i];
        if (!srcLink) continue;
        if (storageLink) {
          var storageFree = storageLink.store ? storageLink.store.getFreeCapacity(RESOURCE_ENERGY) : 0;
          if (storageFree > 0) {
            sendEnergy(srcLink, storageLink);
            continue;
          }
        }
        if (controllerLink) sendEnergy(srcLink, controllerLink);
      }
    }
  }
};

module.exports = roleLinkManager;
