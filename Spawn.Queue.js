'use strict';
// Spawn.Queue.js
// Owns: room spawn queue creation and queue counting utilities.
// Must not own: quota policy or role arbitration decisions.
// Called by: BeeSpawnManager.

function ensureRoomQueue(roomName) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  if (!Array.isArray(Memory.rooms[roomName].spawnQueue)) Memory.rooms[roomName].spawnQueue = [];
  return Memory.rooms[roomName].spawnQueue;
}

function queuedCount(roomName, role) {
  var q = ensureRoomQueue(roomName);
  var count = 0;
  for (var i = 0; i < q.length; i++) {
    if (q[i] && q[i].role === role) count++;
  }
  return count;
}

module.exports = { ensureRoomQueue: ensureRoomQueue, queuedCount: queuedCount };
