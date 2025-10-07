// Task.CombatMelee.js — Vanguard + bodyguard + squad anchor (ES5-safe)
// Traveler/TaskSquad movement + polite traffic + invader core handling
'use strict';

var BeeToolbox = require('BeeToolbox');
var TaskSquad  = require('Task.Squad');

var CONFIG = {
  focusSticky: 15,
  fleeHpPct: 0.35,
  towerAvoidRadius: 20,
  maxRooms: 2,
  reusePath: 10,
  maxOps: 2000,
  waitForMedic: false,
  doorBash: true,
  edgePenalty: 8
};

var CombatMelee = {
  run: function (creep) {
    if (creep.spawning) return;

    var squadId = (creep.memory && creep.memory.squadId) || 'Alpha';
    if (BeeToolbox && BeeToolbox.noteSquadPresence) {
      BeeToolbox.noteSquadPresence(creep);
    }

    var squadInfo = BeeToolbox && BeeToolbox.getSquadContext
      ? BeeToolbox.getSquadContext(squadId)
      : null;

    // (0) optional: wait for medic if the squad is still forming
    var mustWaitForMedic = CONFIG.waitForMedic;
    if (!mustWaitForMedic && squadInfo && squadInfo.waitForMedic) {
      mustWaitForMedic = true;
    }
    if (mustWaitForMedic && BeeToolbox && BeeToolbox.shouldWaitForMedic && BeeToolbox.shouldWaitForMedic(creep)) {
      var rf = (squadInfo && squadInfo.anchor) || Game.flags.Rally || Game.flags.MedicRally || TaskSquad.getAnchor(creep);
      if (rf) BeeToolbox.combatStepToward(creep, rf.pos || rf, 0, TaskSquad);
      return;
    }

    // (0.5) squad-level regroup when posture says hold (e.g. missing medic or bruised)
    if (squadInfo && squadInfo.needsRegroup) {
      var urgentThreats = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3);
      if (!urgentThreats || !urgentThreats.length) {
        var regroupPos = (squadInfo.anchor && squadInfo.anchor.pos) ? squadInfo.anchor.pos : squadInfo.anchor;
        if (!regroupPos) regroupPos = TaskSquad.getAnchor(creep);
        if (!regroupPos && Game.flags.Rally) regroupPos = Game.flags.Rally.pos;
        if (regroupPos) {
          BeeToolbox.combatStepToward(creep, regroupPos, 1, TaskSquad);
          BeeToolbox.combatAuxHeal(creep);
          return;
        }
      }
    }

    // quick self/buddy healing if we have HEAL
    BeeToolbox.combatAuxHeal(creep);

    // (1) emergency bail if low HP or in tower ring
    var lowHp = (creep.hits / creep.hitsMax) < CONFIG.fleeHpPct;
    if (lowHp || BeeToolbox.isInTowerDanger(creep.pos, CONFIG.towerAvoidRadius)) {
      BeeToolbox.combatRetreatToRally(creep, { taskSquad: TaskSquad, anchorProvider: TaskSquad.getAnchor, range: 1 });
      var adjBad = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1)[0];
      if (adjBad) creep.attack(adjBad);
      return;
    }

    // (2) bodyguard: interpose for squishy squadmates
    if (BeeToolbox.combatGuardSquadmate(creep, {
      taskSquad: TaskSquad,
      edgePenalty: CONFIG.edgePenalty,
      towerRadius: CONFIG.towerAvoidRadius
    })) {
      var hugger = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1)[0];
      if (hugger) creep.attack(hugger);
      return;
    }

    // (3) squad shared target
    var target = TaskSquad.sharedTarget(creep);
    if (target && BeeToolbox && BeeToolbox.setSquadFocus && (target.structureType || target.owner)) {
      BeeToolbox.setSquadFocus(squadId, target, 15);
    }
    if (!target) {
      var anc = (squadInfo && squadInfo.anchor) || TaskSquad.getAnchor(creep);
      if (anc) BeeToolbox.combatStepToward(creep, anc, 1, TaskSquad);
      return;
    }

    if (squadInfo && squadInfo.anchor && target.pos && target.pos.roomName === creep.pos.roomName) {
      var anchorPos = (squadInfo.anchor.pos || squadInfo.anchor);
      if (anchorPos && anchorPos.getRangeTo && anchorPos.getRangeTo(target.pos) > (squadInfo.chaseRange || 15)) {
        BeeToolbox.combatStepToward(creep, anchorPos, 1, TaskSquad);
        return;
      }
    }

    // (4) approach & strike
    if (creep.pos.isNearTo(target)) {
      // Explicit Invader Core handling: stand and swing
      if (target.structureType && target.structureType === STRUCTURE_INVADER_CORE) {
        creep.say('⚔ core!');
        creep.attack(target);
        return;
      }

      // Normal melee attack
      creep.attack(target);

      // Micro-step to a safer/better adjacent tile (avoid tower/edges/melee stacks)
      var better = BeeToolbox.combatBestAdjacentTile(creep, target, { edgePenalty: CONFIG.edgePenalty, towerRadius: CONFIG.towerAvoidRadius });
      if (better && (better.x !== creep.pos.x || better.y !== creep.pos.y)) {
        var dir = creep.pos.getDirectionTo(better);
        creep.move(dir);
      }
      return;
    }

    // (5) door bash if a blocking wall/rampart is the nearer path at range 1
    if (CONFIG.doorBash) {
      var blocker = BeeToolbox.combatBlockingDoor(creep, target);
      if (blocker && creep.pos.isNearTo(blocker)) {
        creep.attack(blocker);
        return;
      }
    }

    // (6) close in via Traveler-powered TaskSquad (polite traffic + swaps)
    BeeToolbox.combatStepToward(creep, target.pos, 1, TaskSquad);

    // opportunistic hit if we brushed into melee
    var adj = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1)[0];
    if (adj) creep.attack(adj);

    // (7) occasional opportunistic retarget to weaklings in 1..2
    if (Game.time % 3 === 0) {
      var weak = BeeToolbox.combatWeakestHostile(creep, 2);
      if (weak && (weak.hits / weak.hitsMax) < 0.5) target = weak;
    }
  },


  
};

module.exports = CombatMelee;
