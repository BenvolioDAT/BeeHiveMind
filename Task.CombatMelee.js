// Task.CombatMelee.js — Vanguard with squad anchor & shared target (ES5-safe)
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

    // (0) optional: wait for medic if you want tighter stack
    if (CONFIG.waitForMedic && BeeToolbox && BeeToolbox.shouldWaitForMedic && BeeToolbox.shouldWaitForMedic(creep)) {
      var rf = Game.flags.Rally || Game.flags.MedicRally || TaskSquad.getAnchor(creep);
      if (rf) this._moveSmart(creep, rf.pos || rf, 0);
      return;
    }

    // (1) emergency bail
    var lowHp = (creep.hits / creep.hitsMax) < CONFIG.fleeHpPct;
    if (lowHp || this._inTowerDanger(creep.pos)) {
      this._flee(creep);
      var adjBad = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1)[0];
      if (adjBad) creep.attack(adjBad);
      return;
    }

    // (2) squad shared target (preferred)
    var target = TaskSquad.sharedTarget(creep);
    if (!target) {
      // no visible target: hold near anchor
      var anc = TaskSquad.getAnchor(creep);
      if (anc) this._moveSmart(creep, anc, 1);
      return;
    }

    // (3) approach & strike
    if (creep.pos.isNearTo(target)) {
      creep.attack(target);
      var better = this._bestAdjacentTile(creep, target);
      if (better && (better.x !== creep.pos.x || better.y !== creep.pos.y)) {
        var dir = creep.pos.getDirectionTo(better);
        creep.move(dir);
      }
      return;
    }

    // door bash if gate at 1
    if (CONFIG.doorBash) {
      var blocker = this._blockingDoor(creep, target);
      if (blocker && creep.pos.isNearTo(blocker)) {
        creep.attack(blocker);
        return;
      }
    }

    // normal close-in + friendly swap possibility via squad stepToward
    TaskSquad.stepToward(creep, target.pos, 1);

    // opportunistic hit
    var adj = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1)[0];
    if (adj) creep.attack(adj);

    // occasional retarget to weaker in reach
    if (Game.time % 3 === 0) {
      var weak = this._weakestIn1to2(creep);
      if (weak && (weak.hits / weak.hitsMax) < 0.5) target = weak;
    }

    // act as squad anchor (implicitly via Task.Squad)
  },

  // ---- utilities (mostly your originals) ----
  _moveSmart: function (creep, targetPos, range) {
    if (!targetPos) return;
    creep.moveTo(targetPos, {
      range: range, reusePath: CONFIG.reusePath, maxRooms: CONFIG.maxRooms, maxOps: CONFIG.maxOps,
      plainCost: 2, swampCost: 6,
      costCallback: function (roomName, matrix) {
        var room = Game.rooms[roomName]; if (!room) return matrix;
        room.find(FIND_STRUCTURES, { filter: function (s){ return s.structureType === STRUCTURE_ROAD; } })
            .forEach(function (r){ matrix.set(r.pos.x, r.pos.y, 1); });
        var towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s){ return s.structureType === STRUCTURE_TOWER; } });
        for (var i=0;i<towers.length;i++){
          var t=towers[i], r=CONFIG.towerAvoidRadius;
          for (var dx=-r; dx<=r; dx++) for (var dy=-r; dy<=r; dy++){
            var x=t.pos.x+dx, y=t.pos.y+dy; if (x<0||x>49||y<0||y>49) continue;
            matrix.set(x,y, Math.max(matrix.get(x,y),255));
          }
        }
        if (BeeToolbox && BeeToolbox.roomCallback) {
          var m2 = BeeToolbox.roomCallback(roomName);
          if (m2) {
            for (var x=0;x<50;x++) for (var y=0;y<50;y++){
              var v=m2.get(x,y); if (v) matrix.set(x,y, Math.max(matrix.get(x,y), v));
            }
          }
        }
        return matrix;
      }
    });
  },

  _inTowerDanger: function (pos) {
    var room = Game.rooms[pos.roomName]; if (!room) return false;
    var towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s){ return s.structureType === STRUCTURE_TOWER; } });
    for (var i=0;i<towers.length;i++) if (towers[i].pos.getRangeTo(pos) <= CONFIG.towerAvoidRadius) return true;
    return false;
  },

  _bestAdjacentTile: function (creep, target) {
    var best = creep.pos, bestScore = 1e9, room = creep.room;
    var threats = room ? room.find(FIND_HOSTILE_CREEPS, { filter: function (h){ return h.getActiveBodyparts(ATTACK)>0 && h.hits>0; } }) : [];

    for (var dx=-1; dx<=1; dx++) for (var dy=-1; dy<=1; dy++) {
      if (!dx && !dy) continue;
      var x=creep.pos.x+dx, y=creep.pos.y+dy;
      if (x<=0||x>=49||y<=0||y>=49) continue;
      var pos = new RoomPosition(x,y, creep.room.name);
      if (!pos.isNearTo(target)) continue;
      var look = pos.look();
      var impass=false, onRoad=false;
      for (var i=0;i<look.length;i++){
        var o=look[i];
        if (o.type===LOOK_TERRAIN && o.terrain==='wall') { impass=true; break; }
        if (o.type===LOOK_STRUCTURES) {
          var st=o.structure.structureType;
          if (st===STRUCTURE_ROAD) onRoad=true;
          else if (st!==STRUCTURE_CONTAINER && (st!==STRUCTURE_RAMPART || !o.structure.my)) { impass=true; break; }
        }
      }
      if (impass) continue;

      var score=0;
      // enemy melee adjacency
      for (i=0;i<threats.length;i++) if (threats[i].pos.getRangeTo(pos)<=1) score+=20;
      // tower danger
      if (this._inTowerDanger(pos)) score+=50;
      // edge penalty
      if (x===0||x===49||y===0||y===49) score+=CONFIG.edgePenalty;
      if (onRoad) score-=1;

      if (score<bestScore) { bestScore=score; best=pos; }
    }
    return best;
  },

  _blockingDoor: function (creep, target) {
    var closeStructs = creep.pos.findInRange(FIND_STRUCTURES, 1, { filter: function (s) {
      return (s.structureType===STRUCTURE_RAMPART && !s.my) || s.structureType===STRUCTURE_WALL;
    }});
    if (!closeStructs.length) return null;
    var best = _.min(closeStructs, function (s){ return s.pos.getRangeTo(target); });
    if (!best) return null;
    var distNow = creep.pos.getRangeTo(target);
    var distThru = best.pos.getRangeTo(target);
    return distThru < distNow ? best : null;
  },

  _weakestIn1to2: function (creep) {
    var xs = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 2);
    if (!xs.length) return null;
    return _.min(xs, function (c){ return c.hits / c.hitsMax; });
  },

  _flee: function (creep) {
    var rally = Game.flags.MedicRally || Game.flags.Rally || TaskSquad.getAnchor(creep);
    if (rally) this._moveSmart(creep, rally.pos || rally, 1);
    else {
      var bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
      if (bad) creep.move((creep.pos.getDirectionTo(bad) + 4) % 8);
    }
  }
};

module.exports = CombatMelee;
