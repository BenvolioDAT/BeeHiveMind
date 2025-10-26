// role.LinkManager.cpu.es5.js
// ES5-safe, CPU-lean link manager
// - Works per owned room (not per spawn)
// - Caches sender/receiver link IDs in Memory (rescan every N ticks or if invalid)
// - Sender: closest to storage (else spawn); Receiver: closest to controller
// - Ensures sender !== receiver, skips if low energy / no free capacity

'use strict';

var hasOwn = function (obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
};

var roleLinkManager = {
  run: function () {
    var RESCAN_INTERVAL = 500;   // how often to re-identify links per room
    var MIN_SEND = 100;          // don't bother sending tiny dribbles

    if (!Memory.rooms) Memory.rooms = {};

    // Iterate owned rooms
    for (var rn in Game.rooms) {
      if (!hasOwn(Game.rooms, rn)) continue;
      var room = Game.rooms[rn];
      if (!room.controller || !room.controller.my) continue;

      // mem bucket
      if (!Memory.rooms[rn]) Memory.rooms[rn] = {};
      var rmem = Memory.rooms[rn];
      if (!rmem.linkMgr) rmem.linkMgr = { senderId: null, receiverId: null, nextScan: 0 };

      // resolve from cache
      var sender = rmem.linkMgr.senderId ? Game.getObjectById(rmem.linkMgr.senderId) : null;
      var receiver = rmem.linkMgr.receiverId ? Game.getObjectById(rmem.linkMgr.receiverId) : null;

      // time to scan or cache invalid -> rescan links in this room
      if (!sender || !receiver || Game.time >= (rmem.linkMgr.nextScan | 0)) {
        var links = room.find(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_LINK } });
        if (!links.length) { rmem.linkMgr.senderId = null; rmem.linkMgr.receiverId = null; rmem.linkMgr.nextScan = Game.time + RESCAN_INTERVAL; continue; }

        // anchors
        var anchorSend = room.storage || (room.find(FIND_MY_SPAWNS)[0] || null);
        var anchorRecv = room.controller || null;

        // pick sender: closest to storage/spawn
        var bestS = null, bestSd = 1e9;
        if (anchorSend) {
          for (var i = 0; i < links.length; i++) {
            var L = links[i];
            var d = anchorSend.pos.getRangeTo(L.pos);
            if (d < bestSd) { bestSd = d; bestS = L; }
          }
        }

        // pick receiver: closest to controller
        var bestR = null, bestRd = 1e9, secondR = null, secondRd = 1e9;
        if (anchorRecv) {
          for (var j = 0; j < links.length; j++) {
            var L2 = links[j];
            var d2 = anchorRecv.pos.getRangeTo(L2.pos);
            if (d2 < bestRd) { secondR = bestR; secondRd = bestRd; bestRd = d2; bestR = L2; }
            else if (d2 < secondRd) { secondRd = d2; secondR = L2; }
          }
        }

        // ensure distinct sender/receiver
        if (bestS && bestR && bestS.id === bestR.id && secondR) bestR = secondR;

        // commit (may still be null if anchors missing)
        rmem.linkMgr.senderId  = bestS ? bestS.id : null;
        rmem.linkMgr.receiverId = bestR ? bestR.id : null;
        rmem.linkMgr.nextScan = Game.time + RESCAN_INTERVAL;

        sender = bestS; receiver = bestR;
      }

      // nothing to do if either is missing
      if (!sender || !receiver) continue;

      // Skip if same (paranoia)
      if (sender.id === receiver.id) continue;

      var used = (sender.store && sender.store[RESOURCE_ENERGY]) | 0;
      var free = (receiver.store && receiver.store.getFreeCapacity) ? receiver.store.getFreeCapacity(RESOURCE_ENERGY) : 0;

      // Ready to send?
      if (sender.cooldown === 0 && used >= MIN_SEND && free > 0) {
        // optionally cap amount, but default sends optimal amount automatically
        sender.transferEnergy(receiver);
      }
    }
  }
};

module.exports = roleLinkManager;
