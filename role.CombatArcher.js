// role.CombatArcher.js — PvE archer with Debug_say & Debug_draw sprinkles
// ES5-safe (no const/let/arrows). Uses TaskSquad pathing helpers when available.

var BeeToolbox = require('BeeToolbox');
var TaskSquad  = require('BeeCombatSquads');

// ---- PvE-only acceptance: react ONLY to Invader creeps/structures ----
function _isInvaderCreep(c) { return !!(c && c.owner && c.owner.username === 'Invader'); }
function _isInvaderStruct(s) { return !!(s && s.owner && s.owner.username === 'Invader'); }

// ==========================
// Config
// ==========================
var CONFIG = {
  // Ranged stance logic
  desiredRange: 2,          // target standoff
  kiteIfAtOrBelow: 2,       // kite if target is <= this range
  approachSlack: 1,         // only advance if range > desiredRange + this
  holdBand: 1,              // ok to hold when in [desiredRange, desiredRange+holdBand]

  // Motion hygiene
  shuffleCooldown: 2,       // ticks to rest after moving (anti-jitter)
  waitForMedic: true,       // delay engagement until medic nearby (if BeeToolbox.shouldWaitForMedic)
  waitTimeout: 25,

  // Safety
  fleeHpPct: 0.40,          // flee when HP below this fraction
  towerAvoidRadius: 20,     // treat invader towers as dangerous inside this radius
  maxRooms: 2,              // (reserved) cross-room leash if you wire it up
  reusePath: 10,            // path reuse hints
  maxOps: 2000,             // PathFinder ops for flee

  // Debug
  DEBUG_SAY: true,
  DEBUG_DRAW: true,
  DEBUG_LOG: false,

  COLORS: {
    PATH:   "#7ac7ff",
    SHOOT:  "#ffa07a",
    FLEE:   "#ff5c7a",
    HOLD:   "#9cff8c",
    TOWER:  "#f0c040",
    TARGET: "#ffd54f",
    TEXT:   "#f2f2f2"
  },
  WIDTH: 0.13,
  OPAC:  0.45,
  FONT:  0.7
};

// ==========================
// Mini debug helpers
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

// Wrap TaskSquad.stepToward / BeeTravel / moveTo and draw a line
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
  return creep.moveTo(d, { reusePath: CONFIG.reusePath, maxOps: 2000 });
}

// ==========================
// Core helpers
// ==========================
function inHoldBand(range){
  if (range < CONFIG.desiredRange) return false;
  if (range > (CONFIG.desiredRange + CONFIG.holdBand)) return false;
  return true;
}
function threatsInRoom(room){
  if (!room) return [];
  var creeps = room.find(FIND_HOSTILE_CREEPS, { filter: function (h){
    return _isInvaderCreep(h) && (h.getActiveBodyparts(ATTACK)>0 || h.getActiveBodyparts(RANGED_ATTACK)>0);
  }});
  var towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s){
    return _isInvaderStruct(s) && s.structureType===STRUCTURE_TOWER;
  }});
  return creeps.concat(towers);
}
function inTowerDanger(pos){
  var room = Game.rooms[pos.roomName]; if (!room) return false;
  var towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s){ return _isInvaderStruct(s) && s.structureType===STRUCTURE_TOWER; } });
  for (var i=0;i<towers.length;i++){
    if (towers[i].pos.getRangeTo(pos) <= CONFIG.towerAvoidRadius){
      if (CONFIG.DEBUG_DRAW) debugRing(towers[i], CONFIG.COLORS.TOWER, "InvTower", CONFIG.towerAvoidRadius);
      return true;
    }
  }
  return false;
}

// Flee (PathFinder.flee) with gentle friendly-swap
function fleeFrom(creep, fromThings, safeRange){
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

  if (res && res.path && res.path.length){
    var step = res.path[0];
    if (step){
      var np = new RoomPosition(step.x, step.y, creep.pos.roomName);
      debugLine(creep.pos, np, CONFIG.COLORS.FLEE, "flee");
      if (!TaskSquad.tryFriendlySwap || !TaskSquad.tryFriendlySwap(creep, np)){
        creep.move(creep.pos.getDirectionTo(step));
      }
      return;
    }
  }

  // emergency reverse if no path returned
  var bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, { filter: _isInvaderCreep });
  if (bad){
    var dir = creep.pos.getDirectionTo(bad);
    var zero = (dir - 1 + 8) % 8;
    var back = ((zero + 4) % 8) + 1;
    creep.move(back);
  }
}

// ==========================
// Shooter policies
// ==========================
function shootPrimary(creep, target){
  var in3 = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3, { filter: _isInvaderCreep });
  if (in3.length >= 3){
    debugSay(creep, "💥 mass");
    creep.rangedMassAttack();
    return;
  }
  var range = creep.pos.getRangeTo(target);
  if (range <= 3){
    debugLine(creep.pos, target.pos, CONFIG.COLORS.SHOOT, "ranged");
    creep.rangedAttack(target);
    return;
  }
  shootOpportunistic(creep);
}
function shootOpportunistic(creep){
  var closer = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, { filter: _isInvaderCreep });
  if (closer && creep.pos.inRangeTo(closer, 3)){
    debugLine(creep.pos, closer.pos, CONFIG.COLORS.SHOOT, "snap");
    creep.rangedAttack(closer);
  }
}

// ==========================
// Main role
// ==========================
var roleCombatArcher = {
  role: 'CombatArcher',

  run: function(creep){
    if (creep.spawning) return;

    var assignedAt = creep.memory.assignedAt;
    if (assignedAt == null) {
      creep.memory.assignedAt = Game.time;
      assignedAt = Game.time;
    }
    var waited = Game.time - assignedAt;
    var waitTimeout = CONFIG.waitTimeout || 25;

    // Optional rally until medic present
    var shouldWait = CONFIG.waitForMedic && BeeToolbox && BeeToolbox.shouldWaitForMedic &&
      BeeToolbox.shouldWaitForMedic(creep);
    if (shouldWait && waited < waitTimeout){
      var rf = Game.flags.Rally || Game.flags.MedicRally || (TaskSquad && TaskSquad.getAnchor && TaskSquad.getAnchor(creep));
      if (rf){
        debugSay(creep, "⛺ wait");
        moveSmart(creep, (rf.pos || rf), 0);
      }
      if (CONFIG.DEBUG_LOG && Game.time % 5 === 0){
        console.log('[CombatArcher] waiting for medic', creep.name, 'in', creep.pos.roomName, 'waited', waited, 'ticks');
      }
      return;
    }
    if (!shouldWait){
      creep.memory.assignedAt = Game.time;
      assignedAt = Game.time;
    }

    // Acquire shared target, else rally & opportunistic fire
    var target = TaskSquad && TaskSquad.sharedTarget ? TaskSquad.sharedTarget(creep) : null;
    if (!target){
      // Fallback: regroup at anchor and keep pressure with opportunistic shots when no shared target.
      var anc = (TaskSquad && TaskSquad.getAnchor && TaskSquad.getAnchor(creep)) || (Game.flags.Rally && Game.flags.Rally.pos) || null;
      if (anc) moveSmart(creep, anc, 0);
      shootOpportunistic(creep);
      return;
    }

    // Draw target ring + desired band
    if (CONFIG.DEBUG_DRAW){
      debugRing(target, CONFIG.COLORS.TARGET, "target", 0.7);
      debugRing(target, CONFIG.COLORS.HOLD, null, CONFIG.desiredRange);
      debugRing(target, CONFIG.COLORS.HOLD, null, CONFIG.desiredRange + CONFIG.holdBand);
    }

    // Track target motion (anti-dance)
    var mem = creep.memory; if (!mem.archer) mem.archer = {};
    var A = mem.archer;
    var tpos = target.pos;
    var tMoved = !(A.tX === tpos.x && A.tY === tpos.y && A.tR === tpos.roomName);
    A.tX = tpos.x; A.tY = tpos.y; A.tR = tpos.roomName; A.lastSeen = Game.time;

    // Safety gates
    var lowHp = (creep.hits / Math.max(1, creep.hitsMax)) < CONFIG.fleeHpPct;
    var dangerAdj = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1, { filter: function (h){
      return _isInvaderCreep(h) && (h.getActiveBodyparts(ATTACK)>0 || h.getActiveBodyparts(RANGED_ATTACK)>0);
    }}).length > 0;
    var towerBad = inTowerDanger(creep.pos);

    if (lowHp || dangerAdj || towerBad){
      debugSay(creep, "🏃 flee");
      fleeFrom(creep, threatsInRoom(creep.room).concat([target]), 3);
      shootOpportunistic(creep);
      A.movedAt = Game.time;
      return;
    }

    // Combat before feet
    shootPrimary(creep, target);

    var range = creep.pos.getRangeTo(target);

    // Rest a beat after movement to avoid jitter
    if (typeof A.movedAt === 'number' && (Game.time - A.movedAt) < CONFIG.shuffleCooldown){
      debugSay(creep, "⏸");
      return;
    }

    // Hold if target steady and we are in comfy band
    if (!tMoved && inHoldBand(range)){
      debugSay(creep, "🪨 hold");
      return;
    }

    // If we already have good threats in 3 and are in band, hold too
    var hostilesIn3 = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3, { filter: _isInvaderCreep });
    if (hostilesIn3 && hostilesIn3.length && inHoldBand(range)){
      debugSay(creep, "🎯 hold");
      return;
    }

    // Hysteresis movement: kite if too close, approach if too far, otherwise hold
    var moved = false;
    if (range <= CONFIG.kiteIfAtOrBelow){
      debugSay(creep, "↩ kite");
      fleeFrom(creep, [target], 3);
      moved = true;
    } else if (range > (CONFIG.desiredRange + CONFIG.approachSlack)){
      debugSay(creep, "↪ push");
      moveSmart(creep, target.pos, CONFIG.desiredRange);
      moved = true;
    } else {
      // in-band and target moved: deliberately do nothing (no orbiting)
      debugSay(creep, "🤫 stay");
    }

    if (moved) A.movedAt = Game.time;
  }
};

module.exports = roleCombatArcher;
