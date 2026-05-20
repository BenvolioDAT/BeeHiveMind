'use strict';

// Repair behavior implementation only. Public role wiring stays in role.Repair.js.
var BeeToolbox = require('BeeToolbox');
var CFG = require('role.Repair.Config');
var CoreConfig = require('core.config');

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
function getMyUsernameForRepair(){
  for (var name in Game.spawns) {
    if (!Object.prototype.hasOwnProperty.call(Game.spawns, name)) continue;
    var spawn = Game.spawns[name];
    if (spawn && spawn.owner && spawn.owner.username) return spawn.owner.username;
  }
  return null;
}
function isRoomUnsafeForRemoteRepair(roomName, homeRoom){
  if (!roomName || roomName === homeRoom) return false;
  var myName = getMyUsernameForRepair();
  var mem = Memory.rooms && Memory.rooms[roomName];
  if (mem) {
    if (mem.hostile) return true;
    if (typeof mem.lunaBlockedUntil === 'number' && mem.lunaBlockedUntil > Game.time) return true;
    if (mem._invaderLock && mem._invaderLock.locked) {
      var lockTick = (typeof mem._invaderLock.t === 'number') ? mem._invaderLock.t : null;
      if (lockTick == null || (Game.time - lockTick) <= 1500) return true;
    }
    if (mem.intel) {
      var intel = mem.intel;
      if (intel.owner && (!myName || intel.owner !== myName)) return true;
      if (intel.reservation && (!myName || intel.reservation !== myName)) return true;
    }
  }
  var room = Game.rooms[roomName];
  if (room) {
    var hostiles = room.find(FIND_HOSTILE_CREEPS);
    if (hostiles && hostiles.length > 0) return true;
    if (room.controller) {
      var owner = room.controller.owner && room.controller.owner.username;
      var reserver = room.controller.reservation && room.controller.reservation.username;
      if (owner && (!myName || owner !== myName)) return true;
      if (reserver && (!myName || reserver !== myName)) return true;
    }
  }
  return false;
}
function getRemoteHaulRequestById(id){
  var root = Memory.__BHM && Memory.__BHM.remoteHaulRequests;
  if (!root || !id) return null;
  return root[id] || null;
}
function getRemoteContainerStatusById(id){
  var root = Memory.__BHM && Memory.__BHM.remoteContainerStatus;
  if (!root || !id) return null;
  return root[id] || null;
}
function getRepairGoalHits(target, targetInfo){
  if (!target || typeof target.hitsMax !== 'number') return 0;
  var maint = CoreConfig && CoreConfig.settings && CoreConfig.settings.maintenance ? CoreConfig.settings.maintenance : {};
  var maxRampart = maint.repairMaxRampart || 30000;
  var maxWall = maint.repairMaxWall || 30000;
  if (targetInfo && typeof targetInfo.repairGoalHits === 'number' && targetInfo.repairGoalHits > 0) {
    return Math.min(target.hitsMax, targetInfo.repairGoalHits);
  }
  if (target.structureType === STRUCTURE_RAMPART) return Math.min(target.hitsMax, maxRampart);
  if (target.structureType === STRUCTURE_WALL) return Math.min(target.hitsMax, maxWall);
  return target.hitsMax;
}
function clearRemoteTask(creep){
  if (!creep || !creep.memory) return;
  delete creep.memory.task;
  delete creep.memory.targetRoom;
  delete creep.memory.containerId;
  delete creep.memory.sourceId;
  delete creep.memory.requestId;
  delete creep.memory.x;
  delete creep.memory.y;
  delete creep.memory.remoteRepairMissingTicks;
  delete creep.memory.remoteRepairReturningHome;
}
function runRemoteContainerEmergencyRepair(creep){
  if (!creep || !creep.memory) return;
  var home = creep.memory.home || Memory.firstSpawnRoom || creep.room.name;
  creep.memory.home = home;
  var stopPct = CFG.remoteContainerEmergencyRepairStopPct || 0.85;
  var holdTicks = CFG.remoteContainerEmergencyRepairHoldTicks || 50;
  var minContainerEnergy = CFG.remoteContainerEmergencyRepairMinContainerEnergy || 100;
  var withdrawAmount = CFG.remoteContainerEmergencyRepairWithdrawAmount || 100;

  if (creep.memory.remoteRepairReturningHome === true) {
    if (creep.room.name !== home) {
      go(creep, new RoomPosition(25, 25, home), 20);
      return;
    }
    clearRemoteTask(creep);
    return;
  }

  var container = creep.memory.containerId ? Game.getObjectById(creep.memory.containerId) : null;
  if (!container) {
    if (creep.room.name === creep.memory.targetRoom) {
      creep.memory.remoteRepairMissingTicks = (creep.memory.remoteRepairMissingTicks || 0) + 1;
      if (creep.memory.remoteRepairMissingTicks >= 25) {
        creep.memory.remoteRepairReturningHome = true;
      }
    } else {
      creep.memory.remoteRepairMissingTicks = 0;
    }
    var tx = creep.memory.x;
    var ty = creep.memory.y;
    var tr = creep.memory.targetRoom;
    if (tr && typeof tx === 'number' && typeof ty === 'number') {
      go(creep, new RoomPosition(tx, ty, tr), 1);
    }
    return;
  }
  creep.memory.remoteRepairMissingTicks = 0;

  var hitsPct = container.hitsMax > 0 ? (container.hits / container.hitsMax) : 1;
  if (hitsPct >= stopPct) {
    if (creep.room.name !== home) {
      creep.memory.remoteRepairReturningHome = true;
      go(creep, new RoomPosition(25, 25, home), 20);
      return;
    }
    clearRemoteTask(creep);
    return;
  }

  var req = getRemoteHaulRequestById(creep.memory.requestId || container.id);
  var status = getRemoteContainerStatusById(container.id);
  if (req) {
    req.maintenanceUntil = Game.time + holdTicks;
    req.maintenanceBy = creep.name;
    req.maintenanceReason = 'emergencyRemoteRepair';
  }
  if (status) {
    status.maintenanceUntil = Game.time + holdTicks;
    status.maintenanceBy = creep.name;
    status.maintenanceReason = 'emergencyRemoteRepair';
  }

  var energy = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
  if (energy > 0) {
    var rr = creep.repair(container);
    if (rr === ERR_NOT_IN_RANGE) go(creep, container, 3);
    return;
  }

  var available = (container.store && container.store[RESOURCE_ENERGY]) || 0;
  var spare = Math.max(0, available - minContainerEnergy);
  var need = Math.min(withdrawAmount, creep.store.getFreeCapacity(RESOURCE_ENERGY), spare);
  if (need > 0) {
    var wr = creep.withdraw(container, RESOURCE_ENERGY, need);
    if (wr === ERR_NOT_IN_RANGE) go(creep, container, 1);
    return;
  }

  var source = creep.memory.sourceId ? Game.getObjectById(creep.memory.sourceId) : null;
  if (source) {
    var hr = creep.harvest(source);
    if (hr === ERR_NOT_IN_RANGE) go(creep, source, 1);
    return;
  }

  if (creep.room.name === home) {
    var localSource = findWithdrawSource(creep);
    if (localSource) {
      var lwr = creep.withdraw(localSource, RESOURCE_ENERGY);
      if (lwr === ERR_NOT_IN_RANGE) go(creep, localSource, 1);
      return;
    }
  }

  if (creep.room.name !== home) go(creep, new RoomPosition(25, 25, home), 20);
}


function ensureRepairClaimsMemory(){
  Memory.__BHM = Memory.__BHM || {};
  Memory.__BHM.repairClaims = Memory.__BHM.repairClaims || {};
  return Memory.__BHM.repairClaims;
}
function cleanupRepairClaims(){
  var claims = ensureRepairClaimsMemory();
  for (var targetId in claims){
    if (!Object.prototype.hasOwnProperty.call(claims, targetId)) continue;
    var c = claims[targetId];
    if (!c || c.until <= Game.time || !Game.creeps[c.creepName]) delete claims[targetId];
  }
}
function isRepairTargetClaimedByOther(creep, targetId){
  var claims = ensureRepairClaimsMemory();
  var c = claims[targetId];
  if (!c) return false;
  if (c.until <= Game.time) { delete claims[targetId]; return false; }
  return c.creepName !== creep.name && Game.creeps[c.creepName];
}
function claimRepairTarget(creep, targetInfo){
  if (!creep || !targetInfo || !targetInfo.id) return;
  var claims = ensureRepairClaimsMemory();
  claims[targetInfo.id] = { creepName: creep.name, until: Game.time + 15, roomName: targetInfo.roomName, targetType: targetInfo.type };
  creep.memory.repairTargetId = targetInfo.id;
  creep.memory.repairTargetInfo = targetInfo;
  // This claim tells other Repair creeps: I am already handling this target, please pick another one.
}
function releaseRepairTarget(creep){
  var claims = ensureRepairClaimsMemory();
  var id = creep.memory && creep.memory.repairTargetId;
  if (id && claims[id] && claims[id].creepName === creep.name) delete claims[id];
  if (creep.memory){ delete creep.memory.repairTargetId; delete creep.memory.repairTargetInfo; }
}
function getLocalTargets(creep){
  Memory.rooms = Memory.rooms || {}; var rm = Memory.rooms[creep.room.name] || {};
  var queue = Array.isArray(rm.repairTargets) ? rm.repairTargets : [];
  var out = [];
  for (var i=0;i<queue.length;i++){
    var t = queue[i]; if (!t || !t.id) continue;
    var obj = Game.getObjectById(t.id);
    if (!obj || typeof obj.hits !== 'number' || typeof obj.hitsMax !== 'number' || obj.hitsMax <= 0) continue;
    if (obj.hits >= obj.hitsMax) continue;
    var repairGoalHits = getRepairGoalHits(obj, t);
    if (obj.hits >= repairGoalHits) continue;
    var hitsPct = obj.hits / obj.hitsMax;
    out.push({id:t.id, roomName:obj.pos.roomName, x:obj.pos.x, y:obj.pos.y, type:obj.structureType, priority:t.priority, hitsPct:hitsPct, repairGoalHits:repairGoalHits});
  }
  return out;
}
function getRemoteContainerTargets(creep){
  var out = []; var home = creep.memory.home || Memory.firstSpawnRoom || creep.room.name;
  var root = Memory.__BHM && Memory.__BHM.remoteContainerStatus;
  if (!root) return out;
  for (var id in root){
    if (!Object.prototype.hasOwnProperty.call(root,id)) continue;
    var r = root[id]; if (!r || r.homeRoom !== home) continue;
    if (typeof r.containerHitsPct !== 'number' || r.containerHitsPct > 0.75) continue;
    var targetRoom = r.remoteRoom || r.roomName;
    if (isRoomUnsafeForRemoteRepair(targetRoom, home)) continue;
    out.push({id:id, roomName:targetRoom, x:r.x, y:r.y, type:STRUCTURE_CONTAINER, priority:0, hitsPct:r.containerHitsPct, sourceId:r.sourceId || null});
  }
  return out;
}
function getBestRepairTargetForCreep(creep){
  cleanupRepairClaims();
  var candidates = getLocalTargets(creep).concat(getRemoteContainerTargets(creep));
  var nonRoad = []; var roads = [];
  for (var i=0;i<candidates.length;i++){
    var c=candidates[i];
    if (isRepairTargetClaimedByOther(creep, c.id)) continue;
    if (c.type === STRUCTURE_ROAD) roads.push(c); else nonRoad.push(c);
  }
  var list = nonRoad.length ? nonRoad : roads;
  if (!list.length) return null;
  list.sort(function(a,b){ var pa=(a.priority!=null)?a.priority:50; var pb=(b.priority!=null)?b.priority:50; if (pa!==pb) return pa-pb; return (a.hitsPct||1)-(b.hitsPct||1); });
  return list[0];
}

function run(creep){
  if (!creep) return;
  if (creep.memory && !creep.memory.role) creep.memory.role = 'Repair';
  if (creep.memory && creep.memory.task === 'remoteContainerEmergencyRepair') {
    return runRemoteContainerEmergencyRepair(creep);
  }
  var e = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
  hud(creep, "🔧 " + e + "/" + creep.store.getCapacity(RESOURCE_ENERGY));

  if (e <= 0) {
    var activeTarget = creep.memory.repairTargetInfo || null;
    var home = creep.memory.home || Memory.firstSpawnRoom || creep.room.name;
    if (activeTarget && activeTarget.roomName && isRoomUnsafeForRemoteRepair(activeTarget.roomName, home)) {
      releaseRepairTarget(creep);
      if (creep.room.name !== home) go(creep, new RoomPosition(25, 25, home), 20);
      return;
    }
    if (activeTarget && activeTarget.roomName && activeTarget.roomName !== creep.room.name) {
      go(creep, new RoomPosition(25, 25, activeTarget.roomName), 20);
      claimRepairTarget(creep, activeTarget);
      return;
    }
    if (activeTarget && activeTarget.type === STRUCTURE_CONTAINER) {
      var targetContainer = activeTarget.id ? Game.getObjectById(activeTarget.id) : null;
      if (!targetContainer && activeTarget.roomName && typeof activeTarget.x === 'number' && typeof activeTarget.y === 'number') {
        go(creep, new RoomPosition(activeTarget.x, activeTarget.y, activeTarget.roomName), 1);
        claimRepairTarget(creep, activeTarget);
        return;
      }
      if (targetContainer && targetContainer.store && (targetContainer.store[RESOURCE_ENERGY] || 0) > 0) {
        var wrt = creep.withdraw(targetContainer, RESOURCE_ENERGY);
        if (wrt === ERR_NOT_IN_RANGE) go(creep, targetContainer, 1);
        claimRepairTarget(creep, activeTarget);
        return;
      }
      if (activeTarget.sourceId) {
        var emergencySource = Game.getObjectById(activeTarget.sourceId);
        if (emergencySource) {
          var hr = creep.harvest(emergencySource);
          if (hr === ERR_NOT_IN_RANGE) go(creep, emergencySource, 1);
          claimRepairTarget(creep, activeTarget);
          return;
        }
      }
      releaseRepairTarget(creep);
      if (creep.room.name !== home) {
        go(creep, new RoomPosition(25, 25, home), 20);
        return;
      }
    }
    var pile = findDroppedEnergy(creep);
    if (pile){ debugRing(pile, CFG.COLORS.ENERGY, "💧"+(pile.amount || 0)); debugLine(creep, pile, CFG.COLORS.ENERGY, "pickup"); var pr = creep.pickup(pile); if (pr === ERR_NOT_IN_RANGE) go(creep, pile, 1); else if (pr === OK) debugSay(creep, "💼"); return; }
    var source = findWithdrawSource(creep);
    if (source){ debugRing(source, CFG.COLORS.ENERGY, "ENERGY"); debugLine(creep, source, CFG.COLORS.ENERGY, "withdraw"); var wr = creep.withdraw(source, RESOURCE_ENERGY); if (wr === ERR_NOT_IN_RANGE) go(creep, source, 1); else if (wr === OK) debugSay(creep, "⛽"); return; }
    if (CFG.CURRENT_LOG_LEVEL >= CFG.LOG_LEVEL.DEBUG) console.log("No available energy source for "+creep.name);
    debugSay(creep, "‍💨");
    return;
  }

  var targetInfo = creep.memory.repairTargetInfo || null;
  var needsRefresh = !targetInfo || (Game.time % 5 === 0) || (targetInfo && targetInfo.type === STRUCTURE_ROAD);
  if (needsRefresh) {
    var better = getBestRepairTargetForCreep(creep);
    if (!targetInfo) {
      targetInfo = better;
    } else if (targetInfo.type === STRUCTURE_ROAD && better && better.type !== STRUCTURE_ROAD) {
      releaseRepairTarget(creep);
      targetInfo = better;
    } else if (!better) {
      targetInfo = null;
    }
  }
  if (!targetInfo){ releaseRepairTarget(creep); if (creep.memory) creep.memory.task = undefined; debugSay(creep, "✅ done"); return; }
  var homeRoom = creep.memory.home || Memory.firstSpawnRoom || creep.room.name;
  if (targetInfo.roomName && isRoomUnsafeForRemoteRepair(targetInfo.roomName, homeRoom)) {
    releaseRepairTarget(creep);
    if (creep.room.name !== homeRoom) go(creep, new RoomPosition(25, 25, homeRoom), 20);
    return;
  }
  if (!creep.memory.repairTargetId || creep.memory.repairTargetId !== targetInfo.id) {
    releaseRepairTarget(creep);
    claimRepairTarget(creep, targetInfo);
  } else {
    claimRepairTarget(creep, targetInfo);
  }

  var target = Game.getObjectById(targetInfo.id);
  if (!target) {
    if (targetInfo.roomName && typeof targetInfo.x === 'number' && typeof targetInfo.y === 'number') {
      go(creep, new RoomPosition(targetInfo.x, targetInfo.y, targetInfo.roomName), 1);
      return;
    }
    releaseRepairTarget(creep);
    return;
  }

  creep.room.visual.text("Repair " + target.structureType + " " + target.hits + "/" + target.hitsMax, target.pos.x, target.pos.y - 1, { align: 'center', color: '#ffffff', opacity: 0.9 });
  debugRing(target, CFG.COLORS.REPAIR, "fix");

  var goalHits = getRepairGoalHits(target, targetInfo);
  if (target.hits >= goalHits){
    releaseRepairTarget(creep);
    debugSay(creep, "✔");
    return;
  }
  var rr = creep.repair(target);
  if (rr === OK){
    debugSay(creep, "🔧");
    claimRepairTarget(creep, targetInfo);
    if (target.hits >= goalHits){ releaseRepairTarget(creep); debugSay(creep, "✔"); }
    return;
  }
  if (rr === ERR_NOT_IN_RANGE){ claimRepairTarget(creep, targetInfo); debugLine(creep, target, CFG.COLORS.REPAIR, "to repair"); go(creep, target, 3); return; }
  releaseRepairTarget(creep);
}

module.exports = { run: run };
