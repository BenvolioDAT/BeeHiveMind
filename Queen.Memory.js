'use strict';

function ensureQueenIdentity(creep) {
  if (!creep || !creep.memory) return;
  creep.memory.role = 'Queen';
  if (!creep.memory.task) creep.memory.task = 'queen';
}

function ensureTaskSlot(creep) {
  if (!creep || !creep.memory) return;
  if (!creep.memory._task) creep.memory._task = null;
}

function setTask(creep, task) {
  if (!creep || !creep.memory) return;
  creep.memory._task = task;
}

function clearTask(creep, releaseTerminalJobClaimIfHeld) {
  if (typeof releaseTerminalJobClaimIfHeld === 'function') releaseTerminalJobClaimIfHeld(creep);
  if (!creep || !creep.memory) return;
  creep.memory._task = null;
}

module.exports = { ensureQueenIdentity: ensureQueenIdentity, ensureTaskSlot: ensureTaskSlot, setTask: setTask, clearTask: clearTask };
