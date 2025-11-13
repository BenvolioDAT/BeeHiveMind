// role.Dismantler.js — PvE dismantler with Debug_say & Debug_draw instrumentation (ES5-safe)
//
// What’s new:
//  - DEBUG_SAY and DEBUG_DRAW toggles
//  - Visual path lines, target rings, “door” highlights (walls / Invader ramparts)
//  - Clear PvE fences: only Invader-owned assets or neutral walls get bonked
//  - Smart fallback vs Invader Core (attack, not dismantle)
//  - Sticky target memory with auto-clear on low hits / invalid target
//
// Buzz motto: “measure twice, dismantle once.” 🐝

var BeeToolbox = require('BeeToolbox');

function _isInvaderStruct(s) { return !!(s && s.owner && s.owner.username === 'Invader'); }
function _isInvaderCore(s)   { return !!(s && s.structureType === STRUCTURE_INVADER_CORE); }
function _isBashableDoor(s)  { return !!(s && (s.structureType === STRUCTURE_WALL || (s.structureType === STRUCTURE_RAMPART && _isInvaderStruct(s)))); }

var CONFIG = {
  reusePath: 12,
  maxRooms: 1,
  doorScanMaxOps: 600,
  retargetThreshold: 1000, // when target.hits <= this, drop lock next tick to avoid idle swings

  // Debug toggles
  DEBUG_SAY:  true,
  DEBUG_DRAW: true,

  COLORS: {
    PATH:   "#7ac7ff",
    TARGET: "#ffa726",
    DOOR:   "#90caf9",
    ATTACK: "#ff9e80",
    TEXT:   "#eaeaea"
  },
  WIDTH: 0.13,
  OPAC:  0.45,
  FONT:  0.7
};

// ---------------------
// Debug helpers
// ---------------------
function _posOf(t){ return t && t.pos ? t.pos : t; }
function _roomOf(p){ return p && Game.rooms[p.roomName]; }

function debugSay(creep, msg){
  if (CONFIG.DEBUG_SAY && creep && creep.say) creep.say(msg, true);
}
function debugLine(from, to, color, label){
  if (!CONFIG.DEBUG_DRAW || !from || !to) return;
  var f=_posOf(from), t=_posOf(to); if(!f||!t||f.roomName!==t.roomName) return;
  var R=_roomOf(f); if(!R||!R.visual) return;
  R.visual.line(f, t, { color: color, width: CONFIG.WIDTH, opacity: CONFIG.OPAC });
  if (label){
    var mx=(f.x+t.x)/2, my=(f.y+t.y)/2;
    R.visual.text(label, mx, my-0.25, {
      color: color, opacity: 0.95, font: CONFIG.FONT, align:"center",
      backgroundColor:"#000", backgroundOpacity:0.25
    });
  }
}
function debugRing(target, color, text, radius){
  if (!CONFIG.DEBUG_DRAW || !target) return;
  var p=_posOf(target); if(!p) return;
  var R=_roomOf(p); if(!R||!R.visual) return;
  R.visual.circle(p, { radius: radius!=null?radius:0.6, fill:"transparent", stroke: color, opacity: CONFIG.OPAC, width: CONFIG.WIDTH });
  if (text) R.visual.text(text, p.x, p.y-0.8, { color: color, font: CONFIG.FONT, opacity: 0.95, align:"center" });
}
function hud(creep, text){
  if (!CONFIG.DEBUG_DRAW) return;
  var R=creep.room; if(!R||!R.visual) return;
  R.visual.text(text, creep.pos.x, creep.pos.y-1.2, {
    color: CONFIG.COLORS.TEXT, font: CONFIG.FONT, opacity: 0.95, align: "center",
    backgroundColor:"#000", backgroundOpacity:0.25
  });
}

// Polite movement wrapper (BeeTravel preferred)
function moveSmart(creep, dest, range){
  var d=_posOf(dest)||dest;
  if (creep.pos.roomName===d.roomName && creep.pos.getRangeTo(d) > (range||1)){
    debugLine(creep.pos, d, CONFIG.COLORS.PATH, "→");
  }
  try {
    if (BeeToolbox && typeof BeeToolbox.BeeTravel === 'function'){
      return BeeToolbox.BeeTravel(creep, d, { range: (range!=null?range:1), reusePath: CONFIG.reusePath, maxRooms: CONFIG.maxRooms });
    }
  } catch(e){}
  return creep.moveTo(d, { reusePath: CONFIG.reusePath, maxRooms: CONFIG.maxRooms });
}

var roleDismantler = {
  role: 'Dismantler',

  run: function (creep) {
    if (creep.spawning) return;
    if (_shouldDelayForDecoy(creep)) return;

    drawVitalsHud(creep);

    var target = _refreshTarget(creep);
    if (!target) {
      _rallyOrIdle(creep);
      return;
    }

    if (_drawCrossRoomAwareness(creep, target)) {
      // Visual hint already drawn; keep chasing even if not visible yet.
    }

    if (_handleBlockingDoor(creep, target)) return;

    if (_handleInvaderCore(creep, target)) return;

    _handleStructure(creep, target);
  },

  // ---------------------
  // Targeting
  // ---------------------
  _isValidTarget: function (t) {
    if (!t || !t.pos) return false;
    if (_isInvaderCore(t)) return true;
    if (t.hits === undefined) return false; // not damageable
    return _isInvaderStruct(t); // PvE fence: Invader only
  },

  _pickNewTarget: function (creep) {
    // helper
    function closest(arr){ return (arr && arr.length) ? creep.pos.findClosestByPath(arr) : null; }

    // 1) High-priority threats
    var towers = creep.room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function (s) { return _isInvaderStruct(s) && s.structureType === STRUCTURE_TOWER; }
    });
    // 2) Spawns
    var spawns = creep.room.find(FIND_HOSTILE_SPAWNS, { filter: _isInvaderStruct });
    // 3) Invader cores (explicit)
    var cores  = creep.room.find(FIND_HOSTILE_STRUCTURES, { filter: _isInvaderCore });
    // 4) Everything else dismantle-worthy (Invader-owned only; exclude junk)
    var others = creep.room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function (s) {
        if (!_isInvaderStruct(s)) return false;
        if (s.hits === undefined) return false;
        var t = s.structureType;
        if (t === STRUCTURE_CONTROLLER) return false;
        if (t === STRUCTURE_ROAD)      return false;
        if (t === STRUCTURE_CONTAINER) return false;
        if (t === STRUCTURE_EXTENSION) return false;
        if (t === STRUCTURE_LINK)      return false;
        if (t === STRUCTURE_TOWER)     return false;
        if (t === STRUCTURE_SPAWN)     return false;
        if (t === STRUCTURE_INVADER_CORE) return false; // handled separately
        return true;
      }
    });

    var pick = closest(towers) || closest(spawns) || closest(cores) || closest(others);
    if (pick) debugRing(pick, CONFIG.COLORS.TARGET, "pick", 0.8);
    return pick || null;
  },

  // Scan path to target and return first blocking wall / Invader rampart (PvE door)
  _firstBlockingDoorOnPath: function (creep, target) {
    if (!target) return null;
    var path = creep.room.findPath(creep.pos, target.pos, { maxOps: CONFIG.doorScanMaxOps, ignoreCreeps: true });
    if (!path || !path.length) return null;

    for (var i = 0; i < path.length; i++) {
      var step = path[i];
      var structs = creep.room.lookForAt(LOOK_STRUCTURES, step.x, step.y);
      for (var j = 0; j < structs.length; j++) {
        var st = structs[j];
        if (_isBashableDoor(st)) {
          return st;
        }
      }
    }
    return null;
  }
};

module.exports = roleDismantler;

// ---------------------
// Teaching helpers
// ---------------------
function _shouldDelayForDecoy(creep) {
  if (!creep.memory.delay) return false;
  if (Game.time >= creep.memory.delay) return false;
  hud(creep, "⏳ delay");
  return true;
}

function drawVitalsHud(creep) {
  hud(creep, "🪓 " + creep.hits + "/" + creep.hitsMax);
}

function _refreshTarget(creep) {
  var target = Game.getObjectById(creep.memory.tid);
  if (roleDismantler._isValidTarget(target)) return target;

  target = roleDismantler._pickNewTarget(creep);
  if (!target) {
    delete creep.memory.tid;
    return null;
  }
  creep.memory.tid = target.id;
  debugRing(target, CONFIG.COLORS.TARGET, "lock", 0.8);
  debugSay(creep, "🎯");
  return target;
}

function _drawCrossRoomAwareness(creep, target) {
  if (!target || !target.pos) return false;
  if (!target.room || !target.room.name) return false;
  if (!creep || !creep.room) return false;
  if (target.room.name === creep.room.name) return false;
  debugRing(target, CONFIG.COLORS.TARGET, "target", 0.8);
  return true;
}

function _rallyOrIdle(creep) {
  var rally = Game.flags.Rally || Game.flags.Attack;
  if (!rally) return;
  moveSmart(creep, rally, 1);
}

function _handleBlockingDoor(creep, target) {
  var door = roleDismantler._firstBlockingDoorOnPath(creep, target);
  if (!door) return false;

  debugRing(door, CONFIG.COLORS.DOOR, "door", 0.6);
  if (creep.pos.isNearTo(door)) {
    debugSay(creep, "🧱");
    var rc = creep.dismantle(door);
    if (rc === ERR_INVALID_TARGET && creep.getActiveBodyparts(ATTACK) > 0) {
      creep.attack(door);
    }
  } else {
    moveSmart(creep, door, 1);
  }
  return true;
}

function _handleInvaderCore(creep, target) {
  if (!_isInvaderCore(target)) return false;

  debugRing(target, CONFIG.COLORS.ATTACK, "core", 0.8);
  var inMelee = creep.pos.isNearTo(target);
  var range = creep.pos.getRangeTo(target);

  if (range <= 3 && creep.getActiveBodyparts(RANGED_ATTACK) > 0) {
    debugSay(creep, "🏹");
    creep.rangedAttack(target);
  }
  if (inMelee && creep.getActiveBodyparts(ATTACK) > 0) {
    debugLine(creep.pos, target.pos, CONFIG.COLORS.ATTACK, "⚔");
    creep.attack(target);
  }
  if (!inMelee) moveSmart(creep, target, 1);
  return true;
}

function _handleStructure(creep, target) {
  var inMelee = creep.pos.isNearTo(target);
  if (!inMelee) {
    moveSmart(creep, target, 1);
    return;
  }

  debugRing(target, CONFIG.COLORS.TARGET, target.structureType || "struct", 0.7);
  debugSay(creep, "🪓");
  var res = creep.dismantle(target);
  if (res === ERR_INVALID_TARGET && creep.getActiveBodyparts(ATTACK) > 0) {
    creep.attack(target);
  }
  if (target.hits && target.hits <= CONFIG.retargetThreshold) {
    delete creep.memory.tid;
  }
}
