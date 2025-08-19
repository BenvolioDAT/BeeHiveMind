var BeeToolbox = require('BeeToolbox');
var roleSiege_Bee = {
  /*run: function(creep) {
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
};*/
run: function(creep) {
    if (creep.spawning) return;

    // Optional “wait 1 tick behind decoy”
    if (creep.memory.delay && Game.time < creep.memory.delay) return;

    // Reuse target if still valid
    let target = Game.getObjectById(creep.memory.tid);

    // Helper: first valid item by path from a list
    const byPath = (arr) => arr.length ? creep.pos.findClosestByPath(arr) : null;

    // A: pick target if none
    if (!target) {
      // Highest priority: towers → spawns → everything else hostile and destructible
      const towers = creep.room.find(FIND_HOSTILE_STRUCTURES, { filter: s => s.structureType === STRUCTURE_EXTENSION });
      const spawns = creep.room.find(FIND_HOSTILE_SPAWNS);
      const others = creep.room.find(FIND_HOSTILE_STRUCTURES, {
        filter: s =>
          s.hits !== undefined &&
          s.structureType !== STRUCTURE_CONTROLLER &&
          s.structureType !== STRUCTURE_ROAD &&
          s.structureType !== STRUCTURE_CONTAINER &&
          s.structureType !== STRUCTURE_EXTENSION &&
          s.structureType !== STRUCTURE_LINK &&
          s.structureType !== STRUCTURE_TOWER &&
          s.structureType !== STRUCTURE_SPAWN
      });

      // Prefer towers, then spawns, then anything else
      target = byPath(towers) || byPath(spawns) || byPath(others);

      // If path to target is blocked by a wall/rampart, hit the blocker first
      if (target) {
        const path = creep.room.findPath(creep.pos, target.pos, { maxOps: 500, ignoreCreeps: true });
        for (const step of path) {
          const blocker = creep.room.lookForAt(LOOK_STRUCTURES, step.x, step.y)
            .find(l => l.structure &&
              (l.structure.structureType === STRUCTURE_WALL ||
               (l.structure.structureType === STRUCTURE_RAMPART && !l.structure.my)));
          if (blocker) { target = blocker.structure; break; }
        }
        creep.memory.tid = target.id;
      }
    }

    // B: execute
    if (target) {
      if (creep.pos.isNearTo(target)) {
        creep.dismantle(target);
        // Retarget sooner as it gets low to avoid idle ticks
        if (target.hits && target.hits <= 1000) delete creep.memory.tid;
      } else {
        creep.moveTo(target, { reusePath: 10, maxRooms: 1 });
      }
    } else {
      // Fail-safe rally
      const rally = Game.flags.Wait || Game.flags.Attack;
      if (rally) creep.moveTo(rally);
    }
  }
};
module.exports = roleSiege_Bee;
