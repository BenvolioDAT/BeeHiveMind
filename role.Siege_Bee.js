var BeeToolbox = require('BeeToolbox');
var roleSiege_Bee = {
  run: function(creep) {
    if (creep.spawning) return;
    // 🎯 Define filter inside run() so creep is in scope
    function isValidSiegeTarget(s) {
      return s.structureType !== STRUCTURE_CONTROLLER &&
             s.structureType !== STRUCTURE_WALL &&
             s.structureType !== STRUCTURE_RAMPART &&
             s.structureType !== STRUCTURE_ROAD && 
             s.structureType !== STRUCTURE_CONTAINER &&
             s.structureType !== STRUCTURE_EXTENSION &&
             s.structureType !== STRUCTURE_LINK &&
             s.hits !== undefined &&
             (!s.owner || s.owner.username !== creep.owner.username);
    }
    // 🎯 Find primary enemy structure
    var primaryTarget = creep.pos.findClosestByPath(FIND_STRUCTURES, {
      filter: isValidSiegeTarget
    });
    // 🚪 Check path for walls/ramparts blocking the way
    var barrier = null;
    if (primaryTarget) {
      var path = creep.room.findPath(creep.pos, primaryTarget.pos, { maxOps: 500, ignoreCreeps: true });
      for (var i = 0; i < path.length; i++) {
        var step = path[i];
        var look = creep.room.lookAt(step.x, step.y);
        var blocker = look.find(function(l) {
          return l.structure &&
            (l.structure.structureType === STRUCTURE_WALL ||
             (l.structure.structureType === STRUCTURE_RAMPART &&
              (!l.structure.owner || l.structure.owner.username !== creep.owner.username)));
        });
        if (blocker) {
          barrier = blocker.structure;
          break;
        }
      }
    }
    var target = barrier || primaryTarget;
    if (target) {
      if (creep.pos.isNearTo(target)) {
        creep.dismantle(target);
        creep.say('💥 Smash');
      } else {
        creep.moveTo(target);
      }
    } else {
      var rallyFlag = Game.flags.Rally;
      if (rallyFlag) creep.moveTo(rallyFlag);
    }
  }
};
module.exports = roleSiege_Bee;
