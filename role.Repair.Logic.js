'use strict';

// Repair behavior implementation only. Public role wiring stays in role.Repair.js.
var BeeToolbox = require('BeeToolbox');
var CFG = require('role.Repair.Config');

function _posOf(t){ return t && t.pos ? t.pos : t; }
function _roomOf(p){ return p && Game.rooms[p.roomName]; }

function debugSay(creep, msg){ if (CFG.DEBUG_SAY && creep && typeof creep.say === 'function') creep.say(msg, true); }
function debugLine(from, to, color, label){
  if (!CFG.DEBUG_DRAW || !from || !to) return;
  var f=_posOf(from), t=_posOf(to); if(!f||!t||f.roomName!==t.roomName) return;
  var R=_roomOf(f); if(!R||!R.visual) return;
  R.visual.line(f, t, { color: color, width: CFG.WIDTH, opacity: CFG.OPACITY });
  if (label){
    var mx=(f.x+t.x)/2, my=(f.y+t.y)/2;
    R.visual.text(label, mx, my-0.25, { color: color, opacity: 0.95, font: CFG.FONT, align:"center", backgroundColor:"#000", backgroundOpacity:0.25 });
  }
}
function debugRing(target, color, text){
  if (!CFG.DEBUG_DRAW || !target) return;
  var p=_posOf(target); if(!p) return;
  var R=_roomOf(p); if(!R||!R.visual) return;
  R.visual.circle(p, { radius: 0.6, fill:"transparent", stroke: color, opacity: CFG.OPACITY, width: CFG.WIDTH });
  if (text) R.visual.text(text, p.x, p.y-0.8, { color: color, font: CFG.FONT, opacity: 0.95, align:"center" });
}
function hud(creep, text){
  if (!CFG.DEBUG_DRAW) return;
  var R=creep.room; if(!R||!R.visual) return;
  R.visual.text(text, creep.pos.x, creep.pos.y-1.2, { color: CFG.COLORS.TEXT, font: CFG.FONT, opacity: 0.95, align: "center", backgroundColor:"#000", backgroundOpacity:0.25 });
}

function go(creep, dest, range){
  var R = (range != null) ? range : 1;
  var dpos = _posOf(dest) || dest;
  if (creep.pos.roomName === dpos.roomName && creep.pos.getRangeTo(dpos) > R) debugLine(creep.pos, dpos, CFG.COLORS.PATH, "→");
  if (creep.pos.getRangeTo(dpos) <= R) return OK;
  try {
    if (BeeToolbox && typeof BeeToolbox.BeeTravel === 'function') return BeeToolbox.BeeTravel(creep, dpos, { range: R, reusePath: CFG.TRAVEL_REUSE });
  } catch(e){}
  if (typeof creep.travelTo === 'function') return creep.travelTo(dpos, { range: R, reusePath: CFG.TRAVEL_REUSE, ignoreCreeps: false, maxOps: 4000 });
  return creep.moveTo(dpos, { reusePath: CFG.TRAVEL_REUSE, maxOps: 1500 });
}

function getRepairQueue(room){ Memory.rooms = Memory.rooms || {}; Memory.rooms[room.name] = Memory.rooms[room.name] || {}; var rm = Memory.rooms[room.name]; rm.repairTargets = Array.isArray(rm.repairTargets) ? rm.repairTargets : []; return rm.repairTargets; }
function getNextRepairTarget(queue){ while (queue.length){ var head = queue[0]; if (!head || !head.id){ queue.shift(); continue; } var obj = Game.getObjectById(head.id); if (!obj || !obj.hits || obj.hits >= obj.hitsMax){ queue.shift(); continue; } return obj; } return null; }
function findDroppedEnergy(creep){ return creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, { filter: function(r){ return r.resourceType === RESOURCE_ENERGY && (r.amount || 0) > 0; } }); }
function findWithdrawSource(creep){ return creep.pos.findClosestByPath(FIND_STRUCTURES, { filter: function(s){ if (!s.store) return false; var t = s.structureType; if (t !== STRUCTURE_CONTAINER && t !== STRUCTURE_EXTENSION && t !== STRUCTURE_SPAWN) return false; return (s.store[RESOURCE_ENERGY] || 0) > 0; } }); }

function run(creep){
  if (!creep) return;
  if (creep.memory && !creep.memory.role) creep.memory.role = 'Repair';
  var e = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
  hud(creep, "🔧 " + e + "/" + creep.store.getCapacity(RESOURCE_ENERGY));

  if (e <= 0) {
    var pile = findDroppedEnergy(creep);
    if (pile){ debugRing(pile, CFG.COLORS.ENERGY, "💧"+(pile.amount || 0)); debugLine(creep, pile, CFG.COLORS.ENERGY, "pickup"); var pr = creep.pickup(pile); if (pr === ERR_NOT_IN_RANGE) go(creep, pile, 1); else if (pr === OK) debugSay(creep, "💼"); return; }
    var source = findWithdrawSource(creep);
    if (source){ debugRing(source, CFG.COLORS.ENERGY, "ENERGY"); debugLine(creep, source, CFG.COLORS.ENERGY, "withdraw"); var wr = creep.withdraw(source, RESOURCE_ENERGY); if (wr === ERR_NOT_IN_RANGE) go(creep, source, 1); else if (wr === OK) debugSay(creep, "⛽"); return; }
    if (CFG.CURRENT_LOG_LEVEL >= CFG.LOG_LEVEL.DEBUG) console.log("No available energy source for "+creep.name);
    debugSay(creep, "‍💨");
    return;
  }

  var queue = getRepairQueue(creep.room);
  var target = getNextRepairTarget(queue);
  if (!target){ if (creep.memory) creep.memory.task = undefined; debugSay(creep, "✅ done"); return; }

  creep.room.visual.text("Repair " + target.structureType + " " + target.hits + "/" + target.hitsMax, target.pos.x, target.pos.y - 1, { align: 'center', color: '#ffffff', opacity: 0.9 });
  debugRing(target, CFG.COLORS.REPAIR, "fix");

  var rr = creep.repair(target);
  if (rr === OK){ if (CFG.CURRENT_LOG_LEVEL >= CFG.LOG_LEVEL.DEBUG) console.log("Creep "+creep.name+" repairing "+target.structureType+" @("+target.pos.x+","+target.pos.y+")"); debugSay(creep, "🔧"); if (target.hits >= target.hitsMax){ queue.shift(); debugSay(creep, "✔"); } return; }
  if (rr === ERR_NOT_IN_RANGE){ debugLine(creep, target, CFG.COLORS.REPAIR, "to repair"); go(creep, target, 3); return; }
  if (CFG.CURRENT_LOG_LEVEL >= CFG.LOG_LEVEL.DEBUG) console.log("Repair error for "+creep.name+": "+rr);
  queue.shift();
}

module.exports = { run: run };
