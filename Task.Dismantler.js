// Task.Dismantler.js — siege with Invader Core handling (ES5-safe)
'use strict';

var BeeToolbox = require('BeeToolbox');
var TaskSquad  = require('Task.Squad');

var TaskDismantler = {
  run: function (creep) {
    if (creep.spawning) return;

    var squadId = (creep.memory && creep.memory.squadId) || 'Alpha';
    if (BeeToolbox && BeeToolbox.noteSquadPresence) {
      BeeToolbox.noteSquadPresence(creep);
    }
    var squadInfo = BeeToolbox && BeeToolbox.getSquadContext
      ? BeeToolbox.getSquadContext(squadId)
      : null;

    // Optional “wait behind decoy” start delay
    if (creep.memory.delay && Game.time < creep.memory.delay) return;

    var target = Game.getObjectById(creep.memory.tid);
    if (!target && BeeToolbox && BeeToolbox.getSquadFocus) {
      target = BeeToolbox.getSquadFocus(squadId);
      if (target) creep.memory.tid = target.id;
    }

    if (squadInfo && squadInfo.needsRegroup && (!target || squadInfo.waitForMedic)) {
      var regroup = (squadInfo.anchor && squadInfo.anchor.pos) ? squadInfo.anchor.pos : squadInfo.anchor;
      if (!regroup) regroup = TaskSquad.getAnchor(creep);
      if (!regroup && Game.flags.Rally) regroup = Game.flags.Rally.pos;
      if (regroup) {
        BeeToolbox.combatStepToward(creep, regroup, 1, TaskSquad);
        return;
      }
    }

    // Small helper: pathable closest-by-path from a list
    function closest(arr) { return (arr && arr.length) ? creep.pos.findClosestByPath(arr) : null; }

    // -------- A) Acquire target --------
    if (!target) {
      // 1) High-priority threats first
      var towers = creep.room.find(FIND_HOSTILE_STRUCTURES, {
        filter: function (s) { return s.structureType === STRUCTURE_TOWER; }
      });
      var spawns = creep.room.find(FIND_HOSTILE_SPAWNS);

      // 2) Explicitly include Invader Cores
      var cores = creep.room.find(FIND_HOSTILE_STRUCTURES, {
        filter: function (s) { return s.structureType === STRUCTURE_INVADER_CORE; }
      });

      // 3) Everything else that’s dismantle-worthy
      var others = creep.room.find(FIND_HOSTILE_STRUCTURES, {
        filter: function (s) {
          if (s.hits === undefined) return false;
          // exclude types we don't want to waste time dismantling
          if (s.structureType === STRUCTURE_CONTROLLER) return false;
          if (s.structureType === STRUCTURE_ROAD)        return false;
          if (s.structureType === STRUCTURE_CONTAINER)   return false;
          if (s.structureType === STRUCTURE_EXTENSION)   return false;
          if (s.structureType === STRUCTURE_LINK)        return false;
          if (s.structureType === STRUCTURE_TOWER)       return false;
          if (s.structureType === STRUCTURE_SPAWN)       return false;
          if (s.structureType === STRUCTURE_INVADER_CORE) return false; // handled separately
          return true;
        }
      });

      // Priority: towers → spawns → cores → others
      target = closest(towers) || closest(spawns) || closest(cores) || closest(others);

      // If the path is blocked, hit the first blocking wall/rampart
      if (target) {
        var path = creep.room.findPath(creep.pos, target.pos, { maxOps: 500, ignoreCreeps: true });
        for (var i = 0; i < path.length; i++) {
          var step = path[i];
          var structs = creep.room.lookForAt(LOOK_STRUCTURES, step.x, step.y);
          for (var j = 0; j < structs.length; j++) {
            var st = structs[j];
            if (st && st.structureType) {
              if (st.structureType === STRUCTURE_WALL) { target = st; break; }
              if (st.structureType === STRUCTURE_RAMPART && !st.my) { target = st; break; }
            }
          }
          if (target.id === (st && st.id)) break;
        }
        creep.memory.tid = target.id;
        if (BeeToolbox && BeeToolbox.setSquadFocus) {
          BeeToolbox.setSquadFocus(squadId, target, 25);
        }
      }
    }

    // -------- B) Execute action --------
    if (target) {
      var inMelee = creep.pos.isNearTo(target);
      var range = creep.pos.getRangeTo(target);

      if (squadInfo && squadInfo.anchor && target.pos && target.pos.roomName === creep.pos.roomName) {
        var anchorPos = (squadInfo.anchor.pos || squadInfo.anchor);
        if (anchorPos && anchorPos.getRangeTo && anchorPos.getRangeTo(target.pos) > (squadInfo.chaseRange || 15)) {
          BeeToolbox.combatStepToward(creep, anchorPos, 1, TaskSquad);
          return;
        }
      }

      // Special case: Invader Core must be attacked (not dismantled)
      if (target.structureType === STRUCTURE_INVADER_CORE) {
        // Try ranged if we have it and are in range 3
        if (range <= 3 && creep.getActiveBodyparts(RANGED_ATTACK) > 0) {
          creep.rangedAttack(target);
        }
        // Close in to melee and attack if possible
        if (inMelee && creep.getActiveBodyparts(ATTACK) > 0) {
          creep.attack(target);
        }
        if (!inMelee) {
          BeeToolbox.combatStepToward(creep, target.pos, 1, TaskSquad);
        }
        // If we have no ATTACK parts at all, keep ID so escorts can kill it,
        // or you can spawn a proper smasher for cores.
        return;
      }

      // Normal hostile structure: dismantle is most efficient
      if (inMelee) {
        var rc = creep.dismantle(target);
        // If dismantle is invalid for any reason, try attack as a fallback
        if (rc === ERR_INVALID_TARGET) {
          if (creep.getActiveBodyparts(ATTACK) > 0) creep.attack(target);
        }
        // Retarget early when low hits to avoid idle ticks on empty swings
        if (target.hits && target.hits <= 1000) delete creep.memory.tid;
      } else {
        BeeToolbox.combatStepToward(creep, target.pos, 1, TaskSquad);
      }
    } else {
      // No targets: rally
      var rally = (squadInfo && squadInfo.anchor) || Game.flags.Rally || Game.flags.Attack;
      if (rally) BeeToolbox.combatStepToward(creep, rally.pos || rally, 1, TaskSquad);
    }
  }
};

module.exports = TaskDismantler;
