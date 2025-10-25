'use strict';

/**
 * Task.BaseHarvest assigns miners to fixed seats and maintains source containers.
 * All logic is ES5-compatible to match team conventions (no const/let, arrow
 * functions, or template literals). Movement always relies on Traveler
 * (creep.travelTo) through BeeToolbox helpers so that path reuse stays unified.
 */

var Logger = require('core.logger');
var BeeToolbox = require('BeeToolbox');

var LOG_LEVEL = Logger.LOG_LEVEL;
var harvestLog = Logger.createLogger('Task.BaseHarvest', LOG_LEVEL.DEBUG);

var HARVEST_RANGE = 1;
var REASSIGN_INTERVAL = 50;
var CONTAINER_REPAIR_THRESHOLD = 0.5;
var REPAIR_POWER_PER_WORK = 100;

/**
 * ensureAssignment resolves or acquires a source seat for the creep.
 * Input: creep (Creep).
 * Output: assignment info (object) or null when no source is available.
 * Side-effects: may update creep memory when a new source is selected.
 * Reasoning: centralizes seat acquisition and reuse across ticks.
 */
function ensureAssignment(creep) {
  var assignment = BeeToolbox.getHarvestAssignmentInfo(creep);
  if (assignment && assignment.source) {
    return assignment;
  }
  assignment = BeeToolbox.assignHarvestSource(creep);
  if (!assignment || !assignment.source) {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      harvestLog.debug('No source assignment found for', creep.name);
    }
    return null;
  }
  return assignment;
}

/**
 * shouldReassign decides whether the creep should attempt to find a new source.
 * Input: creep (Creep), assignment (object from ensureAssignment).
 * Output: boolean.
 * Side-effects: none.
 * Reasoning: prevents miners from standing idle if their source disappears.
 */
function shouldReassign(creep, assignment) {
  if (!assignment || !assignment.source) {
    return true;
  }
  if (Game.time % REASSIGN_INTERVAL !== 0) {
    return false;
  }
  if (!assignment.source.room) {
    return false;
  }
  if (assignment.source.energy > 0) {
    return false;
  }
  if (assignment.source.ticksToRegeneration && assignment.source.ticksToRegeneration > 30) {
    return true;
  }
  return false;
}

/**
 * moveToSeat positions the creep on the reserved seat position.
 * Input: creep (Creep), assignment (object).
 * Output: true when movement was issued.
 * Side-effects: issues movement intent via BeeToolbox.travelTo (https://docs.screeps.com/api/#Creep.move).
 * Reasoning: keeps miners seated on optimal tiles, enabling container usage.
 */
function moveToSeat(creep, assignment) {
  if (!assignment || !assignment.seatPos) {
    return false;
  }
  if (creep.pos.isEqualTo(assignment.seatPos)) {
    return false;
  }
  BeeToolbox.rememberSeatPosition(creep, assignment.seatPos);
  BeeToolbox.travelTo(creep, assignment.seatPos, { range: 0, reusePath: 25 });
  return true;
}

/**
 * maintainContainer builds or repairs the container below the harvester.
 * Input: creep (Creep), assignment (object).
 * Output: none.
 * Side-effects: may build or repair using Creep APIs (https://docs.screeps.com/api/#Creep.build / repair).
 * Reasoning: ensures the economic pipeline keeps working without manual babysitting.
 */
function maintainContainer(creep, assignment) {
  if (!assignment || !assignment.seatPos) {
    return;
  }
  BeeToolbox.ensureSourceContainer(creep, assignment);
  if (!assignment.container) {
    return;
  }
  if (!creep.pos.isEqualTo(assignment.seatPos)) {
    return;
  }
  if (!assignment.container.hits || !assignment.container.hitsMax) {
    return;
  }
  var hitsRatio = assignment.container.hits / assignment.container.hitsMax;
  if (hitsRatio >= CONTAINER_REPAIR_THRESHOLD) {
    return;
  }
  if (!creep.store || (creep.store[RESOURCE_ENERGY] | 0) < REPAIR_POWER_PER_WORK) {
    return;
  }
  creep.repair(assignment.container);
}

/**
 * handleEnergyOverflow deposits or drops energy when the creep cannot harvest more.
 * Input: creep (Creep), assignment (object).
 * Output: none.
 * Side-effects: may transfer to container or drop energy on ground (https://docs.screeps.com/api/#Creep.transfer).
 * Reasoning: avoids wasted work parts when the container is full.
 */
function handleEnergyOverflow(creep, assignment) {
  if (!creep.store) {
    return;
  }
  var carried = creep.store[RESOURCE_ENERGY] | 0;
  if (carried <= 0) {
    return;
  }
  if (assignment && assignment.container && assignment.container.store) {
    var free = assignment.container.store.getFreeCapacity(RESOURCE_ENERGY) | 0;
    if (free > 0) {
      creep.transfer(assignment.container, RESOURCE_ENERGY);
      return;
    }
  }
  if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    creep.drop(RESOURCE_ENERGY);
  }
}

/**
 * run executes the harvester behaviour each tick.
 * Input: creep (Creep).
 * Output: none.
 * Side-effects: harvests energy, builds/repairs containers, issues movement intents.
 */
function runBaseHarvest(creep) {
  if (!creep) {
    return;
  }
  if (creep.memory && creep.memory.task !== 'baseharvest') {
    creep.memory.task = 'baseharvest';
  }

  var assignment = ensureAssignment(creep);
  if (!assignment) {
    BeeToolbox.releaseHarvestAssignment(creep);
    creep.say('NoSrc');
    return;
  }

  if (shouldReassign(creep, assignment)) {
    BeeToolbox.releaseHarvestAssignment(creep);
    assignment = ensureAssignment(creep);
    if (!assignment) {
      creep.say('NoSrc');
      return;
    }
  }

  if (moveToSeat(creep, assignment)) {
    return;
  }

  maintainContainer(creep, assignment);

  var source = assignment.source;
  if (!source) {
    BeeToolbox.releaseHarvestAssignment(creep);
    return;
  }

  var result = creep.harvest(source);
  if (result === ERR_NOT_IN_RANGE) {
    BeeToolbox.travelTo(creep, source.pos, { range: HARVEST_RANGE, reusePath: 15 });
    return;
  }

  handleEnergyOverflow(creep, assignment);
}

module.exports = {
  run: runBaseHarvest
};
