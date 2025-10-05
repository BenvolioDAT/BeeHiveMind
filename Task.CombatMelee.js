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

    if (TaskSquad.shouldRecycle && TaskSquad.shouldRecycle(creep)) {
      TaskSquad.recycleToHome(creep);
      return;
    }

    // (0) optional: wait for medic if you want tighter stack
    if (CONFIG.waitForMedic && BeeToolbox && BeeToolbox.shouldWaitForMedic && BeeToolbox.shouldWaitForMedic(creep)) {
      var rf = Game.flags.Rally || Game.flags.MedicRally || TaskSquad.getAnchor(creep);
      if (rf) this._moveSmart(creep, rf.pos || rf, 0);
      return;
    }

    // quick self/buddy healing if we have HEAL
    this._auxHeal(creep);

    // (1) emergency bail if low HP or in tower ring
    var lowHp = (creep.hits / creep.hitsMax) < CONFIG.fleeHpPct;
    if (lowHp || this._inTowerDanger(creep.pos)) {
      this._flee(creep);
      var adjBad = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1)[0];
      if (adjBad) creep.attack(adjBad);
      return;
    }

    // (2) bodyguard: interpose for squishy squadmates
    if (this._guardSquadmate(creep)) {
      var hugger = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1)[0];
      if (hugger) creep.attack(hugger);
      return;
    }

    // (3) squad shared target
    var target = TaskSquad.sharedTarget(creep);
    if (!target) {
      var anc = TaskSquad.getAnchor(creep);
      if (anc) this._moveSmart(creep, anc, 1);
      return;
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
      var better = this._bestAdjacentTile(creep, target);
      if (better && (better.x !== creep.pos.x || better.y !== creep.pos.y)) {
        var dir = creep.pos.getDirectionTo(better);
        creep.move(dir);
      }
      return;
    }

    // (5) door bash if a blocking wall/rampart is the nearer path at range 1
    if (CONFIG.doorBash) {
      var blocker = this._blockingDoor(creep, target);
      if (blocker && creep.pos.isNearTo(blocker)) {
        creep.attack(blocker);
        return;
      }
    }

    // (6) close in via Traveler-powered TaskSquad (polite traffic + swaps)
    TaskSquad.stepToward(creep, target.pos, 1);

    // opportunistic hit if we brushed into melee
    var adj = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1)[0];
    if (adj) creep.attack(adj);

    // (7) occasional opportunistic retarget to weaklings in 1..2
    if (Game.time % 3 === 0) {
      var weak = this._weakestIn1to2(creep);
      if (weak && (weak.hits / weak.hitsMax) < 0.5) target = weak;
    }
  },

  // --- heal self/squad if possible (keeps ES5 style, no double actions)
  _auxHeal: function (creep) {
    var healParts = creep.getActiveBodyparts(HEAL);
    if (!healParts) return;

    if (creep.hits < creep.hitsMax) {
      creep.heal(creep);
      return;
    }

    var sid = (creep.memory && creep.memory.squadId) || 'Alpha';
    var mates = _.filter(Game.creeps, function (c) {
      return c.my && c.id !== creep.id && c.memory && c.memory.squadId === sid && c.hits < c.hitsMax;
    });
    if (!mates.length) return;
    var target = _.min(mates, function (c) { return c.hits / c.hitsMax; });

    if (creep.pos.isNearTo(target)) creep.heal(target);
    else if (creep.pos.inRangeTo(target, 3)) creep.rangedHeal(target);
  },

  // --- interpose for allies (uses TaskSquad.swap + stepToward)
  _guardSquadmate: function (creep) {
    var sid = (creep.memory && creep.memory.squadId) || 'Alpha';
    var threatened = _.filter(Game.creeps, function (ally) {
      if (!ally.my || !ally.memory || ally.memory.squadId !== sid) return false;
      var role = ally.memory.task || ally.memory.role || '';
      if (role !== 'CombatArcher' && role !== 'CombatMedic' && role !== 'Dismantler') return false;
      return ally.pos.findInRange(FIND_HOSTILE_CREEPS, 1, {
        filter: function (h){ return h.getActiveBodyparts(ATTACK) > 0; }
      }).length > 0;
    });

    if (!threatened.length) return false;
    var buddy = creep.pos.findClosestByRange(threatened);
    if (!buddy) return false;

    if (creep.pos.isNearTo(buddy)) {
      // Try a same-squad friendly swap to put melee between buddy and threat
      if (TaskSquad.tryFriendlySwap && TaskSquad.tryFriendlySwap(creep, buddy.pos)) return true;

      var bad = buddy.pos.findInRange(FIND_HOSTILE_CREEPS, 1, {filter: function (h){return h.getActiveBodyparts(ATTACK)>0;}})[0];
      if (bad) {
        var best = this._bestAdjacentTile(creep, bad);
        if (best && creep.pos.getRangeTo(best) === 1) {
          creep.move(creep.pos.getDirectionTo(best));
          return true;
        }
      }
    } else {
      TaskSquad.stepToward(creep, buddy.pos, 1);
      return true;
    }
    return false;
  },

  // --- unified movement shim (Traveler via TaskSquad)
  _moveSmart: function (creep, targetPos, range) {
    if (!targetPos) return;
    TaskSquad.stepToward(creep, (targetPos.pos || targetPos), range);
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

      // passability & bonuses
      var look = pos.look();
      var impass=false, onRoad=false, i;
      for (i=0;i<look.length;i++){
        var o=look[i];
        if (o.type===LOOK_TERRAIN && o.terrain==='wall') { impass=true; break; }
        if (o.type===LOOK_CREEPS) { impass=true; break; } // don't choose an occupied tile
        if (o.type===LOOK_STRUCTURES) {
          var st=o.structure.structureType;
          if (st===STRUCTURE_ROAD) onRoad=true;
          else if (st!==STRUCTURE_CONTAINER && (st!==STRUCTURE_RAMPART || !o.structure.my)) { impass=true; break; }
        }
      }
      if (impass) continue;

      var score=0;
      for (i=0;i<threats.length;i++) if (threats[i].pos.getRangeTo(pos)<=1) score+=20;
      if (this._inTowerDanger(pos)) score+=50;
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
    if (rally) {
      this._moveSmart(creep, rally.pos || rally, 1);
    } else {
      var bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
      if (bad) {
        var dir = creep.pos.getDirectionTo(bad);
        var zero = (dir - 1 + 8) % 8;
        var back = ((zero + 4) % 8) + 1;
        creep.move(back);
      }
    }
  }
};

module.exports = CombatMelee;
