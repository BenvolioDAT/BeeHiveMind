
var roleLinkManager = {
  run: function () {
    ensureRoomMemory();
    for (var rn in Game.rooms) {
      if (!Game.rooms.hasOwnProperty(rn)) continue;
      var room = Game.rooms[rn];
      if (!room.controller || !room.controller.my) continue;

      var rmem = ensureLinkMemory(rn);
      var pair = resolveLinkPair(room, rmem);
      if (!pair.sender || !pair.receiver) continue;
      if (pair.sender.id === pair.receiver.id) continue;

      trySendEnergy(pair.sender, pair.receiver);
    }
  }
};

module.exports = roleLinkManager;

// -----------------------------
// Teaching helpers (flattened)
// -----------------------------
var RESCAN_INTERVAL = 500;
var MIN_SEND = 100;

function ensureRoomMemory() {
  if (!Memory.rooms) Memory.rooms = {};
}

function ensureLinkMemory(roomName) {
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  if (!Memory.rooms[roomName].linkMgr) {
    Memory.rooms[roomName].linkMgr = { senderId: null, receiverId: null, nextScan: 0 };
  }
  return Memory.rooms[roomName];
}

function resolveLinkPair(room, rmem) {
  var cache = rmem.linkMgr;
  var sender = cache.senderId ? Game.getObjectById(cache.senderId) : null;
  var receiver = cache.receiverId ? Game.getObjectById(cache.receiverId) : null;

  if (needsRescan(cache, sender, receiver)) {
    var result = scanRoomForLinks(room);
    cache.senderId = result.sender ? result.sender.id : null;
    cache.receiverId = result.receiver ? result.receiver.id : null;
    cache.nextScan = result.nextScan;
    sender = result.sender;
    receiver = result.receiver;
  }

  return { sender: sender, receiver: receiver };
}

function needsRescan(cache, sender, receiver) {
  if (!sender || !receiver) return true;
  return Game.time >= (cache.nextScan | 0);
}

function scanRoomForLinks(room) {
  var links = room.find(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_LINK } });
  if (!links.length) {
    return { sender: null, receiver: null, nextScan: Game.time + RESCAN_INTERVAL };
  }

  var anchorSend = room.storage || (room.find(FIND_MY_SPAWNS)[0] || null);
  var anchorRecv = room.controller || null;

  var sender = pickClosestLink(anchorSend, links);
  var receiverData = pickControllerLinks(anchorRecv, links);
  var receiver = receiverData.primary;
  if (sender && receiver && sender.id === receiver.id && receiverData.secondary) {
    receiver = receiverData.secondary;
  }

  return {
    sender: sender,
    receiver: receiver,
    nextScan: Game.time + RESCAN_INTERVAL
  };
}

function pickClosestLink(anchor, links) {
  if (!anchor) return null;
  var best = null;
  var bestRange = Infinity;
  for (var i = 0; i < links.length; i++) {
    var link = links[i];
    var range = anchor.pos.getRangeTo(link.pos);
    if (range < bestRange) {
      bestRange = range;
      best = link;
    }
  }
  return best;
}

function pickControllerLinks(anchor, links) {
  if (!anchor) return { primary: null, secondary: null };
  var primary = null;
  var secondary = null;
  var best = Infinity;
  var second = Infinity;
  for (var i = 0; i < links.length; i++) {
    var link = links[i];
    var range = anchor.pos.getRangeTo(link.pos);
    if (range < best) {
      second = best;
      secondary = primary;
      best = range;
      primary = link;
    } else if (range < second) {
      second = range;
      secondary = link;
    }
  }
  return { primary: primary, secondary: secondary };
}

function trySendEnergy(sender, receiver) {
  var used = (sender.store && sender.store[RESOURCE_ENERGY]) | 0;
  var free = (receiver.store && receiver.store.getFreeCapacity)
    ? receiver.store.getFreeCapacity(RESOURCE_ENERGY)
    : 0;
  if (sender.cooldown !== 0) return;
  if (used < MIN_SEND) return;
  if (free <= 0) return;
  sender.transferEnergy(receiver);
}
