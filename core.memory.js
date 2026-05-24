'use strict';

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function makeValue(factory) {
  return typeof factory === 'function' ? factory() : {};
}

function ensureChild(parent, key, factory) {
  if (!parent || !key) return null;
  if (!isObject(parent[key])) parent[key] = makeValue(factory);
  return parent[key];
}

function ensureMemoryRoot(key, factory) {
  return ensureChild(Memory, key, factory);
}

function ensureBhmRoot(key, factory) {
  if (!isObject(Memory.__BHM)) Memory.__BHM = {};
  if (!key) return Memory.__BHM;
  return ensureChild(Memory.__BHM, key, factory);
}

function ensureRoom(roomName) {
  if (!roomName) return null;
  var rooms = ensureMemoryRoot('rooms');
  return ensureChild(rooms, roomName);
}

function ensureRoomChild(roomName, key, factory) {
  var roomMem = ensureRoom(roomName);
  return ensureChild(roomMem, key, factory);
}

module.exports = {
  ensureChild: ensureChild,
  ensureMemoryRoot: ensureMemoryRoot,
  ensureBhmRoot: ensureBhmRoot,
  ensureRoom: ensureRoom,
  ensureRoomChild: ensureRoomChild
};
