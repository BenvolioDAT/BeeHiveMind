'use strict';

// Builder behavior implementation only. Public role wiring stays in role.Builder.js.
var CFG = require('role.Builder.Config');
var CoreSelectors = require('core.selectors');
var BeeToolbox = require('BeeToolbox');
var Handoff = require('role.EnergyHandoff');
var SourceEnergyManager = require('SourceEnergy.Manager');
var RoadPlanner = require('Planner.Road');

// Keep the role-local names because they make the Builder code easy to scan,
// but delegate the repeated RoomVisual details to BeeToolbox.
function debugOptions() { return { enabled: CFG.DEBUG_DRAW, width: CFG.DRAW.WIDTH, opacity: CFG.DRAW.OPACITY, font: CFG.DRAW.FONT }; }
function debugSay(creep, msg) { BeeToolbox.sayIfDebugEnabled(creep, msg, CFG.DEBUG_SAY); }
function debugDrawLine(creep, target, color, label) { BeeToolbox.drawDebugLine(creep, target, color, label, debugOptions()); }
function debugRing(room, pos, color, text) { BeeToolbox.drawDebugRing(room, pos, color, text, debugOptions()); }

function ensureBuilderIdentity(creep) { if (!creep || !creep.memory) return; creep.memory.role = 'Builder'; if (!creep.memory.task) creep.memory.task = 'builder'; }
function needsEnergy(creep) { var stored = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0; return stored === 0; }
function setBuilderState(creep, state) { creep.memory.builderState = state; }
function getBuilderState(creep) { if (!creep.memory.builderState) setBuilderState(creep, CFG.BUILDER_STATES.HARVEST); return creep.memory.builderState; }
function hasWorkPart(creep) { return creep.getActiveBodyparts && creep.getActiveBodyparts(WORK) > 0; }
function setBuilderAssistDiag(creep, patch) {
  if (!creep || !creep.room) return;
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[creep.room.name]) Memory.rooms[creep.room.name] = {};
  var base = Memory.rooms[creep.room.name].lastBuilderEnergyAssist || {};
  base.tick = Game.time;
  base.builderName = creep.name;
  for (var k in patch) base[k] = patch[k];
  Memory.rooms[creep.room.name].lastBuilderEnergyAssist = base;
}
function hasStoredEnergyAvailable(creep) {
  var room = creep.room;
  var tomb = room.find(FIND_TOMBSTONES, { filter: function(t){ return t.store && (t.store[RESOURCE_ENERGY] || 0) > 0; } }); if (tomb.length) return true;
  var ruin = room.find(FIND_RUINS, { filter: function(r){ return r.store && (r.store[RESOURCE_ENERGY] || 0) > 0; } }); if (ruin.length) return true;
  var drop = room.find(FIND_DROPPED_RESOURCES, { filter: function(r){ return r.resourceType === RESOURCE_ENERGY && (r.amount || 0) >= CFG.PICKUP_MIN; } }); if (drop.length) return true;
  var st = room.find(FIND_STRUCTURES, { filter: function(s){ if (!s.store) return false; var t=s.structureType; if (t!==STRUCTURE_CONTAINER && t!==STRUCTURE_STORAGE && t!==STRUCTURE_TERMINAL && t!==STRUCTURE_LINK) return false; return (s.store[RESOURCE_ENERGY] || 0) > 0; } });
  return st.length > 0;
}
function hasLocalTruckerWithEnergy(creep) {
  var cr = creep.room.find(FIND_MY_CREEPS, { filter: function(c){ return c.memory && c.memory.role === 'Trucker' && (c.store[RESOURCE_ENERGY] || 0) > 0; } });
  return cr.length > 0;
}
function clearBuilderHandoffWaitMemory(creep) {
  delete creep.memory.builderHandoffWaitTargetId;
  delete creep.memory.builderHandoffWaitStartedAt;
  delete creep.memory.builderHandoffWaitUntil;
}
function tryEmergencySelfHarvest(creep, targetInfo) {
  if (!CFG.EMERGENCY_SELF_HARVEST_ENABLED || !hasWorkPart(creep)) return false;
  if (CFG.SELF_HARVEST_ONLY_WITHOUT_STORAGE && creep.room.storage) return false;
  var source = creep.pos.findClosestByRange(FIND_SOURCES, { filter: function(s){ return (s.energy || 0) >= CFG.SELF_HARVEST_MIN_SOURCE_ENERGY; } });
  if (!source) return false;
  clearBuilderHandoffWaitMemory(creep);
  setBuilderAssistDiag(creep, { state: 'HARVEST', targetId: targetInfo && targetInfo.target ? targetInfo.target.id : null, selfHarvestUsed: true, reason: 'emergency_self_harvest', sourceId: source.id });
  if ((creep.store[RESOURCE_ENERGY] || 0) >= CFG.SELF_HARVEST_DELIVER_AT_ENERGY) { setBuilderState(creep, CFG.BUILDER_STATES.BUILD); return false; }
  var hr = creep.harvest(source);
  if (hr === ERR_NOT_IN_RANGE) creep.moveTo(source, { range: 1, reusePath: 10 });
  return true;
}

function findRemoteContainerBootstrapSource(targetInfo) {
  if (!isRemoteContainerBuildTarget(targetInfo) || !targetInfo.target || !targetInfo.target.pos) return null;
  var sitePos = targetInfo.target.pos;
  if (!sitePos || !sitePos.findInRange) return null;
  var nearby = sitePos.findInRange(FIND_SOURCES, 1);
  if (!nearby || !nearby.length) return null;
  return nearby[0];
}

function tryRemoteBootstrapSelfHarvest(creep, targetInfo) {
  if (!isRemoteContainerBuildTarget(targetInfo)) return { acted: false, collected: false, reason: 'not_remote_bootstrap' };
  if (!hasWorkPart(creep)) return { acted: false, collected: false, reason: 'no_work_parts' };
  if (isRoomUnsafeForRemoteBuild(creep.pos.roomName, getHomeName(creep))) return { acted: false, collected: false, reason: 'room_unsafe' };
  var source = findRemoteContainerBootstrapSource(targetInfo);
  if (!source) return { acted: false, collected: false, reason: 'no_adjacent_source' };
  clearBuilderHandoffWaitMemory(creep);
  var carried = creep.store[RESOURCE_ENERGY] || 0;
  if (carried >= CFG.SELF_HARVEST_DELIVER_AT_ENERGY) {
    setBuilderState(creep, CFG.BUILDER_STATES.BUILD);
    setBuilderAssistDiag(creep, {
      state: 'BUILD',
      remoteContainerBootstrap: true,
      selfHarvestUsed: true,
      selfHarvestSourceId: source.id,
      carriedEnergy: carried,
      targetRoom: targetInfo.target.pos.roomName,
      targetId: targetInfo.target.id,
      reason: 'remote_bootstrap_self_harvest_deliver_threshold'
    });
    return { acted: true, collected: true, reason: 'deliver_threshold_met' };
  }
  var hr = creep.harvest(source);
  if (hr === OK || hr === ERR_TIRED) {
    setBuilderAssistDiag(creep, { state: 'HARVEST', remoteContainerBootstrap: true, selfHarvestUsed: true, selfHarvestSourceId: source.id, targetRoom: targetInfo.target.pos.roomName, targetId: targetInfo.target.id, reason: 'remote_bootstrap_harvest' });
    return { acted: true, collected: true, reason: 'harvest_source' };
  }
  if (hr === ERR_NOT_IN_RANGE) {
    creep.moveTo(source, { range: 1, reusePath: 10 });
    setBuilderAssistDiag(creep, { state: 'HARVEST', remoteContainerBootstrap: true, selfHarvestUsed: true, selfHarvestSourceId: source.id, targetRoom: targetInfo.target.pos.roomName, targetId: targetInfo.target.id, reason: 'move_to_bootstrap_source' });
    return { acted: true, collected: false, reason: 'move_to_source' };
  }
  return { acted: false, collected: false, reason: 'harvest_failed_' + hr };
}

function getBuilderEnergyDraw(kind) {
  if (kind === 'storage') return { label: "HOME.STORE", say: "STORE" };
  if (kind === 'terminal') return { label: "HOME.TERM", say: "TERM" };
  if (kind === 'spawn_hub_container') return { label: "HUB.CONT", say: "HUB" };
  if (kind === 'source_container') return { label: "SRC.CONT", say: "SRC" };
  return { label: "WITHDRAW", say: "ENERGY" };
}

function withdrawBuilderHomeEnergy(creep, info) {
  if (!info || !info.target) return null;
  // core.selectors classifies the source type for us. The Builder still owns the
  // action result and movement options because role energy priority is behavior.
  var draw = getBuilderEnergyDraw(info.kind);
  debugSay(creep, draw.say);
  debugDrawLine(creep, info.target, CFG.DRAW.FILL_COLOR, draw.label);
  var wr = creep.withdraw(info.target, RESOURCE_ENERGY);
  if (wr === ERR_NOT_IN_RANGE) creep.travelTo(info.target, { range: 1, reusePath: 25 });
  return { acted: true, collected: wr === OK, reason: 'withdraw_' + info.kind };
}

function collectEnergy(creep, opts) {
  opts = opts || {};
  var skipHomeReturn = !!opts.skipHomeReturn;
  var result = { acted: false, collected: false, reason: 'no_energy' };
  var homeName = (typeof getHomeName === 'function') ? getHomeName(creep) : null;
  var homeRoom = homeName ? Game.rooms[homeName] : null;
  var homeStorage = homeRoom ? homeRoom.storage : null;
  var homeTerminal = homeRoom ? homeRoom.terminal : null;
  var homeEnergy = 0;
  if (homeStorage && homeStorage.store) homeEnergy += homeStorage.store[RESOURCE_ENERGY] || 0;
  if (homeTerminal && homeTerminal.store) homeEnergy += homeTerminal.store[RESOURCE_ENERGY] || 0;

  var homeIsRich = homeEnergy >= CFG.HOME_RICH_ENERGY;

  if (!skipHomeReturn && homeIsRich && homeName) {
    if (!homeRoom || creep.pos.roomName !== homeName) {
      var anchorPos = (typeof getAnchorPos === 'function') ? getAnchorPos(homeName) : null;
      if (anchorPos) { debugSay(creep, '🏠'); debugDrawLine(creep, anchorPos, CFG.DRAW.IDLE_COLOR, "HOME•ENERGY"); creep.travelTo(anchorPos, { range: 2, reusePath: 25 }); return { acted: true, collected: false, reason: 'travel_home' }; }
    }
  }

  var tomb = creep.pos.findClosestByRange(FIND_TOMBSTONES, { filter: function (t) { var energy = t.store[RESOURCE_ENERGY] || 0; return energy > 0; } });
  if (tomb) { debugSay(creep, '🪦'); debugDrawLine(creep, tomb, CFG.DRAW.GRAVE_COLOR, "TOMB"); var tr = creep.withdraw(tomb, RESOURCE_ENERGY); if (tr === ERR_NOT_IN_RANGE) creep.travelTo(tomb, { range: 1, reusePath: 20 }); return { acted: true, collected: tr === OK, reason: 'withdraw_tomb' }; }

  var ruin = creep.pos.findClosestByRange(FIND_RUINS, { filter: function (r) { var energy = r.store[RESOURCE_ENERGY] || 0; return energy > 0; } });
  if (ruin) { debugSay(creep, '🏚️'); debugDrawLine(creep, ruin, CFG.DRAW.GRAVE_COLOR, "RUIN"); var rr = creep.withdraw(ruin, RESOURCE_ENERGY); if (rr === ERR_NOT_IN_RANGE) creep.travelTo(ruin, { range: 1, reusePath: 20 }); return { acted: true, collected: rr === OK, reason: 'withdraw_ruin' }; }

  var dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, { filter: function (r) { var amount = r.amount || 0; return r.resourceType === RESOURCE_ENERGY && amount >= CFG.PICKUP_MIN; } });
  if (dropped) { debugSay(creep, '🍪'); debugDrawLine(creep, dropped, CFG.DRAW.DROP_COLOR, "DROP"); var pr = creep.pickup(dropped); if (pr === ERR_NOT_IN_RANGE) creep.travelTo(dropped, { range: 1, reusePath: 15 }); return { acted: true, collected: pr === OK, reason: 'pickup_dropped' }; }

  if (homeRoom && creep.pos.roomName === homeName) {
    var homeWorkerEnergy = CoreSelectors.findBestHomeWorkerEnergySource(homeRoom, { includeTerminal: true });
    var homeWorkerResult = withdrawBuilderHomeEnergy(creep, homeWorkerEnergy);
    if (homeWorkerResult) return homeWorkerResult;
  }

  var srcCont = creep.pos.findClosestByRange(FIND_STRUCTURES, { filter: function (s) { if (s.structureType !== STRUCTURE_CONTAINER || !s.store) return false; if (s.pos.findInRange(FIND_SOURCES, 1).length === 0) return false; var energy = s.store[RESOURCE_ENERGY] || 0; return energy >= CFG.SRC_CONTAINER_MIN; } });
  if (srcCont) { debugSay(creep, '📦'); debugDrawLine(creep, srcCont, CFG.DRAW.FILL_COLOR, "SRC•CONT"); var cr = creep.withdraw(srcCont, RESOURCE_ENERGY); if (cr === ERR_NOT_IN_RANGE) creep.travelTo(srcCont, { range: 1, reusePath: 25 }); return { acted: true, collected: cr === OK, reason: 'withdraw_source_container' }; }

  var storeLike = creep.pos.findClosestByRange(FIND_STRUCTURES, { filter: function (s) { if (!s.store) return false; var t = s.structureType; if (t !== STRUCTURE_CONTAINER && t !== STRUCTURE_LINK && t !== STRUCTURE_STORAGE && t !== STRUCTURE_TERMINAL) return false; var energy = s.store[RESOURCE_ENERGY] || 0; return energy > 0; } });
  if (storeLike) { debugSay(creep, '🏦'); debugDrawLine(creep, storeLike, CFG.DRAW.FILL_COLOR, "WITHDRAW"); var sr = creep.withdraw(storeLike, RESOURCE_ENERGY); if (sr === ERR_NOT_IN_RANGE) creep.travelTo(storeLike, { range: 1, reusePath: 25 }); return { acted: true, collected: sr === OK, reason: 'withdraw_store' }; }

  // Builder does not harvest directly. If no stored/dropped energy exists, it waits or returns home.

  if (!skipHomeReturn && typeof getHomeName === 'function' && typeof getAnchorPos === 'function') {
    var homeName2 = getHomeName(creep);
    if (homeName2 && creep.pos.roomName !== homeName2) {
      var anchorPos2 = getAnchorPos(homeName2);
      if (anchorPos2) { debugSay(creep, '🏠'); debugDrawLine(creep, anchorPos2, CFG.DRAW.IDLE_COLOR, "HOME"); creep.travelTo(anchorPos2, { range: 2, reusePath: 25 }); return { acted: true, collected: false, reason: 'travel_home_fallback' }; }
    }
  }

  idleNearAnchor(creep);
  return result;
}

function isAssignedTruckerIncoming(creep, targetInfo) {
  if (!targetInfo || !targetInfo.target) return false;
  var mem = Handoff.ensureHandoffMemory(creep.room);
  var req = mem && mem.requests ? mem.requests[creep.name] : null;
  if (!req || !req.assignedHaulerName) return false;
  var hauler = Game.creeps[req.assignedHaulerName];
  if (!hauler) return false;
  if (hauler.pos.roomName !== creep.pos.roomName) return false;
  if ((hauler.store[RESOURCE_ENERGY] || 0) <= 0) return false;
  var rangeToBuilder = hauler.pos.getRangeTo(creep);
  var rangeToTarget = hauler.pos.getRangeTo(targetInfo.target);
  return rangeToBuilder <= 5 || rangeToTarget <= 5;
}

function idleNearAnchor(creep) { var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS) || creep.pos; if (anchor && anchor.pos) { debugSay(creep, '🧘'); debugDrawLine(creep, anchor, CFG.DRAW.IDLE_COLOR, "IDLE"); creep.travelTo(anchor, { range: 2, reusePath: 20 }); } }
function dumpEnergyToSink(creep) { var carried = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0; if (carried <= 0) return false; var sink = creep.pos.findClosestByRange(FIND_STRUCTURES, { filter: function (s) { if (!s.store) return false; var free = s.store.getFreeCapacity(RESOURCE_ENERGY) || 0; return free > 0 && (s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_TERMINAL || s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION || s.structureType === STRUCTURE_TOWER || s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_LINK); } }); if (!sink) return false; debugSay(creep, '➡️SINK'); debugDrawLine(creep, sink, CFG.DRAW.SINK_COLOR, "SINK"); if (creep.transfer(sink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) creep.travelTo(sink, { range: 1, reusePath: 20 }); return true; }

function getBuilderBuildPriority(site) {
  if (!site || !site.structureType) return 1;

  // Builders construct roads last because roads are useful quality-of-life infrastructure,
  // but core production, economy, and defense structures are usually more urgent.
  if (site.structureType === STRUCTURE_SPAWN) return 100;
  if (site.structureType === STRUCTURE_EXTENSION) return 90;
  if (site.structureType === STRUCTURE_TOWER) return 80;
  if (site.structureType === STRUCTURE_STORAGE) return 70;
  if (site.structureType === STRUCTURE_TERMINAL) return 65;
  if (site.structureType === STRUCTURE_CONTAINER) return 60;
  if (site.structureType === STRUCTURE_LINK) return 55;
  if (site.structureType === STRUCTURE_EXTRACTOR) return 50;
  if (site.structureType === STRUCTURE_LAB) return 45;
  if (site.structureType === STRUCTURE_FACTORY) return 40;
  if (site.structureType === STRUCTURE_OBSERVER) return 35;
  if (site.structureType === STRUCTURE_POWER_SPAWN) return 30;
  if (site.structureType === STRUCTURE_NUKER) return 25;

  // New ramparts/walls still need initial construction; this is separate from
  // long-term maintenance/repair strategy for mature fortifications.
  if (site.structureType === STRUCTURE_RAMPART) return 20;
  if (site.structureType === STRUCTURE_WALL) return 15;

  if (site.structureType === STRUCTURE_ROAD) return 5;
  return 1;
}

function getMyUsernameForBuilder() {
  // Shared username lookup avoids each role re-scanning Game.spawns in its own
  // slightly different way. The remote safety predicate itself stays local.
  return BeeToolbox.myUsername();
}

function isRoomUnsafeForRemoteBuild(roomName, homeRoom) {
  if (!roomName || roomName === homeRoom) return false;
  var myName = getMyUsernameForBuilder();
  var mem = Memory.rooms && Memory.rooms[roomName];
  if (mem) {
    if (mem.hostile) return true;
    if (typeof mem.sourceWorkerBlockedUntil === 'number' && mem.sourceWorkerBlockedUntil > Game.time) return true;
    if (BeeToolbox.isRoomInvaderLocked(roomName)) return true;
    if (mem.intel) {
      if (mem.intel.owner && (!myName || mem.intel.owner !== myName)) return true;
      if (mem.intel.reservation && (!myName || mem.intel.reservation !== myName)) return true;
    }
  }
  var room = Game.rooms[roomName];
  if (room) {
    var hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
    if (hostiles.length > 0) return true;
    if (room.controller) {
      var owner = room.controller.owner && room.controller.owner.username;
      var reserver = room.controller.reservation && room.controller.reservation.username;
      if (owner && (!myName || owner !== myName)) return true;
      if (reserver && (!myName || reserver !== myName)) return true;
    }
  }
  return false;
}

function getActiveRemoteSourceRecord(homeRoom, sourceId) {
  if (!homeRoom || !sourceId || !SourceEnergyManager || typeof SourceEnergyManager.getSourceRecord !== 'function') return null;
  var rec = SourceEnergyManager.getSourceRecord(homeRoom, sourceId);
  return rec && rec.mode === 'remote' && rec.active ? rec : null;
}

function isRoadPlannerRemoteSite(homeRoom, site) {
  if (!homeRoom || !site || site.structureType !== STRUCTURE_ROAD) return false;
  var homeObj = Game.rooms[homeRoom];
  var mem = RoadPlanner && typeof RoadPlanner._memory === 'function' && homeObj
    ? RoadPlanner._memory(homeObj)
    : (Memory.rooms && Memory.rooms[homeRoom] && Memory.rooms[homeRoom].roadPlanner);
  if (!mem || !mem.paths) return false;
  for (var key in mem.paths) {
    if (!Object.prototype.hasOwnProperty.call(mem.paths, key)) continue;
    var path = mem.paths[key] && mem.paths[key].path;
    if (!Array.isArray(path)) continue;
    for (var i = 0; i < path.length; i++) {
      var step = path[i];
      if (step && step.roomName === site.pos.roomName && step.x === site.pos.x && step.y === site.pos.y) return true;
    }
  }
  return false;
}

function isRemoteConstructionAllowed(homeRoom, site, remoteContainerById) {
  if (!site || site.pos.roomName === homeRoom) return { allowed: true, reason: 'home-room' };
  if (remoteContainerById && remoteContainerById[site.id]) return { allowed: true, reason: 'active-remote-source-container' };
  if (site.structureType === STRUCTURE_ROAD && isRoadPlannerRemoteSite(homeRoom, site)) return { allowed: true, reason: 'active-remote-road' };
  return { allowed: false, reason: 'inactive-remote-site' };
}

function getRemoteContainerBuildTargets(creep) {
  var out = { targets: [], skippedUnsafe: 0, skippedInactiveRemoteSites: 0, remoteContainerMemoryCandidates: 0, visibleRemoteContainerSites: 0 };
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.remoteContainerBuilds) Memory.__BHM.remoteContainerBuilds = {};
  var root = Memory.__BHM.remoteContainerBuilds;
  var home = getHomeName(creep);
  for (var id in root) {
    if (!Object.prototype.hasOwnProperty.call(root, id)) continue;
    var rec = root[id];
    if (!rec) continue;
    if (rec.homeRoom !== home) continue;
    out.remoteContainerMemoryCandidates++;
    if (rec.containerId && Game.getObjectById(rec.containerId)) continue;
    var roomName = rec.targetRoom || rec.roomName || rec.remoteRoom;
    if (!roomName) continue;
    var activeRecord = getActiveRemoteSourceRecord(home, rec.sourceId || id);
    if (!activeRecord || ((activeRecord.targetRoom || activeRecord.roomName) !== roomName)) {
      out.skippedInactiveRemoteSites++;
      continue;
    }
    if (isRoomUnsafeForRemoteBuild(roomName, home)) { out.skippedUnsafe++; continue; }
    var site = null;
    if (rec.siteId && Game.constructionSites[rec.siteId]) site = Game.constructionSites[rec.siteId];
    if (!site && rec.status === 'building' && rec.x != null && rec.y != null && Game.rooms[roomName]) {
      var pos = new RoomPosition(rec.x, rec.y, roomName);
      var nearSites = pos.findInRange(FIND_CONSTRUCTION_SITES, 1, { filter: function(s){ return s.structureType === STRUCTURE_CONTAINER; } });
      if (nearSites && nearSites.length) site = nearSites[0];
    }
    if (!site && Game.rooms[roomName]) {
      var srcObj = Game.getObjectById(id);
      if (srcObj && srcObj.pos && srcObj.pos.roomName === roomName) {
        var fallbackSites = srcObj.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, { filter: function(s){ return s.structureType === STRUCTURE_CONTAINER; } });
        if (fallbackSites && fallbackSites.length) site = fallbackSites[0];
      }
    }
    if (Game.rooms[roomName] && rec.x != null && rec.y != null) {
      var builtPos = new RoomPosition(rec.x, rec.y, roomName);
      var builtContainer = builtPos.lookFor(LOOK_STRUCTURES).find(function(s){ return s.structureType === STRUCTURE_CONTAINER; });
      if (builtContainer) {
        rec.containerId = builtContainer.id;
        rec.siteId = null;
        rec.status = 'built';
        rec.progress = 1;
        rec.progressTotal = 1;
        rec.progressPct = 100;
        rec.updated = Game.time;
        continue;
      }
    }
    if (!site) continue;
    out.visibleRemoteContainerSites++;
    rec.siteId = site.id;
    rec.containerId = null;
    rec.status = 'building';
    rec.progress = site.progress || 0;
    rec.progressTotal = site.progressTotal || 0;
    rec.progressPct = rec.progressTotal > 0 ? Math.floor((rec.progress / rec.progressTotal) * 100) : 0;
    rec.x = site.pos.x;
    rec.y = site.pos.y;
    rec.roomName = site.pos.roomName;
    rec.updated = Game.time;
    rec.lastSeen = Game.time;
    out.targets.push({ site: site, reason: 'remoteSourceContainer', sourceId: rec.sourceId || id });
  }
  // Visible fallback: allow builders to discover source-adjacent remote container sites
  // even when remoteContainerBuilds memory is stale or missing for that source.
  if (Memory.rooms) {
    for (var remoteName in Game.rooms) {
      if (!Object.prototype.hasOwnProperty.call(Game.rooms, remoteName)) continue;
      if (remoteName === home) continue;
      if (isRoomUnsafeForRemoteBuild(remoteName, home)) { out.skippedUnsafe++; continue; }
      var approved = Memory.__BHM && Memory.__BHM.sourceEnergy && Memory.__BHM.sourceEnergy.homes && Memory.__BHM.sourceEnergy.homes[home] && Memory.__BHM.sourceEnergy.homes[home].sources;
      if (!approved) continue;
      for (var sid in approved) {
        if (!Object.prototype.hasOwnProperty.call(approved, sid)) continue;
        var approvedRecord = approved[sid];
        var approvedRoom = approvedRecord && (approvedRecord.targetRoom || approvedRecord.roomName || approvedRecord.remoteRoom);
        if (!approvedRecord || !approvedRecord.active || approvedRoom !== remoteName) {
          out.skippedInactiveRemoteSites++;
          continue;
        }
        var src = Game.getObjectById(sid);
        if (!src || !src.pos || src.pos.roomName !== remoteName) continue;
        var nearbySites = src.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, { filter: function(s){ return s.structureType === STRUCTURE_CONTAINER; } });
        if (!nearbySites || !nearbySites.length) continue;
        var nearSite = nearbySites[0];
        var exists = false;
        for (var t = 0; t < out.targets.length; t++) if (out.targets[t].site && out.targets[t].site.id === nearSite.id) { exists = true; break; }
        if (exists) continue;
        out.visibleRemoteContainerSites++;
        out.targets.push({ site: nearSite, reason: 'remoteSourceContainerVisibleFallback', sourceId: sid });
        var prev = Memory.__BHM.remoteContainerBuilds[sid] || {};
        Memory.__BHM.remoteContainerBuilds[sid] = {
          sourceId: sid,
          homeRoom: home,
          remoteRoom: remoteName,
          roomName: nearSite.pos.roomName,
          x: nearSite.pos.x,
          y: nearSite.pos.y,
          siteId: nearSite.id,
          containerId: null,
          status: 'building',
          progress: nearSite.progress || 0,
          progressTotal: nearSite.progressTotal || 0,
          progressPct: (nearSite.progressTotal > 0 ? Math.floor((nearSite.progress / nearSite.progressTotal) * 100) : 0),
          assignedVeinseeker: prev.assignedVeinseeker || null,
          updated: Game.time,
          lastSeen: Game.time
        };
      }
    }
  }
  return out;
}

function writeBuilderTargetDecision(creep, patch) {
  var home = getHomeName(creep);
  if (!home) return;
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[home]) Memory.rooms[home] = {};
  var diag = Memory.rooms[home].lastBuilderTargetDecision || {};
  diag.tick = Game.time;
  for (var k in patch) diag[k] = patch[k];
  Memory.rooms[home].lastBuilderTargetDecision = diag;
}

function getBuilderTarget(creep) {
  var remoteData = getRemoteContainerBuildTargets(creep);
  var remoteContainerById = {};
  var remoteContainerSourceById = {};
  for (var r = 0; r < remoteData.targets.length; r++) {
    remoteContainerById[remoteData.targets[r].site.id] = true;
    if (remoteData.targets[r].sourceId) remoteContainerSourceById[remoteData.targets[r].site.id] = remoteData.targets[r].sourceId;
  }
  var cachedId = creep.memory.builderTargetId;
  var cachedType = creep.memory.builderTargetType;
  if (cachedId && cachedType === 'construction') {
      var cachedSite = Game.constructionSites[cachedId];
    if (cachedSite) {
      var unsafeCachedRoom = isRoomUnsafeForRemoteBuild(cachedSite.pos.roomName, getHomeName(creep));
      var shouldOverrideRoad = cachedSite.structureType === STRUCTURE_ROAD && remoteData.targets.length > 0;
      var cachedAllowed = isRemoteConstructionAllowed(getHomeName(creep), cachedSite, remoteContainerById);
      if (!unsafeCachedRoom && !shouldOverrideRoad && cachedAllowed.allowed) return { target: cachedSite, type: 'build', reason: 'cached', home: getHomeName(creep) };
      creep.memory.builderTargetId = null;
      creep.memory.builderTargetType = null;
    } else { creep.memory.builderTargetId = null; creep.memory.builderTargetType = null; }
  }

  var allSites = [];
  for (var sid in Game.constructionSites) {
    if (!Object.prototype.hasOwnProperty.call(Game.constructionSites, sid)) continue;
    var cs = Game.constructionSites[sid];
    if (!cs || isRoomUnsafeForRemoteBuild(cs.pos.roomName, getHomeName(creep))) continue;
    var allowed = isRemoteConstructionAllowed(getHomeName(creep), cs, remoteContainerById);
    if (!allowed.allowed) {
      remoteData.skippedInactiveRemoteSites++;
      continue;
    }
    allSites.push(cs);
  }

  var best = null; var bestScore = -1; var bestRoomDistance = 1e9; var bestVisibleRange = 1e9;
  var reason = 'localPriority';
  for (var i = 0; i < allSites.length; i++) {
    var site = allSites[i];
    var score = getBuilderBuildPriority(site);
    // Roads are useful, but remote source containers unlock remote income, so source containers should beat road work.
    if (remoteContainerById[site.id]) score = Math.max(score, 65);
    var roomDistance = Game.map.getRoomLinearDistance(creep.pos.roomName, site.pos.roomName);
    var visibleRange = (site.pos.roomName === creep.pos.roomName) ? creep.pos.getRangeTo(site.pos) : 1e9;
    if (
      score > bestScore ||
      (score === bestScore && roomDistance < bestRoomDistance) ||
      (score === bestScore && roomDistance === bestRoomDistance && visibleRange < bestVisibleRange)
    ) {
      best = site;
      bestScore = score;
      bestRoomDistance = roomDistance;
      bestVisibleRange = visibleRange;
      if (remoteContainerById[site.id]) reason = 'remoteSourceContainer';
      else if (site.structureType === STRUCTURE_ROAD) reason = 'roadFallback';
      else reason = 'localPriority';
    }
  }

  if (best) {
    creep.memory.builderTargetId = best.id;
    creep.memory.builderTargetType = 'construction';
    debugRing(creep.room, best.pos, CFG.DRAW.BUILD_COLOR, 'BUILD');
    writeBuilderTargetDecision(creep, {
      selectedTargetId: best.id,
      selectedStructureType: best.structureType,
      selectedRoom: best.pos.roomName,
      selectedReason: reason,
      activeRemoteSourceMatched: !!remoteContainerById[best.id],
      remoteSourceId: remoteContainerSourceById[best.id] || null,
      targetRoom: best.pos.roomName,
      remoteContainerCandidates: remoteData.targets.length,
      remoteContainerMemoryCandidates: remoteData.remoteContainerMemoryCandidates,
      visibleRemoteContainerSites: remoteData.visibleRemoteContainerSites,
      skippedUnsafe: remoteData.skippedUnsafe,
      skippedUnsafeRemoteSites: remoteData.skippedUnsafe,
      skippedInactiveRemoteSites: remoteData.skippedInactiveRemoteSites
    });
    return { target: best, type: 'build', reason: reason, home: getHomeName(creep) };
  }
  writeBuilderTargetDecision(creep, {
    selectedTargetId: null,
    selectedStructureType: null,
    selectedRoom: null,
    selectedReason: 'none',
    remoteContainerCandidates: remoteData.targets.length,
    remoteContainerMemoryCandidates: remoteData.remoteContainerMemoryCandidates,
    visibleRemoteContainerSites: remoteData.visibleRemoteContainerSites,
    skippedUnsafe: remoteData.skippedUnsafe,
    skippedUnsafeRemoteSites: remoteData.skippedUnsafe,
    skippedInactiveRemoteSites: remoteData.skippedInactiveRemoteSites
  });
  return null;
}
function isRemoteContainerBuildTarget(targetInfo) {
  if (!targetInfo || !targetInfo.target) return false;
  if (targetInfo.target.structureType !== STRUCTURE_CONTAINER) return false;
  if (targetInfo.reason === 'remoteSourceContainer' || targetInfo.reason === 'remoteSourceContainerVisibleFallback') return true;
  var roomName = targetInfo.target.pos && targetInfo.target.pos.roomName;
  var home = targetInfo.home || null;
  if (!roomName || !home || roomName === home) return false;
  return true;
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
  if (req.assignedHaulerName) {
    creep.memory.energyHandoffHauler = req.assignedHaulerName;
    return req.waitUntil && Game.time <= req.waitUntil;
  }
  return false;
}
function maybeWaitForUnassignedHandoff(creep, targetInfo) {
  if (!targetInfo || !targetInfo.target) return false;
  if (!CFG.HANDOFF_ENABLED) return false;
  var mem = Handoff.ensureHandoffMemory(creep.room);
  var req = mem && mem.requests ? mem.requests[creep.name] : null;
  var assigned = !!(req && req.assignedHaulerName);
  var targetId = targetInfo.target.id;
  var waitUntil = creep.memory.builderHandoffWaitUntil || 0;
  if (assigned) return false;

  var shouldWait = hasLocalTruckerWithEnergy(creep) || !hasStoredEnergyAvailable(creep);
  if (!shouldWait) return false;
  if (creep.memory.builderHandoffWaitTargetId !== targetId) {
    creep.memory.builderHandoffWaitTargetId = targetId;
    creep.memory.builderHandoffWaitStartedAt = Game.time;
    creep.memory.builderHandoffWaitUntil = Game.time + CFG.BUILDER_HANDOFF_WAIT_UNASSIGNED_TICKS;
    waitUntil = creep.memory.builderHandoffWaitUntil;
  }
  if (Game.time > waitUntil) {
    setBuilderAssistDiag(creep, { state: 'HARVEST', targetId: targetId, handoffPublished: true, handoffAssigned: false, waitedForHandoff: true, selfHarvestUsed: false, reason: 'handoff_wait_expired', collectTargetFound: false });
    return false;
  }
  var range = creep.pos.getRangeTo(targetInfo.target);
  setBuilderAssistDiag(creep, { state: 'HARVEST', targetId: targetId, handoffPublished: true, handoffAssigned: false, waitedForHandoff: true, selfHarvestUsed: false, reason: 'wait_unassigned_handoff', collectTargetFound: false });
  if (range > CFG.BUILDER_HANDOFF_WAIT_IF_NEAR_TARGET_RANGE) creep.moveTo(targetInfo.target, { range: CFG.BUILDER_HANDOFF_WAIT_IF_NEAR_TARGET_RANGE, reusePath: 10 });
  return true;
}

function run(creep) {
  ensureBuilderIdentity(creep);
  var state = getBuilderState(creep);
  if (needsEnergy(creep)) { setBuilderState(creep, CFG.BUILDER_STATES.HARVEST); state = CFG.BUILDER_STATES.HARVEST; }

  if (state === CFG.BUILDER_STATES.HARVEST) {
    var lowTargetInfo = getBuilderTarget(creep);
    var carried = creep.store[RESOURCE_ENERGY] || 0;
    var free = creep.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
    var nearTarget = !!(lowTargetInfo && lowTargetInfo.target && creep.pos.roomName === lowTargetInfo.target.pos.roomName && creep.pos.getRangeTo(lowTargetInfo.target) <= 3);
    var remoteContainerTarget = isRemoteContainerBuildTarget(lowTargetInfo);
    var shouldAllowPartialBuild = remoteContainerTarget && carried > 0;

    var assignedWait = lowTargetInfo && maybePublishBuilderRequest(creep, lowTargetInfo);
    var canWaitAssigned = !!(lowTargetInfo && assignedWait && isAssignedTruckerIncoming(creep, lowTargetInfo));
    if (assignedWait && !canWaitAssigned) {
      setBuilderAssistDiag(creep, { state: 'HARVEST', targetId: lowTargetInfo && lowTargetInfo.target ? lowTargetInfo.target.id : null, handoffPublished: true, handoffAssigned: true, waitedForHandoff: false, handoffWaitSkippedReason: 'assigned_not_incoming_same_room' });
    }
    if (canWaitAssigned && !shouldAllowPartialBuild) { clearBuilderHandoffWaitMemory(creep); setBuilderAssistDiag(creep, { state: 'HARVEST', targetId: lowTargetInfo.target.id, handoffPublished: true, handoffAssigned: true, waitedForHandoff: true, selfHarvestUsed: false, reason: 'assigned_handoff_wait' }); debugSay(creep, '⏳'); return; }
    if (!remoteContainerTarget && !shouldAllowPartialBuild && lowTargetInfo && maybeWaitForUnassignedHandoff(creep, lowTargetInfo)) { debugSay(creep, '⏳'); return; }
    var collectResult = collectEnergy(creep, { skipHomeReturn: remoteContainerTarget });
    var gotEnergy = !!(collectResult && collectResult.collected);
    var localEnergyActionTaken = !!(collectResult && collectResult.acted && (
      collectResult.reason === 'withdraw_tomb' ||
      collectResult.reason === 'withdraw_ruin' ||
      collectResult.reason === 'pickup_dropped' ||
      collectResult.reason === 'withdraw_storage' ||
      collectResult.reason === 'withdraw_terminal' ||
      collectResult.reason === 'withdraw_spawn_hub_container' ||
      collectResult.reason === 'withdraw_source_container' ||
      collectResult.reason === 'withdraw_store' ||
      collectResult.reason === 'withdraw_home'
    ));
    if (shouldAllowPartialBuild && ((!collectResult || !collectResult.acted) || nearTarget)) {
      clearBuilderHandoffWaitMemory(creep);
      Handoff.clearEnergyHandoffRequest(creep);
      setBuilderState(creep, CFG.BUILDER_STATES.BUILD);
      setBuilderAssistDiag(creep, {
        state: 'BUILD',
        targetId: lowTargetInfo && lowTargetInfo.target ? lowTargetInfo.target.id : null,
        partialEnergyBuildAllowed: true,
        carriedEnergy: carried,
        freeCapacity: free,
        targetReason: lowTargetInfo ? lowTargetInfo.reason : null,
        reason: 'partial_energy_remote_container_build',
        collectEnergyAction: collectResult ? collectResult.reason : null
      });
      return;
    }
    if (localEnergyActionTaken && creep.store.getFreeCapacity() > 0) {
      setBuilderAssistDiag(creep, { state: 'HARVEST', targetId: lowTargetInfo && lowTargetInfo.target ? lowTargetInfo.target.id : null, localEnergyFound: true, collectEnergyAction: collectResult.reason, remoteContainerBootstrap: remoteContainerTarget, handoffWaitSkippedReason: remoteContainerTarget ? 'remote_bootstrap_no_unassigned_wait' : null });
      return;
    }
    if (gotEnergy && creep.store.getFreeCapacity() > 0) { clearBuilderHandoffWaitMemory(creep); setBuilderAssistDiag(creep, { state: 'HARVEST', targetId: lowTargetInfo && lowTargetInfo.target ? lowTargetInfo.target.id : null, handoffPublished: !!lowTargetInfo, handoffAssigned: false, waitedForHandoff: false, selfHarvestUsed: false, reason: 'collect_energy', collectTargetFound: true, localEnergyFound: true, collectEnergyAction: collectResult ? collectResult.reason : null, goHomeForEnergy: collectResult ? (collectResult.reason === 'travel_home' || collectResult.reason === 'travel_home_fallback') : false }); return; }
    var shouldTrySelfHarvest = !collectResult || !collectResult.acted || collectResult.reason === 'no_energy';
    if (lowTargetInfo && shouldTrySelfHarvest && (!CFG.SELF_HARVEST_AFTER_HANDOFF_WAIT || (creep.memory.builderHandoffWaitUntil || 0) < Game.time)) {
      if (isRemoteContainerBuildTarget(lowTargetInfo)) {
        var bootstrapHarvest = tryRemoteBootstrapSelfHarvest(creep, lowTargetInfo);
        if (bootstrapHarvest.acted) return;
      } else if (!gotEnergy && tryEmergencySelfHarvest(creep, lowTargetInfo)) return;
    }
    if (creep.store.getFreeCapacity() === 0) { clearBuilderHandoffWaitMemory(creep); Handoff.clearEnergyHandoffRequest(creep); setBuilderState(creep, CFG.BUILDER_STATES.IDLE); }
    setBuilderAssistDiag(creep, { state: 'HARVEST', targetId: lowTargetInfo && lowTargetInfo.target ? lowTargetInfo.target.id : null, handoffPublished: !!lowTargetInfo, handoffAssigned: false, waitedForHandoff: false, selfHarvestUsed: false, reason: 'idle_no_energy', collectTargetFound: false, collectEnergyAction: collectResult ? collectResult.reason : null, goHomeForEnergy: collectResult ? (collectResult.reason === 'travel_home' || collectResult.reason === 'travel_home_fallback') : false, targetRoom: lowTargetInfo && lowTargetInfo.target && lowTargetInfo.target.pos ? lowTargetInfo.target.pos.roomName : null, remoteContainerBootstrap: isRemoteContainerBuildTarget(lowTargetInfo), handoffWaitSkippedReason: isRemoteContainerBuildTarget(lowTargetInfo) ? 'remote_bootstrap_self_harvest_priority' : null, carriedEnergy: creep.store[RESOURCE_ENERGY] || 0 });
    return;
  }

  var targetInfo = getBuilderTarget(creep);
  if (!targetInfo) { Handoff.clearEnergyHandoffRequest(creep); if (dumpEnergyToSink(creep)) return; setBuilderState(creep, CFG.BUILDER_STATES.IDLE); idleNearAnchor(creep); return; }
  if (state === CFG.BUILDER_STATES.IDLE) { setBuilderState(creep, CFG.BUILDER_STATES.TRAVEL); state = CFG.BUILDER_STATES.TRAVEL; }
  if (state === CFG.BUILDER_STATES.TRAVEL) { if (handleTravel(creep, targetInfo)) return; state = getBuilderState(creep); }
  if (state === CFG.BUILDER_STATES.BUILD) { clearBuilderHandoffWaitMemory(creep); if (handleBuild(creep, targetInfo.target)) return; return; }
  setBuilderState(creep, CFG.BUILDER_STATES.IDLE);
  idleNearAnchor(creep);
}

module.exports = { run: run };
