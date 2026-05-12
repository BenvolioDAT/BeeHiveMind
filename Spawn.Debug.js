'use strict';
// Spawn.Debug.js
// Owns: spawn debug memory initialization helpers.
// Must not own: quota/count/gating logic.
// Called by: BeeSpawnManager.

function ensureSpawnDebug(roomName) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  if (!Memory.rooms[roomName].spawnDebug) Memory.rooms[roomName].spawnDebug = {};
  return Memory.rooms[roomName].spawnDebug;
}

module.exports = { ensureSpawnDebug: ensureSpawnDebug };
