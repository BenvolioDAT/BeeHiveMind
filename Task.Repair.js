// Task.Repair.js — with Debug_say & Debug_draw
var BeeToolbox = require('BeeToolbox');

// =============== Config ===============
var CFG = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,

  TRAVEL_REUSE: 16,

  COLORS: {
    PATH:  "#7ac7ff",
    REPAIR:"#2ad1c9",
    ENERGY:"#ffd480",
    TEXT:  "#e6e6e6"
  },
  WIDTH: 0.12,
  OPAC:  0.45,
  FONT:  0.7
});

// Optional log levels (kept from original)
var LOG_LEVEL = { NONE: 0, BASIC: 1, DEBUG: 2 };
var currentLogLevel = LOG_LEVEL.NONE;

// =============== Tiny Debug Helpers ===============
function _posOf(t){ return t && t.pos ? t.pos : t; }
function _roomOf(p){ return p && Game.rooms[p.roomName]; }

function debugSay(creep, msg){
  if (CFG.DEBUG_SAY && creep && typeof creep.say === 'function') creep.say(msg, true);
}
function debugLine(from, to, color, label){
  if (!CFG.DEBUG_DRAW || !from || !to) return;
  var f=_posOf(from), t=_posOf(to); if(!f||!t||f.roomName!==t.roomName) return;
  var R=_roomOf(f); if(!R||!R.visual) return;
  R.visual.line(f, t, { color: color, width: CFG.WIDTH, opacity: CFG.OPAC });
  if (label){
    var mx=(f.x+t.x)/2, my=(f.y+t.y)/2;
    R.visual.text(label, mx, my-0.25,
      { color: color, opacity: 0.95, font: CFG.FONT, align:"center",
        backgroundColor:"#000", backgroundOpacity:0.25 });
  }
}
function debugRing(target, color, text){
  if (!CFG.DEBUG_DRAW || !target) return;
  var p=_posOf(target); if(!p) return;
  var R=_roomOf(p); if(!R||!R.visual) return;
  R.visual.circle(p, { radius: 0.6, fill:"transparent", stroke: color, opacity: CFG.OPAC, width: CFG.WIDTH });
  if (text) R.visual.text(text, p.x, p.y-0.8, { color: color, font: CFG.FONT, opacity: 0.95, align:"center" });
}
function hud(creep, text){
  if (!CFG.DEBUG_DRAW) return;
  var R=creep.room; if(!R||!R.visual) return;
  R.visual.text(text, creep.pos.x, creep.pos.y-1.2, {
    color: CFG.COLORS.TEXT, font: CFG.FONT, opacity: 0.95, align: "center",
    backgroundColor:"#000", backgroundOpacity:0.25
  });
}

// =============== Travel Wrapper ===============
function go(creep, dest, range){
  var R = (range != null) ? range : 1;
  var dpos = _posOf(dest) || dest;
  if (creep.pos.roomName === dpos.roomName && creep.pos.getRangeTo(dpos) > R){
    debugLine(creep.pos, dpos, CFG.COLORS.PATH, "→");
  }
  if (creep.pos.getRangeTo(dpos) <= R) return OK;
  try {
    if (BeeToolbox && typeof BeeToolbox.BeeTravel === 'function'){
      return BeeToolbox.BeeTravel(creep, dpos, { range: R, reusePath: CFG.TRAVEL_REUSE });
    }
  } catch(e){}
  if (typeof creep.travelTo === 'function'){
    return creep.travelTo(dpos, { range: R, reusePath: CFG.TRAVEL_REUSE, ignoreCreeps: false, maxOps: 4000 });
  }
  return creep.moveTo(dpos, { reusePath: CFG.TRAVEL_REUSE, maxOps: 1500 });
}

// =============== Safe Memory Accessors ===============
function getRepairQueue(room){
  Memory.rooms = Memory.rooms || {};
  Memory.rooms[room.name] = Memory.rooms[room.name] || {};
  var rm = Memory.rooms[room.name];
  rm.repairTargets = Array.isArray(rm.repairTargets) ? rm.repairTargets : [];
  return rm.repairTargets;
}
function popInvalidHead(room){
  var q = getRepairQueue(room);
  if (!q.length) return null;
  var head = q[0];
  if (!head || !head.id) { q.shift(); return null; }
  var obj = Game.getObjectById(head.id);
  if (!obj || !obj.hits || obj.hits >= obj.hitsMax){ q.shift(); return null; }
  return obj;
}

// =============== Energy Sourcing ===============
function findDroppedEnergy(creep){
  return creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
    filter: function(r){ return r.resourceType === RESOURCE_ENERGY && (r.amount|0) > 0; }
  });
}
function findWithdrawSource(creep){
  return creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: function(s){
      if (!s.store) return false;
      var t = s.structureType;
      if (t !== STRUCTURE_CONTAINER && t !== STRUCTURE_EXTENSION && t !== STRUCTURE_SPAWN) return false;
      return (s.store[RESOURCE_ENERGY] | 0) > 0;
    }
  });
}

// =============== Main Role ===============
var TaskRepair = {
  run: function(creep){
    // Status HUD
    var e = creep.store[RESOURCE_ENERGY] | 0;
    hud(creep, "🔧 " + e + "/" + creep.store.getCapacity(RESOURCE_ENERGY));

    if ((creep.store[RESOURCE_ENERGY] | 0) > 0){
      // — Have energy: repair flow —
      var target = popInvalidHead(creep.room);
      if (!target){
        // queue empty or invalid → clear task (caller can reassign)
        if (currentLogLevel >= LOG_LEVEL.BASIC) {}
        creep.memory.task = undefined;
        debugSay(creep, "✅ done");
        return;
      }

      // Visuals for the target
      creep.room.visual.text(
        "Repair " + target.structureType + " " + target.hits + "/" + target.hitsMax,
        target.pos.x, target.pos.y - 1,
        { align: 'center', color: '#ffffff', opacity: 0.9 }
      );
      debugRing(target, CFG.COLORS.REPAIR, "fix");

      // Attempt repair
      var rr = creep.repair(target);
      if (rr === OK){
        if (currentLogLevel >= LOG_LEVEL.DEBUG){
          console.log("Creep "+creep.name+" repairing "+target.structureType+" @("+target.pos.x+","+target.pos.y+")");
        }
        debugSay(creep, "🔧");
        // Done? pop and move on
        if (target.hits >= target.hitsMax){
          getRepairQueue(creep.room).shift();
          debugSay(creep, "✔");
        }
        return;
      }
      if (rr === ERR_NOT_IN_RANGE){
        debugLine(creep, target, CFG.COLORS.REPAIR, "to repair");
        go(creep, target, 3);
        return;
      }

      // Other errors → log & skip this target
      if (currentLogLevel >= LOG_LEVEL.DEBUG){
        console.log("Repair error for "+creep.name+": "+rr);
      }
      getRepairQueue(creep.room).shift();
      return;
    }

    // — No energy: acquire —
    var pile = findDroppedEnergy(creep);
    if (pile){
      debugRing(pile, CFG.COLORS.ENERGY, "💧"+(pile.amount|0));
      debugLine(creep, pile, CFG.COLORS.ENERGY, "pickup");
      var pr = creep.pickup(pile);
      if (pr === ERR_NOT_IN_RANGE) go(creep, pile, 1);
      else if (pr === OK) debugSay(creep, "💼");
      return;
    }

    var source = findWithdrawSource(creep);
    if (source){
      debugRing(source, CFG.COLORS.ENERGY, "ENERGY");
      debugLine(creep, source, CFG.COLORS.ENERGY, "withdraw");
      var wr = creep.withdraw(source, RESOURCE_ENERGY);
      if (wr === ERR_NOT_IN_RANGE) go(creep, source, 1);
      else if (wr === OK) debugSay(creep, "⛽");
      return;
    }

    if (currentLogLevel >= LOG_LEVEL.DEBUG){
      console.log("No available energy source for "+creep.name);
    }
    debugSay(creep, "😮‍💨");
  }
};

module.exports = TaskRepair;
