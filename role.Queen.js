'use strict';

// role.Queen.js
// Owns: top-level Queen orchestration.
// Does not own: terminal job internals, reservation math, task selection internals, action implementations.
// Called by: main role runner via require('role.Queen').

var QueenConfig = require('Queen.Config');
var QueenMemory = require('Queen.Memory');
var QueenTerminalJob = require('Queen.TerminalJob');
var QueenTasks = require('Queen.Tasks');
var QueenActions = require('Queen.Actions');

var QUEEN_STATE = QueenConfig.QUEEN_STATE;

function determineQueenState(creep) {
  QueenMemory.ensureQueenIdentity(creep);
  var terminalJob = QueenTerminalJob.getRoomTerminalEnergyJob(creep.room);
  var task = QueenTasks.ensureActiveTask(
    creep,
    terminalJob,
    QueenTerminalJob.logTerminalJob,
    QueenTerminalJob.releaseTerminalJobClaimIfHeld
  );
  var state = (task && task.type) ? String(task.type).toUpperCase() : QUEEN_STATE.IDLE;
  creep.memory.state = state;
  return state;
}

function clearQueenTask(creep) {
  QueenMemory.clearTask(creep, QueenTerminalJob.releaseTerminalJobClaimIfHeld);
}

var roleQueen = {
  role: 'Queen',
  run: function (creep) {
    if (!creep || creep.spawning) return;

    // Beginner flow:
    // 1) ensure identity
    // 2) update terminal job lifecycle
    // 3) select or refresh active task
    // 4) run active state handler
    QueenMemory.ensureQueenIdentity(creep);
    QueenTerminalJob.updateTerminalEnergyJob(creep.room);
    var state = determineQueenState(creep);

    if (state === QUEEN_STATE.WITHDRAW) {
      QueenActions.runQueenWithdrawState(creep, clearQueenTask);
      return;
    }
    if (state === QUEEN_STATE.PICKUP) {
      QueenActions.runQueenPickupState(creep, clearQueenTask);
      return;
    }
    if (state === QUEEN_STATE.DELIVER) {
      QueenActions.runQueenDeliverState(creep, clearQueenTask, QueenTerminalJob.releaseTerminalJobClaimIfHeld);
      return;
    }
    QueenActions.runQueenIdleState(creep);
  }
};

module.exports = roleQueen;
