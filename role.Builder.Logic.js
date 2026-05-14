'use strict';

// Builder behavior implementation only. Public role wiring stays in role.Builder.js.
var CFG = require('role.Builder.Config');
var Handoff = require('role.EnergyHandoff');

function debugSay(creep, msg) { if (CFG.DEBUG_SAY && creep && msg) creep.say(msg, true); }
function getTargetPosition(target) { if (!target) return null; if (target.pos) return target.pos; if (target.x != null && target.y != null && target.roomName) return target; return null; }
function debugDrawLine(creep, target, color, label) { if (!CFG.DEBUG_DRAW || !creep || !target) return; var room = creep.room; if (!room || !room.visual) return; var tpos = getTargetPosition(target); if (!tpos || tpos.roomName !== room.name) return; try { room.visual.line(creep.pos, tpos, { color: color, width: CFG.DRAW.WIDTH, opacity: CFG.DRAW.OPACITY, lineStyle: "solid" }); if (label) room.visual.text(label, tpos.x, tpos.y - 0.3, { color: color, opacity: CFG.DRAW.OPACITY, font: CFG.DRAW.FONT, align: "center" }); } catch (e) {} }
function debugRing(room, pos, color, text) { if (!CFG.DEBUG_DRAW || !room || !room.visual || !pos) return; try { room.visual.circle(pos, { radius: 0.5, fill: "transparent", stroke: color, opacity: CFG.DRAW.OPACITY, width: CFG.DRAW.WIDTH}); if (text) room.visual.text(text, pos.x, pos.y - 0.6, { color: color, font: CFG.DRAW.FONT, opacity: CFG.DRAW.OPACITY, align:"center" }); } catch (e) {} }

function ensureBuilderIdentity(creep) { if (!creep || !creep.memory) return; creep.memory.role = 'Builder'; if (!creep.memory.task) creep.memory.task = 'builder'; }
function needsEnergy(creep) { var stored = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0; return stored === 0; }
function setBuilderState(creep, state) { creep.memory.builderState = state; }
function getBuilderState(creep) { if (!creep.memory.builderState) setBuilderState(creep, CFG.BUILDER_STATES.HARVEST); return creep.memory.builderState; }

function collectEnergy(creep) {
  var homeName = (typeof getHomeName === 'function') ? getHomeName(creep) : null;
  var homeRoom = homeName ? Game.rooms[homeName] : null;
  var homeStorage = homeRoom ? homeRoom.storage : null;
  var homeTerminal = homeRoom ? homeRoom.terminal : null;
  var homeEnergy = 0;
  if (homeStorage && homeStorage.store) homeEnergy += homeStorage.store[RESOURCE_ENERGY] || 0;
  if (homeTerminal && homeTerminal.store) homeEnergy += homeTerminal.store[RESOURCE_ENERGY] || 0;

  var homeIsRich = homeEnergy >= CFG.HOME_RICH_ENERGY;
  var homeIsLow = homeEnergy <= CFG.HOME_LOW_ENERGY;

  if (homeIsRich && homeName) {
    if (!homeRoom || creep.pos.roomName !== homeName) {
      var anchorPos = (typeof getAnchorPos === 'function') ? getAnchorPos(homeName) : null;
      if (anchorPos) { debugSay(creep, '🏠'); debugDrawLine(creep, anchorPos, CFG.DRAW.IDLE_COLOR, "HOME•ENERGY"); creep.travelTo(anchorPos, { range: 2, reusePath: 25 }); return true; }
    } else {
      var withdrawTarget = null;
      if (homeStorage && (homeStorage.store[RESOURCE_ENERGY] || 0) > 0) withdrawTarget = homeStorage;
      else if (homeTerminal && (homeTerminal.store[RESOURCE_ENERGY] || 0) > 0) withdrawTarget = homeTerminal;
      if (withdrawTarget) { debugSay(creep, '🏦'); debugDrawLine(creep, withdrawTarget, CFG.DRAW.FILL_COLOR, "HOME•WITHDRAW"); var homeWithdraw = creep.withdraw(withdrawTarget, RESOURCE_ENERGY); if (homeWithdraw === ERR_NOT_IN_RANGE) creep.travelTo(withdrawTarget, { range: 1, reusePath: 15 }); return true; }
    }
  }

  var tomb = creep.pos.findClosestByRange(FIND_TOMBSTONES, { filter: function (t) { var energy = t.store[RESOURCE_ENERGY] || 0; return energy > 0; } });
  if (tomb) { debugSay(creep, '🪦'); debugDrawLine(creep, tomb, CFG.DRAW.GRAVE_COLOR, "TOMB"); var tr = creep.withdraw(tomb, RESOURCE_ENERGY); if (tr === ERR_NOT_IN_RANGE) creep.travelTo(tomb, { range: 1, reusePath: 20 }); return true; }

  var ruin = creep.pos.findClosestByRange(FIND_RUINS, { filter: function (r) { var energy = r.store[RESOURCE_ENERGY] || 0; return energy > 0; } });
  if (ruin) { debugSay(creep, '🏚️'); debugDrawLine(creep, ruin, CFG.DRAW.GRAVE_COLOR, "RUIN"); var rr = creep.withdraw(ruin, RESOURCE_ENERGY); if (rr === ERR_NOT_IN_RANGE) creep.travelTo(ruin, { range: 1, reusePath: 20 }); return true; }

  var dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, { filter: function (r) { var amount = r.amount || 0; return r.resourceType === RESOURCE_ENERGY && amount >= CFG.PICKUP_MIN; } });
  if (dropped) { debugSay(creep, '🍪'); debugDrawLine(creep, dropped, CFG.DRAW.DROP_COLOR, "DROP"); if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) creep.travelTo(dropped, { range: 1, reusePath: 15 }); return true; }

  var srcCont = creep.pos.findClosestByRange(FIND_STRUCTURES, { filter: function (s) { if (s.structureType !== STRUCTURE_CONTAINER || !s.store) return false; if (s.pos.findInRange(FIND_SOURCES, 1).length === 0) return false; var energy = s.store[RESOURCE_ENERGY] || 0; return energy >= CFG.SRC_CONTAINER_MIN; } });
  if (srcCont) { debugSay(creep, '📦'); debugDrawLine(creep, srcCont, CFG.DRAW.FILL_COLOR, "SRC•CONT"); var cr = creep.withdraw(srcCont, RESOURCE_ENERGY); if (cr === ERR_NOT_IN_RANGE) creep.travelTo(srcCont, { range: 1, reusePath: 25 }); return true; }

  var storeLike = creep.pos.findClosestByRange(FIND_STRUCTURES, { filter: function (s) { if (!s.store) return false; var t = s.structureType; if (t !== STRUCTURE_CONTAINER && t !== STRUCTURE_LINK && t !== STRUCTURE_STORAGE && t !== STRUCTURE_TERMINAL) return false; var energy = s.store[RESOURCE_ENERGY] || 0; return energy > 0; } });
  if (storeLike) { debugSay(creep, '🏦'); debugDrawLine(creep, storeLike, CFG.DRAW.FILL_COLOR, "WITHDRAW"); var sr = creep.withdraw(storeLike, RESOURCE_ENERGY); if (sr === ERR_NOT_IN_RANGE) creep.travelTo(storeLike, { range: 1, reusePath: 25 }); return true; }

  if (CFG.ALLOW_HARVEST_FALLBACK || homeIsLow) {
    var src = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
    if (src) { debugSay(creep, '⛏️'); debugDrawLine(creep, src, CFG.DRAW.SOURCE, "MINE"); var hr = creep.harvest(src); if (hr === ERR_NOT_IN_RANGE) creep.travelTo(src, { range: 1, reusePath: 20 }); return true; }
  }

  if (typeof getHomeName === 'function' && typeof getAnchorPos === 'function') {
    var homeName2 = getHomeName(creep);
    if (homeName2 && creep.pos.roomName !== homeName2) {
      var anchorPos2 = getAnchorPos(homeName2);
      if (anchorPos2) { debugSay(creep, '🏠'); debugDrawLine(creep, anchorPos2, CFG.DRAW.IDLE_COLOR, "HOME"); creep.travelTo(anchorPos2, { range: 2, reusePath: 25 }); return true; }
    }
  }

  idleNearAnchor(creep);
  return false;
}

function idleNearAnchor(creep) { var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS) || creep.pos; if (anchor && anchor.pos) { debugSay(creep, '🧘'); debugDrawLine(creep, anchor, CFG.DRAW.IDLE_COLOR, "IDLE"); creep.travelTo(anchor, { range: 2, reusePath: 20 }); } }
function dumpEnergyToSink(creep) { var carried = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0; if (carried <= 0) return false; var sink = creep.pos.findClosestByRange(FIND_STRUCTURES, { filter: function (s) { if (!s.store) return false; var free = s.store.getFreeCapacity(RESOURCE_ENERGY) || 0; return free > 0 && (s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_TERMINAL || s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION || s.structureType === STRUCTURE_TOWER || s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_LINK); } }); if (!sink) return false; debugSay(creep, '➡️SINK'); debugDrawLine(creep, sink, CFG.DRAW.SINK_COLOR, "SINK"); if (creep.transfer(sink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.travelTo(sink, { range: 1, reusePath: 20 }); return true; }

function getBuilderTarget(creep) {
  var cachedId = creep.memory.builderTargetId;
  var cachedType = creep.memory.builderTargetType;
  if (cachedId && cachedType === 'construction') { var cachedSite = Game.constructionSites[cachedId]; if (cachedSite) return { target: cachedSite, type: 'build' }; creep.memory.builderTargetId = null; creep.memory.builderTargetType = null; }
  var localSites = creep.room.find(FIND_CONSTRUCTION_SITES);
  if (localSites && localSites.length > 0) {
    var prio = { 'spawn': 5, 'extension': 4, 'tower': 3, 'container': 2, 'road': 1 };
    var bestLocal = null; var bestScore = -1; var bestRange = 1e9;
    for (var i = 0; i < localSites.length; i++) { var site = localSites[i]; var score = prio[site.structureType] || 0; var range = creep.pos.getRangeTo(site.pos); if (score > bestScore || (score === bestScore && range < bestRange)) { bestLocal = site; bestScore = score; bestRange = range; } }
    if (bestLocal) { creep.memory.builderTargetId = bestLocal.id; creep.memory.builderTargetType = 'construction'; debugRing(creep.room, bestLocal.pos, CFG.DRAW.BUILD_COLOR, 'BUILD'); return { target: bestLocal, type: 'build' }; }
  }
  var nearestSite = null; var bestDistance = 1e9;
  for (var sid in Game.constructionSites) { if (!Game.constructionSites.hasOwnProperty(sid)) continue; var s2 = Game.constructionSites[sid]; var dist = Game.map.getRoomLinearDistance(creep.pos.roomName, s2.pos.roomName); if (dist < bestDistance) { bestDistance = dist; nearestSite = s2; } }
  if (nearestSite) { creep.memory.builderTargetId = nearestSite.id; creep.memory.builderTargetType = 'construction'; debugRing(creep.room, nearestSite.pos, CFG.DRAW.BUILD_COLOR, 'REMOTE'); return { target: nearestSite, type: 'build' }; }
  return null;
}

function isOnBorder(pos) { return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49; }
function nudgeOffBorder(creep) { if (!isOnBorder(creep.pos)) return false; if (creep.pos.x === 0) return creep.move(RIGHT) === OK; if (creep.pos.x === 49) return creep.move(LEFT) === OK; if (creep.pos.y === 0) return creep.move(BOTTOM) === OK; if (creep.pos.y === 49) return creep.move(TOP) === OK; return false; }
function moveToRoom(creep, targetRoomName) { if (!targetRoomName || creep.pos.roomName === targetRoomName) return false; if (nudgeOffBorder(creep)) return true; var exitDir = Game.map.findExit(creep.room, targetRoomName); if (exitDir < 0) return false; var exit = creep.pos.findClosestByRange(exitDir); if (exit) { debugDrawLine(creep, exit, CFG.DRAW.TRAVEL, 'EXIT'); creep.moveTo(exit, { reusePath: 10, maxRooms: 1 }); return true; } return false; }
function handleBuild(creep, target) { if (!target) return false; if (target.pos.roomName !== creep.pos.roomName) { setBuilderState(creep, CFG.BUILDER_STATES.TRAVEL); return true; } if (nudgeOffBorder(creep)) return true; if (!creep.pos.inRangeTo(target.pos, 3)) { debugDrawLine(creep, target, CFG.DRAW.TRAVEL, 'TO•SITE'); creep.moveTo(target, { range: 3, reusePath: 10 }); return true; } debugSay(creep, '🔨'); debugDrawLine(creep, target, CFG.DRAW.BUILD_COLOR, 'BUILD'); var r = creep.build(target); if (r === ERR_NOT_ENOUGH_RESOURCES) return false; if (r === ERR_INVALID_TARGET) { creep.memory.builderTargetId = null; creep.memory.builderTargetType = null; setBuilderState(creep, CFG.BUILDER_STATES.IDLE); } return true; }
function handleTravel(creep, targetInfo) { if (!targetInfo || !targetInfo.target) return false; var target = targetInfo.target; var targetRoom = target.pos.roomName; if (moveToRoom(creep, targetRoom)) return true; if (isOnBorder(creep.pos)) { nudgeOffBorder(creep); return true; } setBuilderState(creep, CFG.BUILDER_STATES.BUILD); return false; }
function getHomeName(creep){ if (creep.memory.home) return creep.memory.home; var spawns = Object.keys(Game.spawns).map(function(k){return Game.spawns[k];}); if (spawns.length){ var best = spawns[0], bestD = Game.map.getRoomLinearDistance(creep.pos.roomName, best.pos.roomName); for (var i=1;i<spawns.length;i++){ var s=spawns[i], d=Game.map.getRoomLinearDistance(creep.pos.roomName, s.pos.roomName); if (d<bestD){ best=s; bestD=d; } } creep.memory.home = best.pos.roomName; return creep.memory.home; } creep.memory.home = creep.pos.roomName; return creep.memory.home; }
function getAnchorPos(homeName){ var r = Game.rooms[homeName]; if (r){ if (r.storage) return r.storage.pos; var spawns = r.find(FIND_MY_SPAWNS); if (spawns.length) return spawns[0].pos; if (r.controller && r.controller.my) return r.controller.pos; } return new RoomPosition(25,25,homeName); }

function shouldBuilderRequestEnergy(creep, targetInfo) {
  if (!CFG.HANDOFF_ENABLED) return false;
  if (!targetInfo || !targetInfo.target) return false;
  var free = creep.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
  return free >= CFG.HANDOFF_MIN_RECEIVER_FREE;
}

function maybePublishBuilderRequest(creep, targetInfo) {
  if (!shouldBuilderRequestEnergy(creep, targetInfo)) { Handoff.clearEnergyHandoffRequest(creep); return false; }
  var req = Handoff.publishEnergyHandoffRequest(creep, 'Builder', targetInfo.target, creep.store.getFreeCapacity(RESOURCE_ENERGY) || 0);
  if (!req) return false;
  if (req.assignedCourierName) {
    creep.memory.energyHandoffCourier = req.assignedCourierName;
    return req.waitUntil && Game.time <= req.waitUntil;
  }
  return false;
}

function run(creep) {
  ensureBuilderIdentity(creep);
  var state = getBuilderState(creep);
  if (needsEnergy(creep)) { setBuilderState(creep, CFG.BUILDER_STATES.HARVEST); state = CFG.BUILDER_STATES.HARVEST; }

  if (state === CFG.BUILDER_STATES.HARVEST) {
    var lowTargetInfo = getBuilderTarget(creep);
    if (lowTargetInfo && maybePublishBuilderRequest(creep, lowTargetInfo)) { debugSay(creep, '⏳'); return; }
    if (collectEnergy(creep) && creep.store.getFreeCapacity() > 0) return;
    if (creep.store.getFreeCapacity() === 0) { Handoff.clearEnergyHandoffRequest(creep); setBuilderState(creep, CFG.BUILDER_STATES.IDLE); }
    return;
  }

  var targetInfo = getBuilderTarget(creep);
  if (!targetInfo) { Handoff.clearEnergyHandoffRequest(creep); if (dumpEnergyToSink(creep)) return; setBuilderState(creep, CFG.BUILDER_STATES.IDLE); idleNearAnchor(creep); return; }
  if (state === CFG.BUILDER_STATES.IDLE) { setBuilderState(creep, CFG.BUILDER_STATES.TRAVEL); state = CFG.BUILDER_STATES.TRAVEL; }
  if (state === CFG.BUILDER_STATES.TRAVEL) { if (handleTravel(creep, targetInfo)) return; state = getBuilderState(creep); }
  if (state === CFG.BUILDER_STATES.BUILD) { if (handleBuild(creep, targetInfo.target)) return; return; }
  setBuilderState(creep, CFG.BUILDER_STATES.IDLE);
  idleNearAnchor(creep);
}

module.exports = { run: run };
