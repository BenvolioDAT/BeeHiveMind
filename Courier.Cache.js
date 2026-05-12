'use strict';

if (!global.__COURIER) global.__COURIER = { tick: -1, rooms: {} };

function getCourierRoomCache(room) {
  var courierGlobalCache = global.__COURIER;
  if (courierGlobalCache.tick !== Game.time) {
    courierGlobalCache.tick = Game.time;
    courierGlobalCache.rooms = {};
  }
  var roomCache = courierGlobalCache.rooms[room.name];
  if (roomCache) return roomCache;

  var containers = room.find(FIND_STRUCTURES, {
    filter: function (structure) { return structure.structureType === STRUCTURE_CONTAINER; }
  });

  var sourceContainerIds = [];
  var otherContainerIds = [];
  var bestSourceContainerId = null;
  var bestSourceContainerEnergy = -1;

  for (var i = 0; i < containers.length; i++) {
    var container = containers[i];
    var isSourceContainer = container.pos.findInRange(FIND_SOURCES, 1).length > 0;
    var energy = (container.store && container.store[RESOURCE_ENERGY]) || 0;

    if (isSourceContainer) {
      sourceContainerIds.push(container.id);
      if (energy > bestSourceContainerEnergy) {
        bestSourceContainerEnergy = energy;
        bestSourceContainerId = container.id;
      }
    } else {
      otherContainerIds.push(container.id);
    }
  }

  roomCache = {
    srcIds: sourceContainerIds,
    otherIds: otherContainerIds,
    bestSrcId: bestSourceContainerId,
    bestSrcEnergy: bestSourceContainerEnergy,
    nextGraveScanAt: Game.time + 1,
    graves: []
  };
  courierGlobalCache.rooms[room.name] = roomCache;
  return roomCache;
}

function getCourierObjectsFromIds(ids) {
  var result = [];
  for (var i = 0; i < ids.length; i++) {
    var object = Game.getObjectById(ids[i]);
    if (object) result.push(object);
  }
  return result;
}

module.exports = {
  getCourierRoomCache: getCourierRoomCache,
  getCourierObjectsFromIds: getCourierObjectsFromIds
};
