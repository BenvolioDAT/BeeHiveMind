// Task.CombatArcher.js — Flanking archer with squad target & formation (ES5-safe)
'use strict';

var BeeToolbox = require('BeeToolbox');
var TaskSquad  = require('Task.Squad');

var CONFIG = {
  desiredRange: 2,
  kiteIfAtOrBelow: 2,
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

    if (CONFIG.waitForMedic && BeeToolbox && BeeToolbox.shouldWaitForMedic && BeeToolbox.shouldWaitForMedic(creep)) {
      var rf = Game.flags.Rally || Game.flags.MedicRally || TaskSquad.getAnchor(creep);
      if (rf) this._moveSmart(creep, (rf.pos||rf), 0);
      return;
    }

    var threats = this._threats(creep.room);
    var lowHp = (creep.hits / creep.hitsMax) < CONFIG.fleeHpPct;
    var brawlersClose = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 2, { filter: function (h){ return h.getActiveBodyparts(ATTACK)>0; } }).length > 0;

    if (lowHp || brawlersClose || this._inTowerDanger(creep.pos)) {
      this._flee(creep, threats, 3);
      this._combatAction(creep, null);
      return;
    }

    // shared squad target
    var target = TaskSquad.sharedTarget(creep);

    // if nothing to shoot, drift to anchor/rally
    if (!target) {
      var anc = TaskSquad.getAnchor(creep) || (Game.flags.Rally && Game.flags.Rally.pos) || null;
      if (anc) this._moveSmart(creep, anc, 0);
      return;
    }

    var range = creep.pos.getRangeTo(target);
    var many = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3).length;

    if (many >= 3 || creep.pos.findInRange(FIND_HOSTILE_CREEPS, 2).length >= 2) {
      if (range <= 3) creep.rangedMassAttack();
    } else if (range <= 3) {
      creep.rangedAttack(target);
    }

    // formation bias: archers try to stand 2–3 tiles from target,
    // roughly offset from melee/anchor to reduce bumping
    var anchor = TaskSquad.getAnchor(creep);
    if (range <= CONFIG.kiteIfAtOrBelow) {
      this._flee(creep, threats.concat([target]), 3);
    } else if (range > CONFIG.desiredRange) {
      // step toward target, but if anchor exists, bias through anchor line to keep formation compact
      var aim = target.pos;
      if (anchor && anchor.roomName === creep.pos.roomName) {
        // tiny nudge: if archer is behind anchor relative to target, step diagonally
        // (simple and cheap; precise vector math not needed)
      }
      TaskSquad.stepToward(creep, aim, CONFIG.desiredRange);
    } else {
      this._strafeIfBad(creep, threats);
    }
  },

  // ---- helpers (mostly your originals) ----
  _threats: function (room) {
    if (!room) return [];
    var creeps = room.find(FIND_HOSTILE_CREEPS, { filter: function (h){ return h.getActiveBodyparts(ATTACK)>0 || h.getActiveBodyparts(RANGED_ATTACK)>0; } });
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
    var goals = (fromThings||[]).map(function (t){ return { pos: t.pos, range: safeRange }; });
    var res = PathFinder.search(creep.pos, goals, {
      flee: true, maxOps: CONFIG.maxOps,
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
      if (step) creep.move(creep.pos.getDirectionTo(step));
    } else {
      var bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
      if (bad) creep.move((creep.pos.getDirectionTo(bad)+4)%8);
    }
  },

  _moveSmart: function (creep, targetPos, range) {
    if (!targetPos) return;
    creep.moveTo(targetPos, {
      range: range, reusePath: CONFIG.reusePath, maxRooms: CONFIG.maxRooms, maxOps: CONFIG.maxOps,
      plainCost: 2, swampCost: 6,
      costCallback: function (roomName, matrix) {
        var room = Game.rooms[roomName]; if (!room) return matrix;
        room.find(FIND_STRUCTURES, { filter: function (s){ return s.structureType===STRUCTURE_ROAD; } })
            .forEach(function (r){ matrix.set(r.pos.x,r.pos.y,1); });
        var towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s){ return s.structureType===STRUCTURE_TOWER; } });
        for (var i=0;i<towers.length;i++){
          var t=towers[i], r=CONFIG.towerAvoidRadius;
          for (var dx=-r; dx<=r; dx++) for (var dy=-r; dy<=r; dy++){
            var x=t.pos.x+dx, y=t.pos.y+dy; if (x<0||x>49||y<0||y>49) continue;
            matrix.set(x,y, Math.max(matrix.get(x,y),255));
          }
        }
        return matrix;
      }
    });
  },

  _strafeIfBad: function (creep) {
    var danger = this._inTowerDanger(creep.pos) ||
                 creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1, { filter: function (h){ return h.getActiveBodyparts(ATTACK)>0; } }).length > 0;
    if (!danger) return;
    this._flee(creep, [], 2);
  },

  _combatAction: function (creep) {
    var many = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3).length;
    if (many >= 3) creep.rangedMassAttack();
    else {
      var closest = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
      if (closest && creep.pos.inRangeTo(closest, 3)) creep.rangedAttack(closest);
    }
  }
};

module.exports = TaskCombatArcher;
