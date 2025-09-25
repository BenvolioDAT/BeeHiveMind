// Task.CombatArcher.js — Stoic archer (no dancing) + DPS-first + safe kiting (ES5-safe)
'use strict';

var BeeToolbox = require('BeeToolbox');
var TaskSquad  = require('Task.Squad');

var CONFIG = {
  desiredRange: 2,          // ideal standoff distance
  kiteIfAtOrBelow: 2,       // if target ≤ this range, back off
  approachSlack: 1,         // hysteresis: only advance if range > desiredRange + this
  holdBand: 1,              // hysteresis: OK to hold if range in [desiredRange, desiredRange+holdBand]
  shuffleCooldown: 2,       // ticks to wait after any move before moving again
  fleeHpPct: 0.40,
  focusSticky: 15,
  maxRooms: 2,
  reusePath: 10,
  maxOps: 2000,
  towerAvoidRadius: 20,
  waitForMedic: false
};

var TaskCombatArcher = {
  run: function (creep) {
    if (creep.spawning) return;

    // (0) Optional: wait for medic
    if (CONFIG.waitForMedic && BeeToolbox && BeeToolbox.shouldWaitForMedic && BeeToolbox.shouldWaitForMedic(creep)) {
      var rf = Game.flags.Rally || Game.flags.MedicRally || TaskSquad.getAnchor(creep);
      if (rf) this._moveSmart(creep, (rf.pos || rf), 0);
      return;
    }

    // (1) Acquire target or rally
    var target = TaskSquad.sharedTarget(creep);
    if (!target) {
      var anc = TaskSquad.getAnchor(creep) || (Game.flags.Rally && Game.flags.Rally.pos) || null;
      if (anc) this._moveSmart(creep, anc, 0);
      this._shootOpportunistic(creep); // still shoot if anything in range
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
    var inTowerBad = this._inTowerDanger(creep.pos);

    if (lowHp || dangerAdj || inTowerBad) {
      this._flee(creep, this._threats(creep.room).concat([target]), 3);
      this._shootOpportunistic(creep); // still try to shoot after stepping
      A.movedAt = Game.time;
      return;
    }

    // (4) Combat first: fire before footwork
    this._shootPrimary(creep, target);

    // (5) Decide if we should move at all (anti-dance)
    var range = creep.pos.getRangeTo(target);

    // Cooldown: if we moved very recently, hold to prevent jitter
    if (typeof A.movedAt === 'number' && (Game.time - A.movedAt) < CONFIG.shuffleCooldown) {
      // hold position
      return;
    }

    // If target is NOT moving and we are within a comfy band, HOLD.
    if (!tMoved && this._inHoldBand(range)) {
      return; // statuesque elegance achieved 🗿
    }

    // If we have a good shot and no danger, also prefer holding even if target moved a bit
    var hostilesIn3 = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3);
    if (hostilesIn3 && hostilesIn3.length && this._inHoldBand(range)) {
      return;
    }

    // (6) Movement with hysteresis: only advance if too far; only kite if truly close
    var moved = false;
    if (range <= CONFIG.kiteIfAtOrBelow) {
      this._flee(creep, [target], 3); moved = true;
    } else if (range > (CONFIG.desiredRange + CONFIG.approachSlack)) {
      this._moveSmart(creep, target.pos, CONFIG.desiredRange); moved = true;
    } else {
      // in band but target moved: do nothing (don’t orbit/strafe)
    }

    if (moved) A.movedAt = Game.time;
  },

  // ---- Shooting policies ----
  _shootPrimary: function (creep, target) {
    // Mass if many, else single; else opportunistic at any hostile in 3
    var in3 = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3);
    if (in3.length >= 3) { creep.rangedMassAttack(); return; }
    var range = creep.pos.getRangeTo(target);
    if (range <= 3) { creep.rangedAttack(target); return; }
    this._shootOpportunistic(creep);
  },

  _shootOpportunistic: function (creep) {
    var closer = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
    if (closer && creep.pos.inRangeTo(closer, 3)) creep.rangedAttack(closer);
  },

  // ---- Helpers ----
  _inHoldBand: function (range) {
    // Hold if within [desiredRange, desiredRange + holdBand]
    if (range < CONFIG.desiredRange) return false;
    if (range > (CONFIG.desiredRange + CONFIG.holdBand)) return false;
    return true;
  },

  _threats: function (room) {
    if (!room) return [];
    var creeps = room.find(FIND_HOSTILE_CREEPS, { filter: function (h){
      return h.getActiveBodyparts(ATTACK)>0 || h.getActiveBodyparts(RANGED_ATTACK)>0;
    }});
    var towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s){ return s.structureType===STRUCTURE_TOWER; } });
    return creeps.concat(towers);
  },

  _inTowerDanger: function (pos) {
    var room = Game.rooms[pos.roomName]; if (!room) return false;
    var towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s){ return s.structureType===STRUCTURE_TOWER; } });
    for (var i=0;i<towers.length;i++) if (towers[i].pos.getRangeTo(pos) <= CONFIG.towerAvoidRadius) return true;
    return false;
  },

  _flee: function (creep, fromThings, safeRange) {
    var goals = (fromThings || []).map(function (t){ return { pos: t.pos, range: safeRange }; });
    var res = PathFinder.search(creep.pos, goals, {
      flee: true,
      maxOps: CONFIG.maxOps,
      roomCallback: function (roomName) {
        if (BeeToolbox && BeeToolbox.roomCallback) return BeeToolbox.roomCallback(roomName);
        var room = Game.rooms[roomName]; if (!room) return false;
        var costs = new PathFinder.CostMatrix();
        room.find(FIND_STRUCTURES).forEach(function (s){
          if (s.structureType===STRUCTURE_ROAD) costs.set(s.pos.x,s.pos.y,1);
          else if (s.structureType!==STRUCTURE_CONTAINER && (s.structureType!==STRUCTURE_RAMPART || !s.my)) costs.set(s.pos.x,s.pos.y,0xFF);
        });
        return costs;
      }
    });

    if (res && res.path && res.path.length) {
      var step = res.path[0];
      if (step) {
        var np = new RoomPosition(step.x, step.y, creep.pos.roomName);
        if (!TaskSquad.tryFriendlySwap(creep, np)) {
          creep.move(creep.pos.getDirectionTo(step));
        }
      }
    } else {
      var bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
      if (bad) {
        var dir = creep.pos.getDirectionTo(bad);
        var zero = (dir - 1 + 8) % 8;
        var back = ((zero + 4) % 8) + 1; // 1..8
        creep.move(back);
      }
    }
  },

  _moveSmart: function (creep, targetPos, range) {
    if (!targetPos) return;
    TaskSquad.stepToward(creep, targetPos, range);
  }
  
};


module.exports = TaskCombatArcher;
