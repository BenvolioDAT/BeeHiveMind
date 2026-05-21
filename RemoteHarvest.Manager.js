'use strict';

var LunaConfig = require('role.Luna.Config');
var RoadPlanner = require('Planner.Road');

var RESERVE_TTL = 100;

function ensureMemory() {
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.remoteHarvest) {
    Memory.__BHM.remoteHarvest = { tick: Game.time, homes: {} };
  }
  if (!Memory.__BHM.remoteHarvest.homes) Memory.__BHM.remoteHarvest.homes = {};
  Memory.__BHM.remoteHarvest.tick = Game.time;
  return Memory.__BHM.remoteHarvest;
}

function ensureHomeMemory(homeRoom) {
  var root = ensureMemory();
  if (!root.homes[homeRoom]) {
    root.homes[homeRoom] = {
      sources: {}, desiredLuna: 0, liveLuna: 0, queuedLuna: 0,
      missingSources: [], unsafeSources: [], staleSources: [], duplicateSources: [], lastAudit: Game.time
    };
  }
  var rec = root.homes[homeRoom];
  if (!rec.sources) rec.sources = {};
  if (!rec.missingSources) rec.missingSources = [];
  if (!rec.unsafeSources) rec.unsafeSources = [];
  if (!rec.staleSources) rec.staleSources = [];
  if (!rec.duplicateSources) rec.duplicateSources = [];
  return rec;
}

function getRoomMemoryBucket(roomName) {
  Memory.rooms = Memory.rooms || {};
  return (Memory.rooms[roomName] = (Memory.rooms[roomName] || {}));
}

function refreshVisibleRemoteSafety(room) {
  if (!room || !room.name) return false;
  var myName = getMyUsername();
  var ctl = room.controller;
  var owner = ctl && ctl.owner && ctl.owner.username;
  var reservation = ctl && ctl.reservation && ctl.reservation.username;
  var hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
  var invaderCores = room.find(FIND_STRUCTURES, { filter: function (s) { return s.structureType === STRUCTURE_INVADER_CORE; } }) || [];
  var safe = !hostiles.length &&
    !invaderCores.length &&
    !(owner && (!myName || owner !== myName)) &&
    !(reservation && (!myName || reservation !== myName));
  if (!safe) return false;

  var mem = getRoomMemoryBucket(room.name);
  delete mem.lunaBlockedUntil;
  delete mem.lunaBlockedReason;
  delete mem.lunaBlockedAt;
  delete mem.lunaBlocked;
  delete mem.lunaUnsafe;
  delete mem.hostile;
  delete mem.hostileRoom;
  delete mem.threatLevel;
  if (mem._invaderLock && mem._invaderLock.locked) delete mem._invaderLock;
  return true;
}

function isRemoteUnsafe(remoteName) {
  var room = Game.rooms[remoteName];
  if (room) refreshVisibleRemoteSafety(room);
  var mem = (Memory.rooms && Memory.rooms[remoteName]) || {};
  if (mem.lunaBlocked || mem.lunaUnsafe || mem.hostile || mem.hostileRoom) return true;
  if (mem.lunaBlockedUntil && mem.lunaBlockedUntil > Game.time) return true;
  if (mem.lunaInvaderLockUntil && mem.lunaInvaderLockUntil > Game.time) return true;
  if (mem._invaderLock && mem._invaderLock.locked) {
    var lockTick = (typeof mem._invaderLock.t === 'number') ? mem._invaderLock.t : null;
    var lockTtl = (LunaConfig && LunaConfig.INVADER_LOCK_MEMO_TTL) || 1500;
    if (lockTick == null || (Game.time - lockTick) <= lockTtl) return true;
  }
  if (mem.threatLevel && mem.threatLevel > 0) return true;
  var ctl = room && room.controller;
  var myName = getMyUsername();
  if (ctl && ctl.owner && (!myName || ctl.owner.username !== myName)) return true;
  if (ctl && ctl.reservation && (!myName || ctl.reservation.username !== myName)) return true;
  if (room) {
    var hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
    if (hostiles.length > 0) return true;
  }
  return false;
}

function getMyUsername() {
  for (var name in Game.spawns) {
    if (!Object.prototype.hasOwnProperty.call(Game.spawns, name)) continue;
    var spawn = Game.spawns[name];
    if (!spawn || !spawn.owner || !spawn.owner.username) continue;
    return spawn.owner.username;
  }
  return null;
}

function getRemoteIntelTick(remoteName) {
  var mem = Memory.rooms && Memory.rooms[remoteName];
  if (!mem) return null;
  var best = null;
  if (mem.intel) {
    if (typeof mem.intel.lastScanAt === 'number') best = Math.max(best || 0, mem.intel.lastScanAt);
    if (typeof mem.intel.lastVisited === 'number') best = Math.max(best || 0, mem.intel.lastVisited);
    if (typeof mem.intel.t === 'number') best = Math.max(best || 0, mem.intel.t);
  }
  if (mem.scout && typeof mem.scout.lastVisited === 'number') best = Math.max(best || 0, mem.scout.lastVisited);
  if (mem.sources) {
    for (var sid in mem.sources) {
      if (!Object.prototype.hasOwnProperty.call(mem.sources, sid)) continue;
      var s = mem.sources[sid];
      if (!s) continue;
      if (typeof s.lastSeen === 'number') best = Math.max(best || 0, s.lastSeen);
      if (typeof s.lastActive === 'number') best = Math.max(best || 0, s.lastActive);
    }
  }
  return best;
}




function getRouteDistanceBetweenRooms(homeName, remoteName) {
  if (!homeName || !remoteName) return Infinity;
  if (homeName === remoteName) return 0;
  var route = null;
  try { route = Game.map.findRoute(homeName, remoteName); } catch (e) { route = ERR_NO_PATH; }
  if (route === ERR_NO_PATH || !route || !Array.isArray(route)) return Infinity;
  return route.length;
}

function addUniqueRoomName(list, seen, roomName) {
  if (!roomName || seen[roomName]) return;
  seen[roomName] = true;
  list.push(roomName);
}

function gatherCandidateRemoteRoomsForHome(homeRoom) {
  var out = { candidateRemoteRooms: [], acceptedRemoteRooms: [], rejectedRemoteRooms: [] };
  if (!homeRoom) return out;
  var homeName = typeof homeRoom === 'string' ? homeRoom : homeRoom.name;
  var homeObj = typeof homeRoom === 'string' ? Game.rooms[homeRoom] : homeRoom;
  if (!homeName) return out;

  var ttl = (LunaConfig && LunaConfig.LUNA_REMOTE_INTEL_TTL) || 3000;
  var radius = (LunaConfig && LunaConfig.REMOTE_RADIUS) || 3;
  var myName = getMyUsername();
  var discovered = [];
  var seen = Object.create(null);
  var sourceTags = Object.create(null);

  if (RoadPlanner && typeof RoadPlanner.getActiveRemoteRooms === 'function' && homeObj) {
    var active = RoadPlanner.getActiveRemoteRooms(homeObj) || [];
    for (var i = 0; i < active.length; i++) {
      addUniqueRoomName(discovered, seen, active[i]);
      sourceTags[active[i]] = 'roadPlanner';
    }
  }

  var memRooms = Memory.rooms || {};
  for (var rn in memRooms) {
    if (!Object.prototype.hasOwnProperty.call(memRooms, rn)) continue;
    var mem = memRooms[rn] || {};
    var hasMemSources = false;
    if (mem.sources) for (var sid in mem.sources) { if (Object.prototype.hasOwnProperty.call(mem.sources, sid)) { hasMemSources = true; break; } }
    if (!hasMemSources && !(mem.intel && typeof mem.intel.sources === 'number' && mem.intel.sources > 0)) continue;
    if (Game.map.getRoomLinearDistance(homeName, rn) > radius) continue;
    addUniqueRoomName(discovered, seen, rn);
    if (!sourceTags[rn]) sourceTags[rn] = 'memory';
  }

  for (var visibleName in Game.rooms) {
    if (!Object.prototype.hasOwnProperty.call(Game.rooms, visibleName)) continue;
    var visible = Game.rooms[visibleName];
    if (!visible || !visible.find) continue;
    if (Game.map.getRoomLinearDistance(homeName, visibleName) > radius) continue;
    var foundSources = visible.find(FIND_SOURCES) || [];
    if (!foundSources.length) continue;
    addUniqueRoomName(discovered, seen, visibleName);
    if (!sourceTags[visibleName]) sourceTags[visibleName] = 'visible';
  }

  out.candidateRemoteRooms = discovered.slice(0);
  for (var j = 0; j < discovered.length; j++) {
    var remoteName = discovered[j];
    var reason = null;
    var remoteMem = (Memory.rooms && Memory.rooms[remoteName]) || {};
    var remoteVisible = Game.rooms[remoteName];
    var intel = remoteMem.intel || {};

    if (remoteName === homeName) reason = 'home-room';
    else if (Game.map.getRoomLinearDistance(homeName, remoteName) > radius) reason = 'beyond-radius';
    else if (getRouteDistanceBetweenRooms(homeName, remoteName) === Infinity) reason = 'no-route';
    else if (isRemoteUnsafe(remoteName)) {
      if (remoteMem.lunaBlockedReason === 'all-sources-inaccessible') reason = 'all-sources-inaccessible';
      else reason = 'unsafe';
    }
    else if (remoteMem.lunaBlocked) reason = 'luna-blocked';
    else if (remoteVisible && remoteVisible.controller && remoteVisible.controller.owner && (!myName || remoteVisible.controller.owner.username !== myName)) reason = 'owned-by-other';
    else if (remoteVisible && remoteVisible.controller && remoteVisible.controller.reservation && (!myName || remoteVisible.controller.reservation.username !== myName)) reason = 'reserved-by-other';
    else if (intel.owner && (!myName || intel.owner !== myName)) reason = 'intel-owned-by-other';
    else if (intel.reservation && (!myName || intel.reservation !== myName)) reason = 'intel-reserved-by-other';
    else {
      var intelTick = getRemoteIntelTick(remoteName);
      if (!remoteVisible && (intelTick == null || (Game.time - intelTick) > ttl)) reason = 'stale-intel';
    }

    if (reason) out.rejectedRemoteRooms.push({ room: remoteName, reason: reason, source: sourceTags[remoteName] || 'unknown' });
    else out.acceptedRemoteRooms.push(remoteName);
  }

  out.acceptedRemoteRooms.sort(function (a, b) {
    var routeA = getRouteDistanceBetweenRooms(homeName, a);
    var routeB = getRouteDistanceBetweenRooms(homeName, b);
    if (routeA !== routeB) return routeA - routeB;
    var linA = Game.map.getRoomLinearDistance(homeName, a);
    var linB = Game.map.getRoomLinearDistance(homeName, b);
    if (linA !== linB) return linA - linB;
    return a < b ? -1 : (a > b ? 1 : 0);
  });

  return out;
}


function getApprovedRemotesFromScout(homeRoom) {
  var out = { approvedRooms: [], approvedSources: [], rejected: [] };
  var ttl = (LunaConfig && LunaConfig.LUNA_REMOTE_INTEL_TTL) || 3000;
  var intel = Memory.__BHM && Memory.__BHM.scoutIntel && Memory.__BHM.scoutIntel.homes && Memory.__BHM.scoutIntel.homes[homeRoom];
  var rooms = intel && intel.rooms ? intel.rooms : null;
  if (!rooms) return out;
  for (var rn in rooms) {
    if (!Object.prototype.hasOwnProperty.call(rooms, rn)) continue;
    var rec = rooms[rn]; if (!rec) continue;
    var reason = null;
    if (rn === homeRoom) reason = 'home-room';
    else if (rec.routeDistance === Infinity || rec.routeDistance == null) reason = 'no-route';
    else if (!rec.lastSeen || (Game.time - rec.lastSeen) > ttl) reason = 'stale-scout-intel';
    else if (!rec.sources || rec.sources.length <= 0) reason = 'no-sources';
    else if (!rec.remoteEligible) reason = rec.remoteBlockedReason || 'blocked';
    else if (isRemoteUnsafe(rn)) reason = 'unsafe';
    if (reason) { out.rejected.push({ room: rn, reason: reason }); continue; }

    out.approvedRooms.push(rn);
    for (var i = 0; i < rec.sources.length; i++) {
      var src = rec.sources[i];
      if (!src || !src.id || src.accessible === false) continue;
      out.approvedSources.push({ sourceId: src.id, targetRoom: rn, routeDistance: rec.routeDistance, linearDistance: rec.linearDistance, roomName: rn });
    }
  }
  out.approvedRooms.sort(function(a,b){
    var ra = getRouteDistanceBetweenRooms(homeRoom,a), rb = getRouteDistanceBetweenRooms(homeRoom,b);
    if (ra !== rb) return ra-rb;
    var la = Game.map.getRoomLinearDistance(homeRoom,a), lb = Game.map.getRoomLinearDistance(homeRoom,b);
    if (la !== lb) return la-lb;
    return a < b ? -1 : (a > b ? 1 : 0);
  });
  out.approvedSources.sort(function(a,b){
    if (a.routeDistance!==b.routeDistance) return a.routeDistance-b.routeDistance;
    if (a.linearDistance!==b.linearDistance) return a.linearDistance-b.linearDistance;
    if (a.roomName!==b.roomName) return a.roomName < b.roomName ? -1 : 1;
    return a.sourceId < b.sourceId ? -1 : (a.sourceId > b.sourceId ? 1 : 0);
  });
  return out;
}


function ensureRemoteContainerBuildsMemory() {
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.remoteContainerBuilds) Memory.__BHM.remoteContainerBuilds = {};
  return Memory.__BHM.remoteContainerBuilds;
}

function isUnfinishedContainerBuild(sourceRec) {
  if (!sourceRec || !sourceRec.sourceId) return false;
  if (sourceRec.remoteRoom && isRemoteUnsafe(sourceRec.remoteRoom)) return false;

  var containerRec = sourceRec.container;
  if (containerRec && (containerRec.status === 'planned' || containerRec.status === 'building' || containerRec.status === 'missing')) {
    return true;
  }

  var builds = ensureRemoteContainerBuildsMemory();
  var buildRec = builds[sourceRec.sourceId];
  if (!buildRec) return false;
  if (buildRec.remoteRoom && isRemoteUnsafe(buildRec.remoteRoom)) return false;
  return buildRec.status !== 'built';
}
function buildSourcePlanForHome(homeRoom, remoteRooms) {
  var home = ensureHomeMemory(homeRoom);
  var oldSources = home.sources || {};
  home.sources = {};
  home.unsafeSources = [];
  home.staleSources = [];

  var ttl = (LunaConfig && LunaConfig.LUNA_REMOTE_INTEL_TTL) || 3000;
  for (var i = 0; i < (remoteRooms || []).length; i++) {
    var remoteRoom = remoteRooms[i];
    if (!remoteRoom) continue;
    if (isRemoteUnsafe(remoteRoom)) { home.unsafeSources.push(remoteRoom); continue; }

    var intelTick = getRemoteIntelTick(remoteRoom);
    if (!Game.rooms[remoteRoom] && (intelTick == null || (Game.time - intelTick) > ttl)) {
      home.staleSources.push(remoteRoom);
      continue;
    }

    var list = [];
    var live = Game.rooms[remoteRoom];
    if (live) {
      var found = live.find(FIND_SOURCES) || [];
      for (var f = 0; f < found.length; f++) list.push(found[f]);
    } else {
      var mem = (Memory.rooms && Memory.rooms[remoteRoom]) || {};
      if (mem.sources) {
        for (var sid in mem.sources) {
          if (!Object.prototype.hasOwnProperty.call(mem.sources, sid)) continue;
          list.push({ id: sid, pos: mem.sources[sid].pos || mem.sources[sid] });
        }
      }
    }

    var blockedInRoom = 0;
    var totalInRoom = 0;
    for (var j = 0; j < list.length; j++) {
      var src = list[j];
      if (!src || !src.id) continue;
      totalInRoom++;
      var srcMem = (Memory.rooms && Memory.rooms[remoteRoom] && Memory.rooms[remoteRoom].sources && Memory.rooms[remoteRoom].sources[src.id]) || {};
      if (srcMem.lunaBlockedUntil && srcMem.lunaBlockedUntil > Game.time) {
        blockedInRoom++;
        continue;
      }
      var prev = oldSources[src.id] || {};
      var x = src.pos && typeof src.pos.x === 'number' ? src.pos.x : (typeof prev.x === 'number' ? prev.x : null);
      var y = src.pos && typeof src.pos.y === 'number' ? src.pos.y : (typeof prev.y === 'number' ? prev.y : null);
      home.sources[src.id] = {
        sourceId: src.id, homeRoom: homeRoom, remoteRoom: remoteRoom,
        x: x, y: y,
        containerId: prev.containerId || null,
        container: prev.container || null,
        assignedLuna: prev.assignedLuna || null,
        reservedBy: prev.reservedBy || null,
        reservedUntil: prev.reservedUntil || 0,
        lastSeen: Game.time,
        lastActive: prev.lastActive || 0,
        status: 'open',
        reason: 'planned'
      };
    }
    if (totalInRoom > 0 && blockedInRoom >= totalInRoom) home.unsafeSources.push(remoteRoom + ':all-sources-blocked');
  }

  return home;
}

function auditAssignmentsForHome(homeRoom) {
  var home = ensureHomeMemory(homeRoom);
  var bySource = {};
  var liveCount = 0;

  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var c = Game.creeps[name];
    if (!c || !c.memory) continue;
    if (c.memory.role !== 'Luna' && c.memory.task !== 'luna' && c.memory.task !== 'remoteharvest') continue;
    var chome = c.memory.home || c.memory._home || (c.room && c.room.name);
    if (chome !== homeRoom) continue;
    liveCount++;
    if (!c.memory.sourceId) continue;
    if (!bySource[c.memory.sourceId]) bySource[c.memory.sourceId] = [];
    bySource[c.memory.sourceId].push(c);
  }

  home.liveLuna = liveCount;
  home.duplicateSources = [];
  home.missingSources = [];
  var queuedSources = [];
  var queuedBySource = {};
  var duplicateQueuedSources = [];
  var assignedSources = [];
  var unfinishedContainerSources = [];
  var sourceQueueDecisions = {};
  var queued = 0;
  var spawnQueue = (Memory.rooms && Memory.rooms[homeRoom] && Memory.rooms[homeRoom].spawnQueue) || [];
  for (var q = 0; q < spawnQueue.length; q++) {
    var item = spawnQueue[q];
    if (!item || item.role !== 'Luna' || !item.sourceId) continue;
    queuedBySource[item.sourceId] = (queuedBySource[item.sourceId] || 0) + 1;
  }

  for (var sid in home.sources) {
    if (!Object.prototype.hasOwnProperty.call(home.sources, sid)) continue;
    var rec = home.sources[sid];
    if (!rec) continue;
    var rmem = (Memory.rooms && Memory.rooms[rec.remoteRoom] && Memory.rooms[rec.remoteRoom].sources && Memory.rooms[rec.remoteRoom].sources[sid]) || {};
    if (rmem.lunaBlockedUntil && rmem.lunaBlockedUntil > Game.time) {
      rec.status = 'blocked';
      rec.reason = rmem.lunaBlockedReason || 'source-blocked';
      continue;
    }

    if (rec.reservedUntil && rec.reservedUntil <= Game.time) {
      rec.reservedBy = null;
      rec.reservedUntil = 0;
    }
    var hasQueueItemsForSource = queuedBySource[sid] > 0;
    if (rec.reservedBy && rec.reservedUntil > Game.time && !hasQueueItemsForSource && String(rec.reservedBy).indexOf('queue:') === 0) {
      rec.reservedBy = null;
      rec.reservedUntil = 0;
      sourceQueueDecisions[sid] = 'cleared-stale-reservation-no-queue-item';
    }
    if (rec.reservedBy && rec.reservedUntil > Game.time && !hasQueueItemsForSource) queued++;
    if (hasQueueItemsForSource) {
      rec.reservedBy = rec.reservedBy || ('queue:spawnQueue:' + sid);
      rec.reservedUntil = Math.max(rec.reservedUntil || 0, Game.time + RESERVE_TTL);
      queued += queuedBySource[sid];
      queuedSources.push(sid);
      if (hasQueueItemsForSource && queuedBySource[sid] > 1) duplicateQueuedSources.push(sid);
    }

    if (rec.assignedLuna && !Game.creeps[rec.assignedLuna]) rec.assignedLuna = null;

    var contenders = bySource[sid] || [];
    if (contenders.length > 1) {
      contenders.sort(function (a, b) {
        var at = a.memory && typeof a.memory._assignTick === 'number' ? a.memory._assignTick : 99999999;
        var bt = b.memory && typeof b.memory._assignTick === 'number' ? b.memory._assignTick : 99999999;
        if (at !== bt) return at - bt;
        return a.name < b.name ? -1 : 1;
      });
      for (var d = 1; d < contenders.length; d++) contenders[d].memory._forceYield = true;
      home.duplicateSources.push(sid);
    }

    if (contenders.length > 0) {
      rec.assignedLuna = contenders[0].name;
      rec.status = 'assigned';
      rec.reason = 'live-luna';
      rec.lastActive = Game.time;
      assignedSources.push(sid);
      rec.reservedBy = null;
      rec.reservedUntil = 0;
      sourceQueueDecisions[sid] = 'assigned-live-luna';
    } else if ((rec.reservedBy && rec.reservedUntil > Game.time) || hasQueueItemsForSource) {
      rec.status = 'queued';
      rec.reason = rec.reservedBy;
      sourceQueueDecisions[sid] = hasQueueItemsForSource ? 'queued-spawnQueue' : 'queued-reserved';
    } else {
      rec.status = 'open';
      rec.reason = 'missing-luna';
      if (isUnfinishedContainerBuild(rec)) {
        rec.reason = 'unfinished-container';
        if (rec.container) rec.container.status = rec.container.status || 'missing';
        unfinishedContainerSources.push(sid);
        sourceQueueDecisions[sid] = 'missing-luna-unfinished-container';
      } else {
        sourceQueueDecisions[sid] = 'missing-luna';
      }
      home.missingSources.push(sid);
    }
  }

  home.desiredLuna = Object.keys(home.sources).length;
  home.queuedLuna = queued;
  home.lastAudit = Game.time;

  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[homeRoom]) Memory.rooms[homeRoom] = {};
  Memory.rooms[homeRoom].lastRemoteHarvestPlan = {
    tick: Game.time,
    desiredLuna: home.desiredLuna,
    liveLuna: home.liveLuna,
    queuedLuna: home.queuedLuna,
    queuedSources: queuedSources,
    duplicateQueuedSources: duplicateQueuedSources,
    missingSources: home.missingSources.slice(0),
    unfinishedContainerSources: unfinishedContainerSources,
    assignedSources: assignedSources,
    unsafeSources: home.unsafeSources.slice(0),
    staleSources: home.staleSources.slice(0),
    duplicateSources: home.duplicateSources.slice(0),
    blockedSources: Object.keys(home.sources).filter(function (sid) {
      var src = home.sources[sid];
      var rs = src && Memory.rooms && Memory.rooms[src.remoteRoom] && Memory.rooms[src.remoteRoom].sources && Memory.rooms[src.remoteRoom].sources[sid];
      return !!(rs && rs.lunaBlockedUntil && rs.lunaBlockedUntil > Game.time);
    }),
    sourceQueueDecisions: sourceQueueDecisions,
    notes: 'one Luna per approved source'
  };

  return home;
}

function unreserveSourceForQueue(homeRoom, sourceId) {
  var home = ensureHomeMemory(homeRoom);
  var rec = home.sources[sourceId];
  if (!rec) return false;
  if (rec.assignedLuna) return false;
  rec.reservedBy = null;
  rec.reservedUntil = 0;
  if (rec.status === 'queued') {
    rec.status = 'open';
    rec.reason = 'enqueue-failed';
  }
  return true;
}

function reserveSourceForQueue(homeRoom) {
  var home = ensureHomeMemory(homeRoom);
  var pick = null;
  var unfinishedFirst = [];
  var normalMissing = [];
  for (var i = 0; i < home.missingSources.length; i++) {
    var sidList = home.missingSources[i];
    var recList = home.sources[sidList];
    if (!recList) continue;
    if (isUnfinishedContainerBuild(recList)) unfinishedFirst.push(sidList);
    else normalMissing.push(sidList);
  }
  var orderedMissing = unfinishedFirst.concat(normalMissing);
  for (var i = 0; i < orderedMissing.length; i++) {
    var sid = orderedMissing[i];
    var rec = home.sources[sid];
    if (!rec || rec.assignedLuna) continue;
    if (isRemoteUnsafe(rec.remoteRoom)) continue;
    var roomSourceMem = (Memory.rooms && Memory.rooms[rec.remoteRoom] && Memory.rooms[rec.remoteRoom].sources && Memory.rooms[rec.remoteRoom].sources[sid]) || {};
    if (roomSourceMem.lunaBlockedUntil && roomSourceMem.lunaBlockedUntil > Game.time) continue;
    if (rec.reservedBy && rec.reservedUntil > Game.time) continue;
    pick = rec; break;
  }
  if (!pick) return null;
  pick.reservedBy = 'queue:' + Game.time + ':' + pick.sourceId;
  pick.reservedUntil = Game.time + RESERVE_TTL;
  pick.status = 'queued';
  pick.reason = pick.reservedBy;
  return { sourceId: pick.sourceId, targetRoom: pick.remoteRoom };
}

function claimSource(creep, sourceId, targetRoom) {
  if (!creep || !creep.memory) return false;
  var homeRoom = creep.memory.home || creep.memory._home || (creep.room && creep.room.name);
  if (!homeRoom || !sourceId) return false;
  var home = ensureHomeMemory(homeRoom);
  var rec = home.sources[sourceId];
  if (!rec) return false;
  rec.assignedLuna = creep.name;
  rec.remoteRoom = targetRoom || rec.remoteRoom;
  rec.reservedBy = null;
  rec.reservedUntil = 0;
  rec.status = 'assigned';
  rec.reason = 'claimed';
  rec.lastActive = Game.time;
  return true;
}

function releaseSource(creep) {
  if (!creep || !creep.memory || !creep.memory.sourceId) return false;
  var homeRoom = creep.memory.home || creep.memory._home || (creep.room && creep.room.name);
  if (!homeRoom) return false;
  var home = ensureHomeMemory(homeRoom);
  var rec = home.sources[creep.memory.sourceId];
  if (!rec) return false;
  if (rec.assignedLuna === creep.name) rec.assignedLuna = null;
  rec.status = 'open';
  rec.reason = 'released';
  rec.reservedBy = null;
  rec.reservedUntil = 0;
  return true;
}

module.exports = {
  getApprovedRemotesFromScout: getApprovedRemotesFromScout,
  ensureMemory: ensureMemory,
  ensureHomeMemory: ensureHomeMemory,
  gatherCandidateRemoteRoomsForHome: gatherCandidateRemoteRoomsForHome,
  buildSourcePlanForHome: buildSourcePlanForHome,
  auditAssignmentsForHome: auditAssignmentsForHome,
  reserveSourceForQueue: reserveSourceForQueue,
  unreserveSourceForQueue: unreserveSourceForQueue,
  claimSource: claimSource,
  releaseSource: releaseSource
};
