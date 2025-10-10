// Task.CombatArcher.js — Stoic archer (no dancing) + DPS-first + safe kiting (ES5-safe)
'use strict';

var BeeToolbox = require('BeeToolbox');
var TaskSquad  = require('./Task.Squad');

var CONFIG = {
  desiredRange: 2,          // ideal standoff distance
  kiteIfAtOrBelow: 2,       // if target ≤ this range, back off
  approachSlack: 1,         // hysteresis: only advance if range > desiredRange + this
  holdBand: 1,              // hysteresis: OK to hold if range in [desiredRange, desiredRange+holdBand]
  shuffleCooldown: 2,       // ticks to wait after any move before moving again
  fleeHpPct: 0.40,
  focusSticky: 15,
  maxRooms: 10,
  reusePath: 10,
  maxOps: 2000,
  towerAvoidRadius: 20,
  waitForMedic: true
};

var TaskCombatArcher = {
  run: function (creep) {
    if (creep.spawning) return;

    creep.memory = creep.memory || {};
    var mem = creep.memory;
    if (!mem.state) mem.state = 'rally';
    var squadId = mem.squadId || TaskSquad.getSquadId(creep);
    var squadRole = mem.squadRole || mem.task || 'CombatArcher';
    var rallyPos = TaskSquad.getRallyPos(squadId) || (Game.flags.Rally && Game.flags.Rally.pos) || null;
    TaskSquad.registerMember(squadId, creep.name, squadRole, {
      creep: creep,
      rallyPos: rallyPos,
      rallied: rallyPos ? creep.pos.inRangeTo(rallyPos, 1) : false
    });

    if (mem.state === 'rally') {
      if (rallyPos && !creep.pos.inRangeTo(rallyPos, 1)) {
        creep.travelTo(rallyPos, { range: 1, reusePath: CONFIG.reusePath, maxRooms: CONFIG.maxRooms });
        return;
      }
      if (TaskSquad.isReady(squadId)) {
        mem.state = 'engage';
      } else {
        return;
      }
    }

    // (0) Optional: wait for medic / rally
    if (CONFIG.waitForMedic && BeeToolbox && BeeToolbox.shouldWaitForMedic && BeeToolbox.shouldWaitForMedic(creep)) {
      var rf = Game.flags.Rally || Game.flags.MedicRally || TaskSquad.getAnchor(creep);
      if (rf) BeeToolbox.combatStepToward(creep, (rf.pos || rf), 0, TaskSquad);
      return;
    }

    // (1) Acquire target or rally
    var target = TaskSquad.sharedTarget(creep);
    if (!target) {
      var anc = TaskSquad.getAnchor(creep) || (Game.flags.Rally && Game.flags.Rally.pos) || null;
      if (anc) BeeToolbox.combatStepToward(creep, anc, 0, TaskSquad);
      BeeToolbox.combatShootOpportunistic(creep); // still shoot if anything in range
      return;
    }

    // (2) Update memory about target motion (for "don’t move if they aren’t" logic)
    var mem = creep.memory;
    if (!mem.archer) mem.archer = {};
    var A = mem.archer;

    var tpos = target.pos;
    var tMoved = true;
    if (A.tX === tpos.x && A.tY === tpos.y && A.tR === tpos.roomName) {
      tMoved = false;
    }
    A.tX = tpos.x; A.tY = tpos.y; A.tR = tpos.roomName; A.lastSeen = Game.time;

    // (3) Danger gates first
    var lowHp = (creep.hits / Math.max(1, creep.hitsMax)) < CONFIG.fleeHpPct;
    var dangerAdj = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1, { filter: function (h){
      return h.getActiveBodyparts(ATTACK)>0 || h.getActiveBodyparts(RANGED_ATTACK)>0;
    }}).length > 0;
    var inTowerBad = BeeToolbox.isInTowerDanger(creep.pos, CONFIG.towerAvoidRadius);

    if (lowHp || dangerAdj || inTowerBad) {
      BeeToolbox.combatFlee(
        creep,
        BeeToolbox.combatThreats(creep.room).concat([target]),
        3,
        { maxOps: CONFIG.maxOps, taskSquad: TaskSquad, roomCallback: BeeToolbox.roomCallback }
      );
      BeeToolbox.combatShootOpportunistic(creep); // still try to shoot after stepping
      A.movedAt = Game.time;
      return;
    }

    // (4) Combat first: fire before footwork
    BeeToolbox.combatShootPrimary(creep, target, { desiredRange: CONFIG.desiredRange, massAttackThreshold: 3 });

    // (5) Decide if we should move at all (anti-dance)
    var range = creep.pos.getRangeTo(target);

    // Cooldown: if we moved very recently, hold to prevent jitter
    if (typeof A.movedAt === 'number' && (Game.time - A.movedAt) < CONFIG.shuffleCooldown) {
      return; // hold position
    }

    // If target is NOT moving and we are within a comfy band, HOLD.
    if (!tMoved && BeeToolbox.combatInHoldBand(range, CONFIG.desiredRange, CONFIG.holdBand)) {
      return; // statuesque elegance achieved 🗿
    }

    // If we have a good shot and no extra need to adjust, also prefer holding in the band
    var hostilesIn3 = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3);
    if (hostilesIn3 && hostilesIn3.length && BeeToolbox.combatInHoldBand(range, CONFIG.desiredRange, CONFIG.holdBand)) {
      return;
    }

    // (6) Movement with hysteresis: only advance if too far; only kite if truly close
    var moved = false;
    if (range <= CONFIG.kiteIfAtOrBelow) {
      if (BeeToolbox.combatFlee(creep, [target], 3, { maxOps: CONFIG.maxOps, taskSquad: TaskSquad, roomCallback: BeeToolbox.roomCallback })) {
        moved = true;
      }
    } else if (range > (CONFIG.desiredRange + CONFIG.approachSlack)) {
      BeeToolbox.combatStepToward(creep, target.pos, CONFIG.desiredRange, TaskSquad); moved = true;
    } else {
      // in band but target moved: do nothing (don’t orbit/strafe)
    }

    if (moved) A.movedAt = Game.time;
  },
};

module.exports = TaskCombatArcher;
