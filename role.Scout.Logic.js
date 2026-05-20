'use strict';

// Scout behavior implementation only. Public role wiring stays in role.Scout.js.
const BeeCombatSquads = require('BeeCombatSquads');
var CFG = require('role.Scout.Config');

function debugLabel(room, pos, text, color) {
  if (!CFG.DEBUG_DRAW || !room || !room.visual || !pos || !text) return;
  try {
    room.visual.text(text, pos.x, pos.y - 1.2, {
      color: color || CFG.DRAW.TEXT, font: CFG.DRAW.FONT, opacity: CFG.DRAW.OPACITY, align: "center",
      backgroundColor: "#000000", backgroundOpacity: 0.25
    });
  } catch (e) {}
}

function ensureCombatIntelMemory() {
  if (BeeCombatSquads && BeeCombatSquads.SquadFlagIntel && typeof BeeCombatSquads.SquadFlagIntel.ensureMemory === 'function') return BeeCombatSquads.SquadFlagIntel.ensureMemory();
  if (!Memory.squadFlags) Memory.squadFlags = { rooms: {}, bindings: {} };
  if (!Memory.squadFlags.rooms) Memory.squadFlags.rooms = {};
  if (!Memory.squadFlags.bindings) Memory.squadFlags.bindings = {};
  return Memory.squadFlags;
}
function ensureRemoteSquadMemory(flagName) { if (!flagName) return null; if (!Memory.squads) Memory.squads = {}; var bucket = Memory.squads[flagName]; if (!bucket) { bucket = { state: 'INIT', targetId: null, members: { leader: null, buddy: null, medic: null }, rally: null, lastSeenTick: 0 }; Memory.squads[flagName] = bucket; } else { if (!bucket.members) bucket.members = { leader: null, buddy: null, medic: null }; if (!bucket.state) bucket.state = 'INIT'; } return bucket; }
function ensureThreatCache() { if (!global.__beeThreatIntelCache || global.__beeThreatIntelCache.tick !== Game.time) global.__beeThreatIntelCache = { tick: Game.time, spawnRooms: null, distance: {} }; if (!global.__beeThreatIntelCache.distance) global.__beeThreatIntelCache.distance = {}; return global.__beeThreatIntelCache; }
function listOwnedSpawnRooms() { var cache = ensureThreatCache(); if (cache.spawnRooms) return cache.spawnRooms; var seen = {}; var list = []; for (var name in Game.spawns) { if (!Game.spawns.hasOwnProperty(name)) continue; var spawn = Game.spawns[name]; if (!spawn || !spawn.my) continue; var roomName = (spawn.room && spawn.room.name) || (spawn.pos && spawn.pos.roomName); if (!roomName || seen[roomName]) continue; seen[roomName] = true; list.push(roomName); } cache.spawnRooms = list; return list; }

function roomDistanceFromOwnedSpawn(roomName) {
  if (!roomName) return Infinity;
  var cache = ensureThreatCache();
  if (cache.distance[roomName] != null) return cache.distance[roomName];
  var spawnRooms = listOwnedSpawnRooms();
  var best = Infinity;
  for (var i = 0; i < spawnRooms.length; i++) {
    var owned = spawnRooms[i];
    if (owned === roomName) { best = 0; break; }
    var route = null;
    try { route = Game.map.findRoute(roomName, owned); } catch (e) { route = ERR_NO_PATH; }
    if (route === ERR_NO_PATH || route == null) continue;
    var dist = Array.isArray(route) ? route.length : (typeof route.length === 'number' ? route.length : Infinity);
    if (dist < best) best = dist;
  }
  cache.distance[roomName] = best;
  return best;
}

function computeThreatBundle(room) {
  if (!room) return { score: 0, hasThreat: false, bestId: null };
  if (BeeCombatSquads && typeof BeeCombatSquads.getLiveThreatForRoom === 'function') {
    try { var data = BeeCombatSquads.getLiveThreatForRoom(room); if (data) return data; } catch (e) {}
  }
  var hostiles = [];
  try { hostiles = room.find(FIND_HOSTILE_CREEPS) || []; } catch (err) {}
  var bestId = hostiles.length ? hostiles[0].id : null;
  return { score: hostiles.length * 5, hasThreat: hostiles.length > 0, bestId: bestId };
}

function recordThreatIntel(room, threatBundle, shouldEscalate, sourceTag, distance) {
  if (!room) return;
  var roomName = room.name || (room.pos ? room.pos.roomName : null);
  if (!roomName) return;
  var intel = ensureCombatIntelMemory();
  if (!intel) return;
  if (!intel.rooms) intel.rooms = {};
  var rec = intel.rooms[roomName];
  if (!rec) rec = { lastSeen: 0, lastThreatAt: 0, lastPos: null, lastScore: 0 };
  rec.lastSeen = Game.time;
  var anchor = null;
  if (room.controller && room.controller.pos) anchor = room.controller.pos;
  else if (room.storage && room.storage.pos) anchor = room.storage.pos;
  else if (room.pos) anchor = room.pos;
  else anchor = new RoomPosition(25, 25, roomName);
  rec.lastPos = { x: anchor.x, y: anchor.y, roomName: roomName };
  if (distance != null) rec.lastDistanceFromSpawn = distance;
  if (sourceTag) rec.lastIntelSource = sourceTag;
  var score = (threatBundle && typeof threatBundle.score === 'number') ? threatBundle.score : 0;
  var sawThreat = Boolean(threatBundle && threatBundle.hasThreat);
  if (shouldEscalate) {
    rec.lastScore = score;
    if (sawThreat) rec.lastThreatAt = Game.time;
    else if (rec.lastScore > 0) {
      var since = Game.time - (rec.lastThreatAt || rec.lastSeen || 0);
      if (since > CFG.THREAT_DECAY_TICKS_COPY) rec.lastScore = 0;
    }
    if (rec.deferredThreat) delete rec.deferredThreat;
  } else {
    rec.lastScore = 0;
    if (sawThreat && score > 0) { rec.deferredThreat = { score: score, lastSeen: Game.time, distance: distance, source: sourceTag || 'Scout' }; rec.lastThreatAt = Game.time; }
    else if (rec.deferredThreat) delete rec.deferredThreat;
  }
  intel.rooms[roomName] = rec;
}

function evaluateRoomThreat(room, sourceTag) { if (!room) return null; var threatBundle = computeThreatBundle(room); var distance = roomDistanceFromOwnedSpawn(room.name); var canEscalate = (distance <= CFG.REMOTE_DEFENSE_MAX_DISTANCE); var allowScore = (!threatBundle || !threatBundle.hasThreat) ? true : canEscalate; recordThreatIntel(room, threatBundle, allowScore, sourceTag, distance); return { threat: threatBundle, distance: distance, canEscalate: canEscalate }; }
function ensureRemoteDefensePlan(room, threatBundle, distance) {
  if (!room || !threatBundle || !threatBundle.hasThreat || !(threatBundle.score > 0)) return;
  var flagName = 'Squad' + room.name;
  var bucket = Memory.squads && Memory.squads[flagName] ? Memory.squads[flagName] : null;
  if (bucket && !bucket.remoteDefense && !bucket.autoDefense) return;
  bucket = ensureRemoteSquadMemory(flagName);
  if (!bucket) return;
  bucket.remoteDefense = true;
  if (!bucket.planType) bucket.planType = 'REMOTE_DEFENSE';
  bucket.targetRoom = room.name;
  bucket.lastKnownScore = threatBundle.score;
  bucket.lastDefenseTick = Game.time;
  bucket.lastSeenTick = Game.time;
  bucket.lastDistance = distance;
  var rallyPos = (room.controller && room.controller.pos) || (room.storage && room.storage.pos) || new RoomPosition(25, 25, room.name);
  bucket.rally = { x: rallyPos.x, y: rallyPos.y, roomName: rallyPos.roomName };
  var attackPos = null;
  if (threatBundle.bestId) { var obj = Game.getObjectById(threatBundle.bestId); if (obj && obj.pos) attackPos = obj.pos; }
  if (!attackPos) attackPos = rallyPos;
  var serialized = { x: attackPos.x, y: attackPos.y, roomName: attackPos.roomName };
  bucket.targetPos = serialized; bucket.focusTargetPos = serialized; bucket.target = serialized; bucket.targetId = threatBundle.bestId || null; bucket.focusTarget = threatBundle.bestId || null; bucket.requestedAt = Game.time;
  var intel = ensureCombatIntelMemory(); if (intel && intel.bindings) intel.bindings[flagName] = { flagName: flagName, target: serialized, targetId: bucket.targetId, source: 'Scout' };
}

var STATE_IDLE = 'IDLE'; var STATE_TRAVEL = 'TRAVEL'; var STATE_SCOUT = 'SCOUT'; var STATE_RETURN = 'RETURN';
function stampVisit(roomName) { if (!roomName) return; if (!Memory.rooms) Memory.rooms = {}; if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {}; var rm = Memory.rooms[roomName]; if (!rm.scout) rm.scout = {}; rm.scout.lastVisited = Game.time; }
function lastVisited(roomName) { if (!Memory.rooms) return -Infinity; var mr = Memory.rooms[roomName]; var scout = mr && mr.scout; return (scout && typeof scout.lastVisited === 'number') ? scout.lastVisited : -Infinity; }
function shouldLogIntel(room) { var r = (Memory.rooms && Memory.rooms[room.name]) ? Memory.rooms[room.name] : null; var lastScan = (r && r.intel && r.intel.lastScanAt) ? r.intel.lastScanAt : -Infinity; return (Game.time - lastScan) >= CFG.INTEL_INTERVAL; }
function getMyUsername(creep) { if (creep && creep.owner && creep.owner.username) return creep.owner.username; for (var name in Game.spawns) { var sp = Game.spawns[name]; if (sp && sp.my && sp.owner && sp.owner.username) return sp.owner.username; } for (var r in Game.rooms) { var rm = Game.rooms[r]; if (rm && rm.controller && rm.controller.my && rm.controller.owner && rm.controller.owner.username) return rm.controller.owner.username; } return null; }
function getRoomIntel(roomName) { if (!Memory.rooms) return null; var mr = Memory.rooms[roomName]; return (mr && mr.intel) ? mr.intel : null; }
function shouldScoutSkipPlayerRoom(roomName, creep) { var intel = getRoomIntel(roomName); if (!intel) return false; var myName = getMyUsername(creep); if (intel.owner && intel.owner !== 'Invader' && intel.owner !== myName) return true; if (intel.reservation && intel.reservation !== 'Invader' && intel.reservation !== myName) return true; return false; }
function seedSourcesFromVision(room) { if (!room) return; Memory.rooms = Memory.rooms || {}; var rm = Memory.rooms[room.name] = (Memory.rooms[room.name] || {}); rm.sources = rm.sources || {}; var arr = room.find(FIND_SOURCES); for (var i = 0; i < arr.length; i++) { var s = arr[i]; var rec = rm.sources[s.id] = (rm.sources[s.id] || {}); rec.roomName = room.name; rec.x = s.pos.x; rec.y = s.pos.y; rec.lastSeen = Game.time; } }

function logRoomIntel(room) {
  if (!room) return;
  Memory.rooms = Memory.rooms || {};
  var rmem = Memory.rooms[room.name] = (Memory.rooms[room.name] || {});
  var intel = rmem.intel = (rmem.intel || {});
  intel.lastVisited = Game.time; intel.lastScanAt = Game.time; intel.sources = room.find(FIND_SOURCES).length;
  var c = room.controller;
  if (c) { intel.owner = (c.owner && c.owner.username) || null; intel.reservation = (c.reservation && c.reservation.username) || null; intel.rcl = c.level || 0; intel.safeMode = c.safeMode || 0; }
  var cores = room.find(FIND_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_INVADER_CORE; } });
  if (cores.length) { var core = cores[0]; intel.invaderCore = { present: true, x: core.pos.x, y: core.pos.y, level: (typeof core.level === 'number' ? core.level : null), ticksToDeploy: (typeof core.ticksToDeploy === 'number' ? core.ticksToDeploy : null), t: Game.time }; }
  else intel.invaderCore = intel.invaderCore && intel.invaderCore.present ? intel.invaderCore : { present: false, t: Game.time };
  var lairs = room.find(FIND_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_KEEPER_LAIR; } }); intel.keeperLairs = lairs.length;
  var mins = room.find(FIND_MINERALS);
  if (mins.length) { var m0 = mins[0]; intel.mineral = { type: m0.mineralType || null, x: m0.pos.x, y: m0.pos.y, amount: (typeof m0.mineralAmount === 'number' ? m0.mineralAmount : null), t: Game.time }; }
  var deps = [];
  if (typeof FIND_DEPOSITS !== 'undefined') { var dlist = room.find(FIND_DEPOSITS) || []; for (var i = 0; i < dlist.length; i++) { var d = dlist[i]; deps.push({ x: d.pos.x, y: d.pos.y, type: d.depositType || null, cooldown: d.cooldown || 0 }); } }
  intel.deposits = deps;
  var pbs = room.find(FIND_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_POWER_BANK; } });
  if (pbs.length) { var pb = pbs[0]; intel.powerBank = { x: pb.pos.x, y: pb.pos.y, hits: pb.hits, power: pb.power, ticksToDecay: pb.ticksToDecay }; } else intel.powerBank = null;
  var portals = room.find(FIND_STRUCTURES, { filter:function(s){return s.structureType===STRUCTURE_PORTAL;} }); var plist = [];
  for (var p = 0; p < portals.length; p++) { var pr = portals[p]; plist.push({ x: pr.pos.x, y: pr.pos.y, toRoom: (pr.destination && pr.destination.roomName) || null, toShard: (pr.destination && pr.destination.shard) || null, decay: (typeof pr.ticksToDecay !== 'undefined' ? pr.ticksToDecay : null) }); }
  intel.portals = plist;
  var enemySpawns = room.find(FIND_HOSTILE_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_SPAWN; } });
  var enemyTowers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_TOWER; } });
  var spArr = []; var twArr = []; for (var si = 0; si < enemySpawns.length; si++) spArr.push({ x: enemySpawns[si].pos.x, y: enemySpawns[si].pos.y }); for (var ti = 0; ti < enemyTowers.length; ti++) twArr.push({ x: enemyTowers[ti].pos.x, y: enemyTowers[ti].pos.y }); intel.enemySpawns = spArr; intel.enemyTowers = twArr;
  intel.hostiles = room.find(FIND_HOSTILE_CREEPS).length;
  seedSourcesFromVision(room);
  evaluateRoomThreat(room, 'Scout');
  if (CFG.DEBUG_DRAW) { var tag = (intel.owner ? ('👑 ' + intel.owner) : (intel.reservation ? ('📌 ' + intel.reservation) : 'free')); var extras = []; if (intel.invaderCore && intel.invaderCore.present) extras.push('IC'); if (intel.powerBank) extras.push('PB'); if (intel.keeperLairs) extras.push('SK:' + intel.keeperLairs); var text = tag + ' • src:' + intel.sources + (extras.length ? ' • ' + extras.join(',') : ''); var center = new RoomPosition(25,25,room.name); debugLabel(room, center, text, CFG.DRAW.INTEL); }
}

function ensureScoutIdentity(creep) { if (!creep || !creep.memory) return; creep.memory.role = 'Scout'; if (!creep.memory.task) creep.memory.task = 'scout'; }
function ensureScoutMem(creep) {
  ensureScoutIdentity(creep);
  if (!creep.memory.scout) creep.memory.scout = {};
  var m = creep.memory.scout;
  if (!m.home) {
    var spawns = [];
    for (var k in Game.spawns) if (Game.spawns.hasOwnProperty(k)) spawns.push(Game.spawns[k]);
    if (spawns.length) {
      var best = spawns[0]; var bestD = Game.map.getRoomLinearDistance(creep.pos.roomName, best.pos.roomName);
      for (var i = 1; i < spawns.length; i++) { var s = spawns[i]; var d = Game.map.getRoomLinearDistance(creep.pos.roomName, s.pos.roomName); if (d < bestD) { best = s; bestD = d; } }
      m.home = best.pos.roomName;
    } else if (Memory.firstSpawnRoom) m.home = Memory.firstSpawnRoom;
    else m.home = creep.pos.roomName;
  }
  if (m.targetRoom == null && creep.memory.targetRoom) m.targetRoom = creep.memory.targetRoom;
  if (!m.state) m.state = STATE_IDLE;
  if (typeof m.exitIndex !== 'number') m.exitIndex = 0;
  return m;
}


function getScoutMapRoomStatus(roomName) { if (!roomName || !Game.map || typeof Game.map.getRoomStatus !== 'function') return null; try { return Game.map.getRoomStatus(roomName) || null; } catch (e) { return null; } }
function isScoutRoomClosed(roomName) { var status = getScoutMapRoomStatus(roomName); return !!(status && status.status === 'closed'); }
function isScoutTargetReachableFrom(creep, targetRoomName) {
  if (!creep || !targetRoomName) return false;
  if (isScoutRoomClosed(targetRoomName)) return false;
  if (creep.pos.roomName === targetRoomName) return true;
  var dist = Game.map.getRoomLinearDistance(creep.pos.roomName, targetRoomName);
  if (dist === 1) {
    var exits = Game.map.describeExits(creep.pos.roomName) || {};
    for (var k in exits) if (exits[k] === targetRoomName) return true;
    return false;
  }
  var route = null;
  try { route = Game.map.findRoute(creep.pos.roomName, targetRoomName); } catch (e) { route = ERR_NO_PATH; }
  if (route === ERR_NO_PATH || route == null || !Array.isArray(route)) return false;
  return route.length > 0;
}
function rememberBadScoutTarget(mem, roomName, reason) { if (!mem || !roomName) return; if (!mem.badTargets) mem.badTargets = {}; mem.badTargets[roomName] = { tick: Game.time, reason: reason || 'unknown' }; }
function isBadScoutTargetRecently(mem, roomName) { if (!mem || !roomName || !mem.badTargets || !mem.badTargets[roomName]) return false; var rec = mem.badTargets[roomName]; var ttl = 750; if ((Game.time - rec.tick) > ttl) { delete mem.badTargets[roomName]; return false; } return true; }
function clearScoutTarget(creep, mem) { mem.targetRoom = null; mem.arrivedAt = null; creep.memory.targetRoom = null; mem.state = STATE_IDLE; creep.memory.state = STATE_IDLE; }

function getIntelAge(roomName) { var age = Infinity; var intel = ensureCombatIntelMemory(); if (intel && intel.rooms && intel.rooms[roomName] && intel.rooms[roomName].lastSeen) age = Game.time - intel.rooms[roomName].lastSeen; var last = lastVisited(roomName); if (last !== -Infinity) { var alt = Game.time - last; if (age === Infinity || alt > age) age = alt; } return age; }
function chooseTargetRoom(creep, mem) { var desc = Game.map.describeExits(creep.pos.roomName) || {}; var exits = []; for (var dir in desc) { if (!desc.hasOwnProperty(dir)) continue; if (!desc[dir]) continue; exits.push(desc[dir]); } var best = null; var bestScore = -Infinity; for (var i = 0; i < exits.length; i++) { var rn = exits[i]; if (rn === mem.home) continue; if (shouldScoutSkipPlayerRoom(rn, creep)) continue; if (isScoutRoomClosed(rn)) continue; if (isBadScoutTargetRecently(mem, rn)) continue; if (!isScoutTargetReachableFrom(creep, rn)) continue; var age = getIntelAge(rn); var score = age; if (age === Infinity) score = 999999; if (age < CFG.REVISIT_TICKS) score = score / 10; if (score > bestScore) { bestScore = score; best = rn; } } if (!best && exits.length) { var idx = mem.exitIndex || 0; var fallback = exits[idx % exits.length]; if (!isScoutRoomClosed(fallback) && !isBadScoutTargetRecently(mem, fallback) && isScoutTargetReachableFrom(creep, fallback) && !shouldScoutSkipPlayerRoom(fallback, creep)) best = fallback; } mem.exitIndex = (mem.exitIndex + 1) % (exits.length || 1); mem.targetRoom = best || null; mem.arrivedAt = null; mem.state = mem.targetRoom ? STATE_TRAVEL : STATE_IDLE; creep.memory.targetRoom = mem.targetRoom; return mem.targetRoom; }
function refreshState(creep, mem) { if (mem.state === STATE_RETURN) { creep.memory.state = mem.state; return mem.state; } if (mem.targetRoom && creep.pos.roomName === mem.targetRoom) mem.state = STATE_SCOUT; else if (mem.targetRoom) mem.state = STATE_TRAVEL; else mem.state = STATE_IDLE; creep.memory.state = mem.state; return mem.state; }
function updateIntel(creep) { var room = creep.room; if (!room) return null; stampVisit(room.name); if (shouldLogIntel(room)) logRoomIntel(room); seedSourcesFromVision(room); var threatInfo = evaluateRoomThreat(room, 'Scout'); if (threatInfo && threatInfo.threat && threatInfo.threat.hasThreat && threatInfo.canEscalate) ensureRemoteDefensePlan(room, threatInfo.threat, threatInfo.distance); return threatInfo; }
function shouldRetreat(creep, threatInfo) { if (threatInfo && threatInfo.threat && threatInfo.threat.hasThreat && threatInfo.threat.score > 0) return true; var hostiles = (creep.room && creep.room.find) ? creep.room.find(FIND_HOSTILE_CREEPS) : []; return hostiles.length > 0 && creep.hits < creep.hitsMax; }
function wanderRoom(creep) { if (creep.room && creep.room.controller) { creep.travelTo(creep.room.controller, { range: 3, reusePath: 10 }); return; } var center = new RoomPosition(25, 25, creep.pos.roomName); creep.travelTo(center, { range: 10, reusePath: 10 }); }
function returnHome(creep, mem) { var homeRoom = mem.home || creep.pos.roomName; var anchor = new RoomPosition(25, 25, homeRoom); creep.travelTo(anchor, { range: 20, reusePath: CFG.PATH_REUSE }); if (creep.pos.roomName === homeRoom) { mem.state = STATE_IDLE; mem.targetRoom = null; mem.arrivedAt = null; creep.memory.targetRoom = null; } creep.memory.state = mem.state; }


function ensureRemoteVisionRoot() { Memory.__BHM = Memory.__BHM || {}; Memory.__BHM.remoteVisionRequests = Memory.__BHM.remoteVisionRequests || {}; return Memory.__BHM.remoteVisionRequests; }
function pickRemoteVisionRequest(mem) {
  var reqs = ensureRemoteVisionRoot();
  var bestKey = null; var best = null;
  for (var k in reqs) {
    if (!Object.prototype.hasOwnProperty.call(reqs, k)) continue;
    var r = reqs[k]; if (!r) continue;
    if (r.homeRoom && mem.home && r.homeRoom !== mem.home) continue;
    if (r.resolvedAt) continue;
    var pri = Number(r.priority) || 0;
    if (!best || pri > (Number(best.priority)||0) || ((pri === (Number(best.priority)||0)) && (r.requestedAt||0) < (best.requestedAt||0))) { best = r; bestKey = k; }
  }
  return best ? { key: bestKey, req: best } : null;
}
function serviceRemoteVisionRequest(creep, mem) {
  var pick = pickRemoteVisionRequest(mem);
  if (!pick) return false;
  var req = pick.req; Memory.rooms = Memory.rooms || {}; Memory.rooms[mem.home] = Memory.rooms[mem.home] || {}; Memory.rooms[mem.home].lastRemoteVision = { pendingRequests: Object.keys(ensureRemoteVisionRoot()).length, selectedRequest: req.containerId || pick.key, liveScoutAssigned: creep.name, queuedScout: false, reason: 'scoutServingVisionRequest' };
  var targetRoom = req.targetRoom || req.roomName; if (!targetRoom) return false;
  if (creep.pos.roomName !== targetRoom) { creep.travelTo(new RoomPosition(req.x || 25, req.y || 25, targetRoom), { range: 1, reusePath: CFG.PATH_REUSE }); return true; }
  var root = Memory.__BHM = Memory.__BHM || {}; root.remoteContainerStatus = root.remoteContainerStatus || {};
  var id = req.containerId || pick.key;
  var obj = req.containerId ? Game.getObjectById(req.containerId) : null;
  if (!obj && typeof req.x === 'number' && typeof req.y === 'number' && creep.room) {
    var at = creep.room.lookForAt(LOOK_STRUCTURES, req.x, req.y) || [];
    for (var i=0;i<at.length;i++) if (at[i].structureType === STRUCTURE_CONTAINER) { obj = at[i]; break; }
  }
  var rec = root.remoteContainerStatus[id] || { containerId: req.containerId, sourceId: req.sourceId, homeRoom: req.homeRoom, remoteRoom: targetRoom, x: req.x, y: req.y };
  if (obj && obj.structureType === STRUCTURE_CONTAINER) {
    rec.updated = Game.time; rec.lastSeen = Game.time; rec.amount = obj.store[RESOURCE_ENERGY] || 0; rec.capacity = obj.store.getCapacity(RESOURCE_ENERGY) || obj.store.getCapacity() || 2000;
    rec.containerHits = obj.hits; rec.containerHitsMax = obj.hitsMax; rec.containerHitsPct = obj.hitsMax > 0 ? (obj.hits / obj.hitsMax) : null; rec.status = 'built'; rec.stale = false; rec.lastSeenAgo = 0;
  } else {
    rec.updated = Game.time; rec.lastSeen = Game.time; rec.status = 'missing'; rec.missingSeenAt = Game.time; rec.stale = false; rec.lastSeenAgo = 0;
  }
  root.remoteContainerStatus[id] = rec;
  delete ensureRemoteVisionRoot()[pick.key];
  return true;
}

function run(creep) {
  var mem = ensureScoutMem(creep);
  if (serviceRemoteVisionRequest(creep, mem)) return;
  if (!mem.targetRoom) chooseTargetRoom(creep, mem);
  var state = refreshState(creep, mem);
  if (state === STATE_RETURN) { returnHome(creep, mem); return; }
  if (state === STATE_TRAVEL) {
    if (!mem.targetRoom) { mem.state = STATE_IDLE; creep.memory.state = mem.state; return; }
    if (!isScoutTargetReachableFrom(creep, mem.targetRoom)) {
      rememberBadScoutTarget(mem, mem.targetRoom, 'unreachable-before-travel');
      clearScoutTarget(creep, mem);
      chooseTargetRoom(creep, mem);
      return;
    }
    var result = creep.travelTo(new RoomPosition(25, 25, mem.targetRoom), { range: 20, reusePath: CFG.PATH_REUSE });
    if (result === ERR_NO_PATH) {
      rememberBadScoutTarget(mem, mem.targetRoom, 'ERR_NO_PATH');
      clearScoutTarget(creep, mem);
    }
    return;
  }
  if (state === STATE_SCOUT) {
    if (!mem.arrivedAt) mem.arrivedAt = Game.time;
    var threatInfo = updateIntel(creep);
    if (shouldRetreat(creep, threatInfo)) { mem.state = STATE_RETURN; creep.memory.state = mem.state; returnHome(creep, mem); return; }
    wanderRoom(creep);
    if (Game.time - mem.arrivedAt > CFG.ROOM_STAY_TICKS) { mem.targetRoom = null; mem.arrivedAt = null; mem.state = STATE_IDLE; creep.memory.targetRoom = null; }
    creep.memory.state = mem.state;
    return;
  }
  mem.state = STATE_IDLE;
  creep.memory.state = mem.state;
  if (!mem.targetRoom) chooseTargetRoom(creep, mem);
  if (!mem.targetRoom) wanderRoom(creep);
}

module.exports = { run: run };
