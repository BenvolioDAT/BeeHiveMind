'use strict';

// -----------------------------------------------------------------------------
// role.Scout.Logic.js - room intel, remote approval inputs, and emergency vision
// Owns:
// * Scout creep memory under creep.memory.scout plus targetRoom/state fields.
// * Memory.rooms[roomName].scout and Memory.rooms[roomName].intel snapshots.
// * Memory.__BHM.scoutIntel.homes[homeRoom].rooms[remoteRoom], which feeds
//   SourceEnergy.Manager's candidate source diagnostics.
// * Memory.__BHM.remoteVisionRequests assignment/resolution when remote
//   container data is stale.
// Usually called by:
// * BeeHiveMind.runCreeps() through role.Scout.js.
// Systems that depend on it:
// * SourceEnergy.Manager reads scoutIntel for remote room/source approval.
// * BeeSpawnManager may enqueue emergency Scouts when stale remote container
//   status needs vision.
// * BeeCombatSquads/SquadFlagIntel receive threat observations from Scouts.
// Do not casually change:
// * Intel field names, target bad-target TTL, or remoteVisionRequests fields;
//   those are shared with spawn, remote harvest, and repair systems.
// -----------------------------------------------------------------------------
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
  // Shared combat intel root. BeeCombatSquads owns the canonical helper when
  // available; the fallback keeps older Memory layouts working.
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
  // Scouts and Veinseeker both feed this threat timeline. Spawning uses the score
  // later, so this records both "fresh seen" data and deferred threats that are
  // too far away to spawn defenders for immediately.
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
  // Convert a live threat observation into Memory.squads[SquadRoomName]. The
  // spawn manager later sees this as a remoteDefense plan and may spawn combat
  // creeps if the target is allowed.
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
function countOpenTilesAroundSource(room, source) {
  if (!room || !source || !source.pos) return 0;
  var terrain = room.getTerrain();
  var open = 0;
  for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) {
    if (!dx && !dy) continue;
    var x = source.pos.x + dx, y = source.pos.y + dy;
    if (x < 1 || x > 48 || y < 1 || y > 48) continue;
    if (terrain.get(x, y) !== TERRAIN_MASK_WALL) open++;
  }
  return open;
}
function summarizeBestEnergyObject(list, amountFn) {
  var best = null; var bestAmount = 0;
  for (var i = 0; i < list.length; i++) {
    var obj = list[i];
    var amount = amountFn(obj);
    if (amount > bestAmount) { best = obj; bestAmount = amount; }
  }
  if (!best || bestAmount <= 0) return null;
  return { id: best.id, amount: bestAmount, x: best.pos.x, y: best.pos.y, updated: Game.time };
}
function buildVisibleSourceIntel(room, source, access) {
  var containers = source.pos.findInRange(FIND_STRUCTURES, 1, { filter: function (s) { return s.structureType === STRUCTURE_CONTAINER; } }) || [];
  var sites = source.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, { filter: function (s) { return s.structureType === STRUCTURE_CONTAINER; } }) || [];
  var container = containers[0] || null;
  var site = sites[0] || null;
  var containerInfo = {
    status: container ? 'built' : (site ? 'building' : 'missing'),
    containerId: container ? container.id : null,
    siteId: site ? site.id : null,
    x: container ? container.pos.x : (site ? site.pos.x : null),
    y: container ? container.pos.y : (site ? site.pos.y : null),
    progress: site ? site.progress || 0 : (container ? 1 : 0),
    progressTotal: site ? site.progressTotal || 0 : (container ? 1 : 0),
    progressPct: site && site.progressTotal ? Math.floor((site.progress / site.progressTotal) * 100) : (container ? 100 : 0),
    updated: Game.time
  };
  var drops = source.pos.findInRange(FIND_DROPPED_RESOURCES, 3, { filter: function (r) { return r.resourceType === RESOURCE_ENERGY; } }) || [];
  var tombstones = source.pos.findInRange(FIND_TOMBSTONES, 3, { filter: function (t) { return t.store && (t.store[RESOURCE_ENERGY] || 0) > 0; } }) || [];
  var ruins = (typeof FIND_RUINS !== 'undefined') ? (source.pos.findInRange(FIND_RUINS, 3, { filter: function (r) { return r.store && (r.store[RESOURCE_ENERGY] || 0) > 0; } }) || []) : [];
  var openTiles = access && typeof access.openTiles === 'number' ? access.openTiles : countOpenTilesAroundSource(room, source);
  return {
    id: source.id,
    roomName: room.name,
    x: source.pos.x,
    y: source.pos.y,
    lastSeen: Game.time,
    openTiles: openTiles,
    accessible: access ? access.accessible : openTiles > 0,
    blockedReason: access ? access.blockedReason : (openTiles > 0 ? null : 'no-open-harvest-tiles'),
    container: containerInfo,
    nearbyDroppedEnergy: summarizeBestEnergyObject(drops, function (r) { return r.amount || 0; }),
    nearbyTombstoneEnergy: summarizeBestEnergyObject(tombstones, function (t) { return (t.store && t.store[RESOURCE_ENERGY]) || 0; }),
    nearbyRuinEnergy: summarizeBestEnergyObject(ruins, function (r) { return (r.store && r.store[RESOURCE_ENERGY]) || 0; })
  };
}
function writeVisibleSourceIntel(room, source, access) {
  Memory.rooms = Memory.rooms || {};
  var rm = Memory.rooms[room.name] = (Memory.rooms[room.name] || {});
  rm.sources = rm.sources || {};
  var data = buildVisibleSourceIntel(room, source, access);
  var rec = rm.sources[source.id] = (rm.sources[source.id] || {});
  for (var key in data) if (Object.prototype.hasOwnProperty.call(data, key)) rec[key] = data[key];
  return data;
}
function seedSourcesFromVision(room) { if (!room) return; var arr = room.find(FIND_SOURCES); for (var i = 0; i < arr.length; i++) writeVisibleSourceIntel(room, arr[i], null); }

function logRoomIntel(room) {
  // Full room intel snapshot. SourceEnergy.Manager uses sources/owner/
  // reservation/keeper data; combat uses hostiles; visuals/debugging read the
  // richer optional fields like portals, minerals, deposits, and power banks.
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
  updateScoutHomeIntelForRoom(room);
  evaluateRoomThreat(room, 'Scout');
  if (CFG.DEBUG_DRAW) { var tag = (intel.owner ? ('👑 ' + intel.owner) : (intel.reservation ? ('📌 ' + intel.reservation) : 'free')); var extras = []; if (intel.invaderCore && intel.invaderCore.present) extras.push('IC'); if (intel.powerBank) extras.push('PB'); if (intel.keeperLairs) extras.push('SK:' + intel.keeperLairs); var text = tag + ' • src:' + intel.sources + (extras.length ? ' • ' + extras.join(',') : ''); var center = new RoomPosition(25,25,room.name); debugLabel(room, center, text, CFG.DRAW.INTEL); }
}

function ensureScoutIdentity(creep) { if (!creep || !creep.memory) return; creep.memory.role = 'Scout'; if (!creep.memory.task) creep.memory.task = 'scout'; }
function ensureScoutMem(creep) {
  // Scout creep memory is intentionally nested under creep.memory.scout so
  // role-level fields like targetRoom/state remain compatible with older code.
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



function ensureScoutIntelRoot() {
  // Home-scoped remote intel map. SourceEnergy.Manager reads this path when it
  // wants source-level accessibility and route diagnostics gathered by Scouts.
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.scoutIntel) Memory.__BHM.scoutIntel = { homes: {} };
  if (!Memory.__BHM.scoutIntel.homes) Memory.__BHM.scoutIntel.homes = {};
  return Memory.__BHM.scoutIntel;
}
function getOwnedHomeRooms() {
  var seen = {}; var homes = [];
  for (var name in Game.spawns) {
    if (!Object.prototype.hasOwnProperty.call(Game.spawns, name)) continue;
    var spawn = Game.spawns[name];
    if (!spawn || !spawn.my || !spawn.room || !spawn.room.name) continue;
    if (seen[spawn.room.name]) continue;
    seen[spawn.room.name] = true; homes.push(spawn.room.name);
  }
  return homes;
}

function scoutRoomCostMatrix(roomName) {
  var room = Game.rooms[roomName]; if (!room) return;
  var m = new PathFinder.CostMatrix();
  var structs = room.find(FIND_STRUCTURES) || [];
  for (var i = 0; i < structs.length; i++) {
    var st = structs[i]; if (!st) continue;
    if (st.structureType === STRUCTURE_ROAD) m.set(st.pos.x, st.pos.y, 1);
    else if (st.structureType !== STRUCTURE_CONTAINER && (st.structureType !== STRUCTURE_RAMPART || !st.my)) m.set(st.pos.x, st.pos.y, 0xff);
  }
  var sites = room.find(FIND_CONSTRUCTION_SITES) || [];
  for (var j = 0; j < sites.length; j++) {
    var cs = sites[j]; if (!cs) continue;
    if (cs.structureType !== STRUCTURE_ROAD && cs.structureType !== STRUCTURE_CONTAINER) m.set(cs.pos.x, cs.pos.y, 0xff);
  }
  return m;
}
function evaluateScoutSourceAccessibility(homeRoom, room, sourceObj) {
  // Source-level approval check: a source needs at least one usable harvest
  // tile and a plausible path from the home-room center before it is marked
  // remoteEligible for Veinseeker planning.
  if (!room || !sourceObj || !sourceObj.pos) return { accessible: false, blockedReason: 'source-missing', checkedAt: Game.time, openTiles: 0 };
  var terrain = room.getTerrain();
  var openTiles = 0;
  var hasHarvestTile = false;
  for (var dx=-1; dx<=1; dx++) for (var dy=-1; dy<=1; dy++) {
    if (!dx && !dy) continue;
    var x = sourceObj.pos.x + dx, y = sourceObj.pos.y + dy;
    if (x < 1 || x > 48 || y < 1 || y > 48) continue;
    if (terrain.get(x,y) === TERRAIN_MASK_WALL) continue;
    openTiles++;
    var blocked = false;
    var look = room.lookForAt(LOOK_STRUCTURES, x, y) || [];
    for (var i = 0; i < look.length; i++) {
      var st = look[i]; if (!st) continue;
      if (st.structureType === STRUCTURE_ROAD || st.structureType === STRUCTURE_CONTAINER) continue;
      if (st.structureType === STRUCTURE_RAMPART && st.my) continue;
      blocked = true; break;
    }
    if (!blocked) {
      var sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y) || [];
      for (var j = 0; j < sites.length; j++) {
        var cs = sites[j]; if (!cs) continue;
        if (cs.structureType === STRUCTURE_ROAD || cs.structureType === STRUCTURE_CONTAINER) continue;
        blocked = true; break;
      }
    }
    if (!blocked) hasHarvestTile = true;
  }
  if (!openTiles) return { accessible: false, blockedReason: 'no-open-harvest-tiles', checkedAt: Game.time, openTiles: openTiles };
  if (!hasHarvestTile) return { accessible: false, blockedReason: 'harvest-tiles-blocked-by-structures', checkedAt: Game.time, openTiles: openTiles };
  var start = new RoomPosition(25, 25, homeRoom);
  var ret = PathFinder.search(start, { pos: sourceObj.pos, range: 1 }, { maxOps: 2000, plainCost: 2, swampCost: 10, roomCallback: scoutRoomCostMatrix });
  if (ret.incomplete || !ret.path || !ret.path.length) return { accessible: false, blockedReason: 'path-to-source-incomplete', checkedAt: Game.time, openTiles: openTiles, pathCost: ret.cost || null };
  return { accessible: true, blockedReason: null, checkedAt: Game.time, openTiles: openTiles, pathCost: ret.cost || null };
}

function updateScoutHomeIntelForRoom(room) {
  // Write one visible room into every nearby home-room scout map. This is the
  // bridge from roaming Scouts to SourceEnergy.Manager's approved source list.
  if (!room || !room.name) return;
  var root = ensureScoutIntelRoot();
  var homes = getOwnedHomeRooms();
  for (var i = 0; i < homes.length; i++) {
    var homeRoom = homes[i];
    var linear = Game.map.getRoomLinearDistance(homeRoom, room.name);
    if (linear > 3) continue;
    var route = null; try { route = Game.map.findRoute(homeRoom, room.name); } catch (e) { route = ERR_NO_PATH; }
    var routeDistance = (room.name === homeRoom) ? 0 : ((route === ERR_NO_PATH || !Array.isArray(route)) ? Infinity : route.length);
    if (!root.homes[homeRoom]) root.homes[homeRoom] = { rooms: {}, updatedAt: Game.time };
    if (!root.homes[homeRoom].rooms) root.homes[homeRoom].rooms = {};
    var hostileStructures = room.find(FIND_HOSTILE_STRUCTURES) || [];
    var hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
    var invaderCore = room.find(FIND_STRUCTURES, { filter: function (st) { return st.structureType === STRUCTURE_INVADER_CORE; } }) || [];
    var sources = room.find(FIND_SOURCES) || [];
    var srcList = []; var inaccessible = 0;
    for (var s = 0; s < sources.length; s++) {
      var src = sources[s];
      var access = evaluateScoutSourceAccessibility(homeRoom, room, src);
      if (!access.accessible) inaccessible++;
      var sourceIntel = writeVisibleSourceIntel(room, src, access);
      sourceIntel.routeDistance = routeDistance === Infinity ? null : routeDistance;
      sourceIntel.pathCost = access.pathCost || null;
      srcList.push(sourceIntel);
    }
    var remoteEligible = true; var remoteBlockedReason = null;
    if (hostiles.length > 0) { remoteEligible = false; remoteBlockedReason = 'unsafe-room'; }
    else if (invaderCore.length > 0) { remoteEligible = false; remoteBlockedReason = 'invader-core'; }
    else if (sources.length > 0 && inaccessible >= sources.length) { remoteEligible = false; remoteBlockedReason = 'all-sources-inaccessible'; }
    root.homes[homeRoom].rooms[room.name] = { roomName: room.name, homeRoom: homeRoom, linearDistance: linear, routeDistance: routeDistance, lastSeen: Game.time, sources: srcList, controller: room.controller ? { owner: room.controller.owner && room.controller.owner.username || null, reservation: room.controller.reservation && room.controller.reservation.username || null } : null, hostileCreeps: hostiles.length, hostileStructures: hostileStructures.length, hostileRamparts: hostileStructures.filter(function(h){return h.structureType===STRUCTURE_RAMPART;}).length, invaderCore: invaderCore.length > 0, sourceAccessibility: { total: sources.length, inaccessible: inaccessible }, remoteEligible: remoteEligible, remoteBlockedReason: remoteBlockedReason };
    root.homes[homeRoom].updatedAt = Game.time;
    Memory.rooms = Memory.rooms || {}; Memory.rooms[homeRoom] = Memory.rooms[homeRoom] || {};
    Memory.rooms[homeRoom].lastScoutMap = { tick: Game.time, homeRoom: homeRoom, knownRooms: Object.keys(root.homes[homeRoom].rooms || {}).length };
  }
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
function canClaimRemoteVisionRequest(creep, req) {
  // Remote vision requests are short-lived work orders created by BeeSpawnManager
  // when stale remote container data needs a Scout to confirm status.
  if (!creep || !req) return false;
  if (!req.assignedTo) return true;
  if (req.assignedTo === creep.name) return true;
  return !req.assignedUntil || req.assignedUntil <= Game.time;
}
function pickRemoteVisionRequest(creep, mem) {
  var reqs = ensureRemoteVisionRoot();
  var bestKey = null; var best = null;
  for (var k in reqs) {
    if (!Object.prototype.hasOwnProperty.call(reqs, k)) continue;
    var r = reqs[k]; if (!r || r.resolvedAt) continue;
    if (r.homeRoom && mem.home && r.homeRoom !== mem.home) continue;
    if (!canClaimRemoteVisionRequest(creep, r)) continue;
    var pri = Number(r.priority) || 0;
    if (!best || pri > (Number(best.priority)||0) || ((pri === (Number(best.priority)||0)) && (r.requestedAt||0) < (best.requestedAt||0))) { best = r; bestKey = k; }
  }
  return best ? { key: bestKey, req: best } : null;
}
function claimRemoteVisionRequest(creep, pick) {
  if (!creep || !pick) return false;
  var reqs = ensureRemoteVisionRoot();
  var req = reqs[pick.key];
  if (!req || !canClaimRemoteVisionRequest(creep, req)) return false;
  req.assignedTo = creep.name;
  req.assignedUntil = Game.time + 35;
  req.lastAttemptAt = Game.time;
  req.attempts = (req.attempts || 0) + 1;
  reqs[pick.key] = req;
  creep.memory.remoteVisionRequestId = pick.key;
  creep.memory.task = creep.memory.task === 'remoteVisionEmergency' ? 'remoteVisionEmergency' : creep.memory.task;
  return true;
}
function serviceRemoteVisionRequest(creep, mem) {
  // If this Scout has or can claim an emergency vision request, it prioritizes
  // that over normal exploration, refreshes remoteContainerStatus, then clears
  // the request so the spawn manager stops asking for emergency Scouts.
  var existingId = creep.memory.remoteVisionRequestId;
  var reqs = ensureRemoteVisionRoot();
  var pick = null;
  if (existingId && reqs[existingId] && canClaimRemoteVisionRequest(creep, reqs[existingId])) pick = { key: existingId, req: reqs[existingId] };
  if (!pick) pick = pickRemoteVisionRequest(creep, mem);
  if (!pick || !claimRemoteVisionRequest(creep, pick)) return false;
  var req = ensureRemoteVisionRoot()[pick.key];
  var targetRoom = req.targetRoom || req.roomName;
  if (!targetRoom) return false;
  if (creep.pos.roomName !== targetRoom) { creep.travelTo(new RoomPosition(req.x || 25, req.y || 25, targetRoom), { range: 1, reusePath: CFG.PATH_REUSE }); return true; }
  var root = Memory.__BHM = Memory.__BHM || {}; root.remoteContainerStatus = root.remoteContainerStatus || {};
  var id = req.containerId || pick.key;
  var obj = req.containerId ? Game.getObjectById(req.containerId) : null;
  if (!obj && typeof req.x === 'number' && typeof req.y === 'number' && creep.room) {
    var at = creep.room.lookForAt(LOOK_STRUCTURES, req.x, req.y) || [];
    for (var i=0;i<at.length;i++) if (at[i].structureType === STRUCTURE_CONTAINER) { obj = at[i]; break; }
  }
  var rec = root.remoteContainerStatus[id] || { containerId: req.containerId, sourceId: req.sourceId, homeRoom: req.homeRoom, remoteRoom: targetRoom, x: req.x, y: req.y };
  rec.updated = Game.time; rec.lastSeen = Game.time; rec.stale = false; rec.lastSeenAgo = 0;
  if (obj && obj.structureType === STRUCTURE_CONTAINER) {
    rec.amount = obj.store[RESOURCE_ENERGY] || 0; rec.capacity = obj.store.getCapacity(RESOURCE_ENERGY) || obj.store.getCapacity() || 2000;
    rec.containerHits = obj.hits; rec.containerHitsMax = obj.hitsMax; rec.containerHitsPct = obj.hitsMax > 0 ? (obj.hits / obj.hitsMax) : null; rec.status = 'built';
  } else { rec.status = 'missing'; rec.missingSeenAt = Game.time; }
  root.remoteContainerStatus[id] = rec;
  req.resolvedAt = Game.time;
  delete ensureRemoteVisionRoot()[pick.key];
  delete creep.memory.remoteVisionRequestId;
  if (creep.memory.task === 'remoteVisionEmergency') {
    delete creep.memory.targetRoom;
    if (creep.memory.scout) creep.memory.scout.targetRoom = null;
    creep.memory.task = 'scout';
  }
  return true;
}


function run(creep) {
  // Main Scout state machine: service emergency remote vision first, otherwise
  // choose a neighboring room, travel there, write intel, retreat if threatened,
  // then idle or pick another stale/unknown exit.
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
