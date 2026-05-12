'use strict';
// owns: stable public facade for selector APIs used across roles.
// does not own: internal snapshot/energy/builder/remote/repair implementations.
// called by: role modules, BeeHiveMind, planners via require('BeeSelectors').

var RoomSnapshot = require('Selectors.RoomSnapshot');
var Energy = require('Selectors.Energy');
var Builder = require('Selectors.Builder');
var Remote = require('Selectors.RemoteSources');
var Repair = require('Selectors.Repair');

function buildSnapshot(room) {
  if (!room) return null;

  var snapshot = RoomSnapshot.buildSnapshot(room, Repair.computeRepairGoal);
  if (snapshot && snapshot.repairs) {
    snapshot.repairs.sort(Repair.byRepairUrgency);
  }
  return snapshot;
}

function selectClosestByRange(pos, list) {
  if (!pos || !list || !list.length) return null;

  var best = null;
  var bestRange = Infinity;
  for (var i = 0; i < list.length; i++) {
    var target = list[i];
    if (!target) continue;

    var range = pos.getRangeTo(target);
    if (range < bestRange) {
      bestRange = range;
      best = target;
    }
  }
  return best;
}

function prepareRoomSnapshot(room) { return buildSnapshot(room); }
function getRoomEnergyData(room) { return buildSnapshot(room); }
function findBestEnergyContainer(room) { return Energy.findBestEnergyContainer(buildSnapshot(room)); }
function findBestEnergyDrop(room) { return Energy.findBestEnergyDrop(buildSnapshot(room)); }
function getSourceContainerOrSite(source) { return Remote.getSourceContainerOrSite(source); }
function getRemoteSourcesSnapshot(homeRoomName) { return Remote.buildRemoteSourcesSnapshot(homeRoomName); }

function findRemoteSourceContainers(homeRoomName) {
  var list = Remote.buildRemoteSourcesSnapshot(homeRoomName);
  var out = [];

  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    if (!entry || !entry.container) continue;

    out.push({
      container: entry.container,
      source: entry.source || null,
      roomName: entry.roomName,
      energy: entry.containerEnergy,
      seatPos: entry.seatPos
    });
  }

  return out;
}

function pickBestHaulTarget(containers, homeRoomName) {
  if (!containers || !containers.length) return null;

  var best = null;
  var bestScore = -999999;

  for (var i = 0; i < containers.length; i++) {
    var entry = containers[i];
    if (!entry || !entry.container) continue;

    var energy = entry.energy;
    if (energy == null) {
      energy = (entry.container.store && entry.container.store[RESOURCE_ENERGY]) || 0;
    }

    var score = energy;
    if (homeRoomName && entry.roomName) {
      var distance = Game.map.getRoomLinearDistance(homeRoomName, entry.roomName, true);
      if (typeof distance === 'number' && distance > 0) {
        score -= distance * 25;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  return best;
}

function findTombstoneWithEnergy(room) {
  var snapshot = buildSnapshot(room);
  return (snapshot && snapshot.tombstones.length) ? snapshot.tombstones[0] : null;
}

function findRuinWithEnergy(room) {
  var snapshot = buildSnapshot(room);
  return (snapshot && snapshot.ruins.length) ? snapshot.ruins[0] : null;
}

function findTowersNeedingEnergy(room) { return Energy.findTowersNeedingEnergy(buildSnapshot(room)); }
function findSpawnLikeNeedingEnergy(room) { return Energy.findSpawnLikeNeedingEnergy(buildSnapshot(room)); }

function findStorageNeedingEnergy(room) {
  var snapshot = buildSnapshot(room);
  if (!snapshot || !snapshot.storage) return null;
  if (snapshot.storage.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return null;
  return snapshot.storage;
}

function getEnergySourcePriority(room) { return Energy.getEnergySourcePriority(buildSnapshot(room)); }

function findBestConstructionSite(room) {
  var snapshot = buildSnapshot(room);
  return (snapshot && snapshot.sites.length) ? snapshot.sites[0] : null;
}

function findBestRepairTarget(room) {
  var snapshot = buildSnapshot(room);
  return (snapshot && snapshot.repairs.length) ? snapshot.repairs[0] : null;
}

function reserveRepairTarget(room, reserverId) {
  if (!room) return null;

  Repair.resetReservationsIfNeeded();
  var snapshot = buildSnapshot(room);
  if (!snapshot || !snapshot.repairs.length) return null;

  var roomName = room.name;
  if (!global.__BHM.repairReservations[roomName]) {
    global.__BHM.repairReservations[roomName] = {};
  }

  var reservations = global.__BHM.repairReservations[roomName];
  for (var i = 0; i < snapshot.repairs.length; i++) {
    var repair = snapshot.repairs[i];
    if (!repair || !repair.target || reservations[repair.target.id]) continue;

    reservations[repair.target.id] = reserverId || 'anon';
    return repair;
  }

  return null;
}

function releaseRepairTarget(roomName, targetId) {
  if (!roomName || !targetId) return;

  Repair.resetReservationsIfNeeded();
  var byRoom = global.__BHM.repairReservations[roomName];
  if (byRoom && byRoom[targetId]) delete byRoom[targetId];
}

function findRoomAnchor(room) {
  var snapshot = buildSnapshot(room);
  return snapshot ? snapshot.anchor : null;
}

function findControllerLink(room) {
  var snapshot = buildSnapshot(room);
  return snapshot ? snapshot.controllerLink : null;
}

function findClosestByRange(origin, objects) {
  if (!origin || !objects || !objects.length) return null;

  var pos = origin.pos ? origin.pos : origin;
  if (!pos || pos.x == null) return null;

  var closest = null;
  var closestRange = 9999;

  for (var i = 0; i < objects.length; i++) {
    var obj = objects[i];
    if (!obj) continue;

    var targetPos = obj.pos ? obj.pos : obj;
    if (!targetPos || targetPos.x == null) continue;

    var range = pos.getRangeTo(targetPos);
    if (range < closestRange) {
      closestRange = range;
      closest = obj;
    }
  }

  return closest;
}

function findWithinRange(origin, objects, maxRange) {
  if (!origin || !objects || !objects.length) return [];

  var pos = origin.pos ? origin.pos : origin;
  if (!pos || pos.x == null) return [];

  var rangeLimit = (typeof maxRange === 'number') ? maxRange : 1;
  var matches = [];

  for (var i = 0; i < objects.length; i++) {
    var obj = objects[i];
    if (!obj) continue;

    var targetPos = obj.pos ? obj.pos : obj;
    if (!targetPos || targetPos.x == null) continue;

    if (pos.getRangeTo(targetPos) <= rangeLimit) {
      matches.push(obj);
    }
  }

  return matches;
}

module.exports = {
  prepareRoomSnapshot: prepareRoomSnapshot,
  getRoomEnergyData: getRoomEnergyData,
  findBestEnergyContainer: findBestEnergyContainer,
  findBestEnergyDrop: findBestEnergyDrop,
  getSourceContainerOrSite: getSourceContainerOrSite,
  getRemoteSourcesSnapshot: getRemoteSourcesSnapshot,
  findRemoteSourceContainers: findRemoteSourceContainers,
  pickBestHaulTarget: pickBestHaulTarget,
  findTombstoneWithEnergy: findTombstoneWithEnergy,
  findRuinWithEnergy: findRuinWithEnergy,
  findTowersNeedingEnergy: findTowersNeedingEnergy,
  findSpawnLikeNeedingEnergy: findSpawnLikeNeedingEnergy,
  findStorageNeedingEnergy: findStorageNeedingEnergy,
  getEnergySourcePriority: getEnergySourcePriority,
  selectClosestByRange: selectClosestByRange,
  findBestConstructionSite: findBestConstructionSite,
  classifyBuilderSiteBucket: Builder.classifyBuilderSiteBucket,
  scoreConstructionSiteForBuilder: Builder.scoreConstructionSiteForBuilder,
  selectBestConstructionSiteForBuilder: Builder.selectBestConstructionSiteForBuilder,
  findBestRepairTarget: findBestRepairTarget,
  reserveRepairTarget: reserveRepairTarget,
  releaseRepairTarget: releaseRepairTarget,
  findRoomAnchor: findRoomAnchor,
  findControllerLink: findControllerLink,
  findClosestByRange: findClosestByRange,
  findWithinRange: findWithinRange
};
