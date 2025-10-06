'use strict';

// Logging Levels
var LOG_LEVEL = { NONE: 0, BASIC: 1, DEBUG: 2 };
//if (currentLogLevel >= LOG_LEVEL.DEBUG) {}
var currentLogLevel = LOG_LEVEL.NONE;  // Adjust to LOG_LEVEL.DEBUG for more detailed logs

var TaskRepair = {
  run: function (creep) {
    if (!creep || !creep.room) return;

    var room = creep.room;
    var roomName = room.name;
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
    var roomMemory = Memory.rooms[roomName];
    if (!Array.isArray(roomMemory.repairTargets)) {
      roomMemory.repairTargets = [];
    }
    var repairTargets = roomMemory.repairTargets;

    if (creep.store[RESOURCE_ENERGY] > 0) {
      if (repairTargets.length > 0) {
        var targetData = repairTargets[0];
        var target = targetData ? Game.getObjectById(targetData.id) : null;
        if (target) {
          if (currentLogLevel >= LOG_LEVEL.DEBUG) {
            console.log('Creep ' + creep.name + ' is repairing ' + target.structureType + ' at (' + target.pos.x + ', ' + target.pos.y + ')');
            //creep.say('🔧 R');
          }

          var visual = room.visual;
          if (visual) {
            visual.text(
              'Repairing ' + target.structureType,
              target.pos.x,
              target.pos.y - 1,
              { align: 'center', color: 'white' }
            );
            visual.circle(target.pos, { radius: 0.5, fill: 'transparent', stroke: 'teal' });
          }

          var repairResult = creep.repair(target);
          if (repairResult === OK) {
            if (target.hits >= target.hitsMax) {
              repairTargets.shift();
            }
          } else if (repairResult === ERR_NOT_IN_RANGE) {
            creep.moveTo(target);
          } else if (currentLogLevel >= LOG_LEVEL.DEBUG) {
            console.log('Repair error: ' + repairResult);
          }
        } else {
          repairTargets.shift();
        }
      } else {
        creep.memory.task = undefined;
      }
      return;
    }

    var energyOnGround = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
      filter: function (resource) {
        return resource.resourceType === RESOURCE_ENERGY;
      }
    });
    if (energyOnGround) {
      if (creep.pickup(energyOnGround) === ERR_NOT_IN_RANGE) {
        creep.moveTo(energyOnGround);
      }
      return;
    }

    var energySource = creep.pos.findClosestByPath(FIND_STRUCTURES, {
      filter: function (structure) {
        return (
          (structure.structureType === STRUCTURE_CONTAINER ||
           structure.structureType === STRUCTURE_EXTENSION ||
           structure.structureType === STRUCTURE_SPAWN) &&
          structure.store[RESOURCE_ENERGY] > 0
        );
      }
    });
    if (energySource) {
      if (creep.withdraw(energySource, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        creep.moveTo(energySource);
      }
    } else if (currentLogLevel >= LOG_LEVEL.DEBUG) {
      console.log('No available energy source');
    }
  }
};

module.exports = TaskRepair;
