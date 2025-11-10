// role.CombatMelee.js — PvE melee with Debug_say & Debug_draw instrumentation (ES5-safe)
//
// Additions:
//  - DEBUG_SAY & DEBUG_DRAW toggles with lightweight HUD
//  - Path/attack/flee visuals (lines, rings, labels)
//  - Buddy/anchor annotations while guarding or rallying
//  - Tower danger rings for fast visual debugging
//
// PvE-only acceptance: targets *Invader* creeps/structures (never player assets)

var BeeToolbox = require('BeeToolbox');
var TaskSquad  = require('BeeCombatSquads');

function _isInvaderCreep(c) { return !!(c && c.owner && c.owner.username === 'Invader'); }
function _isInvaderStruct(s) { return !!(s && s.owner && s.owner.username === 'Invader'); }
function _isInvaderTarget(t){
  if (!t) return false;
  if (t.owner && t.owner.username) return t.owner.username === 'Invader';
  if (t.structureType === STRUCTURE_INVADER_CORE) return true;
  return false;
}

// ==========================
// Config
// ==========================
var CONFIG = {
  focusSticky: 15,
  fleeHpPct: 0.35,
  towerAvoidRadius: 20,
  maxRooms: 2,
  reusePath: 10,
  maxOps: 2000,
  waitForMedic: true,
  waitTimeout: 25,
  doorBash: true,
  edgePenalty: 8,

  // Debug
  DEBUG_SAY: true,
  DEBUG_DRAW: true,
  DEBUG_LOG: false,

  COLORS: {
    PATH:   "#7ac7ff",
    ATTACK: "#ffb74d",
    FLEE:   "#ff5c7a",
    BUDDY:  "#ffd54f",
    TOWER:  "#f0c040",
    TEXT:   "#f2f2f2",
    DANGER: "#ff9e80",
    COVER:  "#90caf9",
    TARGET: "#ffa726"
  },
  WIDTH: 0.13,
  OPAC:  0.45,
  FONT:  0.7
};

// ==========================
// Debug helpers
// ==========================
function _posOf(t){ return t && t.pos ? t.pos : t; }
function _roomOf(p){ return p && Game.rooms[p.roomName]; }

function debugSay(creep, msg){
  if (CONFIG.DEBUG_SAY && creep && creep.say) creep.say(msg, true);
}
function debugLine(from, to, color){
  if (!CONFIG.DEBUG_DRAW || !from || !to) return;
  var f=_posOf(from), t=_posOf(to); if(!f||!t||f.roomName!==t.roomName) return;
  var R=_roomOf(f); if(!R||!R.visual) return;
  R.visual.line(f, t, { color: color, width: CONFIG.WIDTH, opacity: CONFIG.OPAC });
}
function debugRing(target, color, text, radius){
  if (!CONFIG.DEBUG_DRAW || !target) return;
  var p=_posOf(target); if(!p) return;
  var R=_roomOf(p); if(!R||!R.visual) return;
  R.visual.circle(p, { radius: radius!=null?radius:0.6, fill:"transparent", stroke: color, opacity: CONFIG.OPAC, width: CONFIG.WIDTH });
  if (text) R.visual.text(text, p.x, p.y-0.8, { color: color, font: CONFIG.FONT, opacity: 0.95, align:"center" });
}

// Movement wrapper (TaskSquad.stepToward > BeeTravel > moveTo) with path preview
function moveSmart(creep, dest, range){
  var d = _posOf(dest) || dest;
  if (creep.pos.roomName === d.roomName && creep.pos.getRangeTo(d) > (range||1)){
    debugLine(creep.pos, d, CONFIG.COLORS.PATH);
  }
  if (TaskSquad && typeof TaskSquad.stepToward === 'function'){
    return TaskSquad.stepToward(creep, d, range);
  }
  try {
    if (BeeToolbox && typeof BeeToolbox.BeeTravel === 'function'){
      return BeeToolbox.BeeTravel(creep, d, { range: (range!=null?range:1), reusePath: CONFIG.reusePath });
    }
  } catch(e){}
  return creep.moveTo(d, { reusePath: CONFIG.reusePath, maxOps: CONFIG.maxOps });
}

// ==========================
// Core
// ==========================
var roleCombatMelee = {
  role: 'CombatMelee',

  run: function (creep) {
    if (creep.spawning) return;

    var assignedAt = creep.memory.assignedAt;
    if (assignedAt == null) {
      creep.memory.assignedAt = Game.time;
      assignedAt = Game.time;
    }
    var waited = Game.time - assignedAt;
    var waitTimeout = CONFIG.waitTimeout || 25;

    // (0) optional: wait for medic if you want tighter stack
    var shouldWait = CONFIG.waitForMedic && BeeToolbox && BeeToolbox.shouldWaitForMedic &&
      BeeToolbox.shouldWaitForMedic(creep);
    if (shouldWait && waited < waitTimeout) {
      var rf = Game.flags.Rally || Game.flags.MedicRally || TaskSquad.getAnchor(creep);
      if (rf) moveSmart(creep, rf.pos || rf, 0);
      debugSay(creep, "⏳");
      if (CONFIG.DEBUG_LOG && Game.time % 5 === 0) {
        console.log('[CombatMelee] waiting for medic', creep.name, 'in', creep.pos.roomName, 'waited', waited, 'ticks');
      }
      return;
    }
    if (!shouldWait) {
      creep.memory.assignedAt = Game.time;
      assignedAt = Game.time;
    }

    // quick self/buddy healing if we have HEAL
    this._auxHeal(creep);

    // (1) emergency bail if low HP or in tower ring
    var lowHp = (creep.hits / Math.max(1, creep.hitsMax)) < CONFIG.fleeHpPct;
    if (lowHp || this._inTowerDanger(creep.pos)) {
      debugRing(creep.pos, CONFIG.COLORS.DANGER, "flee", 1.0);
      this._flee(creep);
      var adjBad = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1, { filter: _isInvaderCreep })[0];
      if (adjBad && creep.getActiveBodyparts(ATTACK) > 0) {
        debugLine(creep.pos, adjBad.pos, CONFIG.COLORS.ATTACK, "⚔");
        creep.attack(adjBad);
      }
      return;
    }

    // (2) bodyguard: interpose for squishy squadmates
    if (this._guardSquadmate(creep)) {
      var hugger = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1, { filter: _isInvaderCreep })[0];
      if (hugger && creep.getActiveBodyparts(ATTACK) > 0) {
        debugLine(creep.pos, hugger.pos, CONFIG.COLORS.ATTACK, "⚔");
        creep.attack(hugger);
      }
      return;
    }

    // (3) squad shared target (enforce PvE: skip if not Invader-owned/core)
    var target = TaskSquad.sharedTarget(creep);
    if (target && !_isInvaderTarget(target)) target = null;

    if (!target) {
      var hostiles = creep.room ? creep.room.find(FIND_HOSTILE_CREEPS, { filter: _isInvaderCreep }) : null;
      if (hostiles && hostiles.length) {
        var nearest = creep.pos.findClosestByPath(hostiles) || creep.pos.findClosestByRange(hostiles);
        if (nearest) {
          moveSmart(creep, nearest.pos, 1);
          if (creep.pos.isNearTo(nearest) && creep.getActiveBodyparts(ATTACK) > 0) {
            debugLine(creep.pos, nearest.pos, CONFIG.COLORS.ATTACK, "⚔");
            creep.attack(nearest);
          }
          return;
        }
      }
      var anc = TaskSquad.getAnchor(creep);
      if (anc) {
        debugRing(anc, CONFIG.COLORS.BUDDY, "anchor", 0.8);
        moveSmart(creep, anc, 1);
      }
      return;
    }

    if (CONFIG.DEBUG_DRAW) debugRing(target, CONFIG.COLORS.TARGET, "target", 0.7);

    // Opportunistic pre-retarget to weaklings in 1..2 (actually used now)
    if (Game.time % 3 === 0) {
      var weak = this._weakestIn1to2(creep);
      if (weak && (weak.hits / Math.max(1, weak.hitsMax)) < 0.5) {
        target = weak;
        if (CONFIG.DEBUG_DRAW) debugRing(target, CONFIG.COLORS.TARGET, "weak", 0.9);
      }
    }

    // (4) approach & strike
    if (creep.pos.isNearTo(target)) {
      // If target tile is protected by an Invader rampart, hit the cover first (PvE-only)
      var coverList = target.pos.lookFor(LOOK_STRUCTURES);
      var cover = null;
      for (var ci = 0; ci < coverList.length; ci++) {
        var st = coverList[ci];
        if (st.structureType === STRUCTURE_RAMPART && _isInvaderStruct(st)) {
          cover = st; break;
        }
      }
      if (cover && creep.getActiveBodyparts(ATTACK) > 0) {
        debugLine(creep.pos, cover.pos, CONFIG.COLORS.COVER, "🛡");
        debugSay(creep, "🔨");
        creep.attack(cover);
        return;
      }

      // Explicit Invader Core handling: stand and swing
      if (target.structureType && target.structureType === STRUCTURE_INVADER_CORE) {
        debugSay(creep, "⚔ core!");
        debugLine(creep.pos, target.pos, CONFIG.COLORS.ATTACK, "⚔");
        if (creep.getActiveBodyparts(ATTACK) > 0) creep.attack(target);
        return;
      }

      // Normal melee attack (unshielded)
      if (creep.getActiveBodyparts(ATTACK) > 0) {
        debugLine(creep.pos, target.pos, CONFIG.COLORS.ATTACK, "⚔");
        creep.attack(target);
      }

      // Micro-step to a safer/better adjacent tile (avoid tower/edges/melee stacks)
      var better = this._bestAdjacentTile(creep, target);
      if (better && (better.x !== creep.pos.x || better.y !== creep.pos.y)) {
        var dir = creep.pos.getDirectionTo(better);
        creep.move(dir);
      }
      return;
    }

    // (5) door bash if a blocking wall/rampart is the nearer path at range 1 (Invader ramparts only)
    if (CONFIG.doorBash) {
      var blocker = this._blockingDoor(creep, target);
      if (blocker && creep.pos.isNearTo(blocker)) {
        if (creep.getActiveBodyparts(ATTACK) > 0) {
          debugSay(creep, "🧱");
          debugLine(creep.pos, blocker.pos, CONFIG.COLORS.COVER, "bash");
          creep.attack(blocker);
        }
        return;
      }
    }

    // (6) close in via TaskSquad pathing (polite traffic + swaps)
    moveSmart(creep, target.pos, 1);

    // Opportunistic hit if we brushed into melee with a creep
    var adj = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1, { filter: _isInvaderCreep })[0];
    if (adj && creep.getActiveBodyparts(ATTACK) > 0) {
      debugLine(creep.pos, adj.pos, CONFIG.COLORS.ATTACK, "⚔");
      creep.attack(adj);
    }
  },

  // --- heal self/squad if possible (no double actions)
  _auxHeal: function (creep) {
    var healParts = creep.getActiveBodyparts(HEAL);
    if (!healParts) return;

    if (creep.hits < creep.hitsMax) {
      debugSay(creep, "💊");
      creep.heal(creep);
      return;
    }

    var sid = (creep.memory && creep.memory.squadId) || 'Alpha';
    var mates = _.filter(Game.creeps, function (c) {
      return c.my && c.id !== creep.id && c.memory && c.memory.squadId === sid && c.hits < c.hitsMax;
    });
    if (!mates.length) return;

    var target = _.min(mates, function (c) { return c.hits / Math.max(1, c.hitsMax); });
    if (creep.pos.isNearTo(target)) {
      debugLine(creep.pos, target.pos, CONFIG.COLORS.ATTACK, "heal");
      creep.heal(target);
    } else if (creep.pos.inRangeTo(target, 3)) {
      debugLine(creep.pos, target.pos, CONFIG.COLORS.ATTACK, "rheal");
      creep.rangedHeal(target);
    }
  },

  // --- interpose for allies (uses TaskSquad.swap + stepToward)
  _guardSquadmate: function (creep) {
    var sid = (creep.memory && creep.memory.squadId) || 'Alpha';
    var threatened = _.filter(Game.creeps, function (ally) {
      if (!ally.my || !ally.memory || ally.memory.squadId !== sid) return false;
      var role = ally.memory.task || ally.memory.role || '';
      if (role !== 'CombatArcher' && role !== 'CombatMedic' && role !== 'Dismantler') return false;
      return ally.pos.findInRange(FIND_HOSTILE_CREEPS, 1, {
        filter: function (h){ return _isInvaderCreep(h) && h.getActiveBodyparts(ATTACK) > 0; }
      }).length > 0;
    });

    if (!threatened.length) return false;
    var buddy = creep.pos.findClosestByRange(threatened);
    if (!buddy) return false;

    if (CONFIG.DEBUG_DRAW) debugRing(buddy, CONFIG.COLORS.BUDDY, "guard", 0.8);

    if (creep.pos.isNearTo(buddy)) {
      // Try a same-squad friendly swap to put melee between buddy and threat
      if (TaskSquad.tryFriendlySwap && TaskSquad.tryFriendlySwap(creep, buddy.pos)) {
        debugSay(creep, "↔");
        return true;
      }

      var bad = buddy.pos.findInRange(FIND_HOSTILE_CREEPS, 1, {filter: function (h){return _isInvaderCreep(h) && h.getActiveBodyparts(ATTACK)>0;}})[0];
      if (bad) {
        var best = this._bestAdjacentTile(creep, bad);
        if (best && creep.pos.getRangeTo(best) === 1) {
          debugLine(creep.pos, best, CONFIG.COLORS.PATH, "cover");
          creep.move(creep.pos.getDirectionTo(best));
          return true;
        }
      }
    } else {
      debugLine(creep.pos, buddy.pos, CONFIG.COLORS.PATH, "guard");
      moveSmart(creep, buddy.pos, 1);
      return true;
    }
    return false;
  },

  _inTowerDanger: function (pos) {
    var room = Game.rooms[pos.roomName]; if (!room) return false;
    var towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s){
      return _isInvaderStruct(s) && s.structureType === STRUCTURE_TOWER;
    }});
    var danger = false;
    for (var i=0;i<towers.length;i++) {
      if (towers[i].pos.getRangeTo(pos) <= CONFIG.towerAvoidRadius) danger = true;
      if (CONFIG.DEBUG_DRAW) debugRing(towers[i], CONFIG.COLORS.TOWER, "InvTower", CONFIG.towerAvoidRadius);
    }
    return danger;
  },

  _bestAdjacentTile: function (creep, target) {
    var best = creep.pos, bestScore = 1e9, room = creep.room;
    var threats = room ? room.find(FIND_HOSTILE_CREEPS, {
      filter: function (h){
        return _isInvaderCreep(h) && (h.getActiveBodyparts(ATTACK)>0 || h.getActiveBodyparts(RANGED_ATTACK)>0) && h.hits>0;
      }
    }) : [];

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
      // adjacent to melee or ranged threats
      for (i=0;i<threats.length;i++) if (threats[i].pos.getRangeTo(pos)<=1) score+=20;
      // tower danger ring
      if (this._inTowerDanger(pos)) score+=50;
      // near-edge penalty (1 and 48 rows/cols)
      if (x<=1 || x>=48 || y<=1 || y>=48) score += CONFIG.edgePenalty;
      // roads are slightly preferred
      if (onRoad) score-=1;

      if (score<bestScore) { bestScore=score; best=pos; }
    }

    if (CONFIG.DEBUG_DRAW && (best.x !== creep.pos.x || best.y !== creep.pos.y)) {
      debugRing(best, CONFIG.COLORS.PATH, "best", 0.5);
    }
    return best;
  },

  _blockingDoor: function (creep, target) {
    // Only walls and INVADER ramparts count as bashable (PvE-only)
    var closeStructs = creep.pos.findInRange(FIND_STRUCTURES, 1, { filter: function (s) {
      if (s.structureType === STRUCTURE_WALL) return true;
      if (s.structureType === STRUCTURE_RAMPART && _isInvaderStruct(s)) return true;
      return false;
    }});
    if (!closeStructs.length) return null;
    var best = _.min(closeStructs, function (s){ return s.pos.getRangeTo(target); });
    if (!best) return null;
    var distNow = creep.pos.getRangeTo(target);
    var distThru = best.pos.getRangeTo(target);
    if (CONFIG.DEBUG_DRAW) debugRing(best, CONFIG.COLORS.COVER, "door", 0.6);
    return distThru < distNow ? best : null;
  },

  _weakestIn1to2: function (creep) {
    var xs = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 2, { filter: _isInvaderCreep });
    if (!xs.length) return null;
    return _.min(xs, function (c){ return c.hits / Math.max(1, c.hitsMax); });
  },

  _flee: function (creep) {
    var rally = Game.flags.MedicRally || Game.flags.Rally || TaskSquad.getAnchor(creep);
    if (rally) {
      debugLine(creep.pos, rally.pos || rally, CONFIG.COLORS.FLEE, "flee");
      moveSmart(creep, rally.pos || rally, 1);
    } else {
      var bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, { filter: _isInvaderCreep });
      if (bad) {
        var dir = creep.pos.getDirectionTo(bad);
        var zero = (dir - 1 + 8) % 8;
        var back = ((zero + 4) % 8) + 1;
        debugSay(creep, "↩");
        creep.move(back);
      }
    }
  }
};

module.exports = roleCombatMelee;
