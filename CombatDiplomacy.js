'use strict';

// -----------------------------------------------------------------------------
// CombatDiplomacy.js
// Centralized combat policy + lightweight diplomacy ledger.
// Goals:
// - Keep "who can we target" decisions consistent across squads/towers.
// - Track manual targets, watched neighbors, retaliation targets separately.
// - Record contextual incidents conservatively (avoid scout false positives).
// -----------------------------------------------------------------------------

var CoreConfig = require('core.config');

var DEFAULTS = {
  WATCH_TTL: 1500,
  RETALIATION_TTL: 2000,
  INCIDENT_TTL: 3000,
  MAX_INCIDENTS: 120,
  BORDER_ROUTE_DISTANCE: 1,
  WATCH_ROUTE_DISTANCE: 2
};

function cfgCombat() {
  var s = CoreConfig && CoreConfig.settings && CoreConfig.settings.combat;
  return s || {};
}

function now() {
  return Game.time;
}

function lowerUsername(name) {
  if (!name) return '';
  return String(name).toLowerCase();
}

function isNpcUsername(usernameLower) {
  return usernameLower === 'invader' || usernameLower === 'source keeper';
}

function ensureCombatMemory() {
  if (!Memory.combat) Memory.combat = {};
  var mem = Memory.combat;

  if (!Array.isArray(mem.manualTargets)) mem.manualTargets = [];
  if (!mem.watchList) mem.watchList = {};
  if (!mem.retaliation) mem.retaliation = {};
  if (!Array.isArray(mem.incidents)) mem.incidents = [];
  if (!mem.creepVitals) mem.creepVitals = {};
  if (!mem.structureVitals) mem.structureVitals = {};

  return mem;
}

function normalizeNameList(list) {
  var out = [];
  var seen = {};
  if (!Array.isArray(list)) return out;
  for (var i = 0; i < list.length; i++) {
    var n = lowerUsername(list[i]);
    if (!n || seen[n]) continue;
    seen[n] = true;
    out.push(n);
  }
  return out;
}

function resolveMyUsernameLower() {
  if (global.__beeUsername) return lowerUsername(global.__beeUsername);

  for (var sName in Game.spawns) {
    if (!Object.prototype.hasOwnProperty.call(Game.spawns, sName)) continue;
    var sp = Game.spawns[sName];
    if (!sp || !sp.my || !sp.owner || !sp.owner.username) continue;
    global.__beeUsername = sp.owner.username;
    return lowerUsername(sp.owner.username);
  }

  for (var cName in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, cName)) continue;
    var c = Game.creeps[cName];
    if (!c || !c.my || !c.owner || !c.owner.username) continue;
    global.__beeUsername = c.owner.username;
    return lowerUsername(c.owner.username);
  }

  return '';
}

function allyMapLower() {
  var map = {};
  var allies = (CoreConfig && CoreConfig.ALLY_USERNAMES) || [];
  for (var i = 0; i < allies.length; i++) {
    map[lowerUsername(allies[i])] = true;
  }
  var me = resolveMyUsernameLower();
  if (me) map[me] = true;
  return map;
}

function routeDistance(roomNameA, roomNameB) {
  if (!roomNameA || !roomNameB || !Game.map || typeof Game.map.findRoute !== 'function') return Infinity;
  var route = null;
  try {
    route = Game.map.findRoute(roomNameA, roomNameB);
  } catch (e) {
    route = ERR_NO_PATH;
  }
  if (route === ERR_NO_PATH || !route) return Infinity;
  return Array.isArray(route) ? route.length : Infinity;
}

function listOwnedRoomNames() {
  var out = [];
  var seen = {};
  for (var rn in Game.rooms) {
    if (!Object.prototype.hasOwnProperty.call(Game.rooms, rn)) continue;
    var room = Game.rooms[rn];
    if (!room || !room.controller || !room.controller.my) continue;
    seen[room.name] = true;
    out.push(room.name);
  }
  // fallback: spawn rooms even if no room vision for some reason
  for (var sn in Game.spawns) {
    if (!Object.prototype.hasOwnProperty.call(Game.spawns, sn)) continue;
    var sp = Game.spawns[sn];
    if (!sp || !sp.my || !sp.room) continue;
    if (seen[sp.room.name]) continue;
    seen[sp.room.name] = true;
    out.push(sp.room.name);
  }
  return out;
}

function listActiveRemoteRooms() {
  var set = {};
  var out = [];

  // primary source: live luna/scout targets
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.my || !creep.memory) continue;
    var role = String(creep.memory.role || '').toLowerCase();
    if (role !== 'luna' && role !== 'scout') continue;
    var targetRoom = creep.memory.targetRoom || (creep.memory.scout && creep.memory.scout.targetRoom) || null;
    if (!targetRoom || set[targetRoom]) continue;
    set[targetRoom] = true;
    out.push(targetRoom);
  }

  // secondary source: persisted source intel buckets
  if (Memory.rooms) {
    for (var roomName in Memory.rooms) {
      if (!Object.prototype.hasOwnProperty.call(Memory.rooms, roomName)) continue;
      var rm = Memory.rooms[roomName];
      if (!rm || !rm.sources) continue;
      if (set[roomName]) continue;
      set[roomName] = true;
      out.push(roomName);
    }
  }

  return out;
}

function computeRoomContext(roomName) {
  var ownedNames = listOwnedRoomNames();
  var remoteNames = listActiveRemoteRooms();

  var inOwned = false;
  var inRemote = false;
  var inBorder = false;

  var i;
  for (i = 0; i < ownedNames.length; i++) {
    if (ownedNames[i] === roomName) {
      inOwned = true;
      break;
    }
  }

  if (!inOwned) {
    for (i = 0; i < remoteNames.length; i++) {
      if (remoteNames[i] === roomName) {
        inRemote = true;
        break;
      }
    }
  }

  var combatCfg = cfgCombat();
  var borderLimit = (typeof combatCfg.BORDER_ROUTE_DISTANCE === 'number')
    ? combatCfg.BORDER_ROUTE_DISTANCE
    : DEFAULTS.BORDER_ROUTE_DISTANCE;

  if (!inOwned && !inRemote) {
    for (i = 0; i < ownedNames.length; i++) {
      if (routeDistance(roomName, ownedNames[i]) <= borderLimit) {
        inBorder = true;
        break;
      }
    }
  }

  return {
    roomName: roomName,
    inOwnedRoom: inOwned,
    inRemoteRoom: inRemote,
    inBorderRoom: inBorder,
    inMyTerritory: Boolean(inOwned || inRemote || inBorder)
  };
}

function ensurePolicyLists() {
  var mem = ensureCombatMemory();
  var combatCfg = cfgCombat();

  var cfgManual = normalizeNameList(combatCfg.MANUAL_TARGETS || []);
  var memManual = normalizeNameList(mem.manualTargets || []);

  // Union config + memory lists; keep memory as editable/visible runtime source.
  var union = [];
  var seen = {};
  var i;
  for (i = 0; i < cfgManual.length; i++) {
    if (seen[cfgManual[i]]) continue;
    seen[cfgManual[i]] = true;
    union.push(cfgManual[i]);
  }
  for (i = 0; i < memManual.length; i++) {
    if (seen[memManual[i]]) continue;
    seen[memManual[i]] = true;
    union.push(memManual[i]);
  }
  mem.manualTargets = union;
}

function hasLiveEntry(entry) {
  return !!(entry && typeof entry.expires === 'number' && entry.expires > now());
}

function isManualTarget(usernameLower) {
  var mem = ensureCombatMemory();
  for (var i = 0; i < mem.manualTargets.length; i++) {
    if (mem.manualTargets[i] === usernameLower) return true;
  }
  return false;
}

function isWatched(usernameLower) {
  var mem = ensureCombatMemory();
  return hasLiveEntry(mem.watchList[usernameLower]);
}

function isRetaliatory(usernameLower) {
  var mem = ensureCombatMemory();
  return hasLiveEntry(mem.retaliation[usernameLower]);
}

function shouldTargetOwnerUsername(ownerUsername, opts) {
  if (!ownerUsername) return false;
  var username = lowerUsername(ownerUsername);
  var avoidMap = opts && opts.avoidMap ? opts.avoidMap : null;

  var allyMap = allyMapLower();
  if (allyMap[username]) return false;
  if (avoidMap && avoidMap[username]) return false;

  var combatCfg = cfgCombat();
  if (username === 'invader') {
    return combatCfg.ALLOW_INVADERS_IN_FOREIGN_ROOMS !== false;
  }
  if (username === 'source keeper') {
    return combatCfg.TREAT_SOURCE_KEEPERS_AS_PVE !== false;
  }

  if (combatCfg.ALLOW_PVP === false) return false;

  if (isManualTarget(username)) return true;
  if (isRetaliatory(username)) return true;

  // Conservative default: only automatically engage players in local defense zones.
  var roomName = opts && opts.roomName ? opts.roomName : null;
  if (roomName) {
    var ctx = computeRoomContext(roomName);
    if (ctx.inMyTerritory) return true;
  }

  return false;
}

function observeOwner(ownerUsername, roomName, reason) {
  if (!ownerUsername) return;
  var username = lowerUsername(ownerUsername);
  if (!username || isNpcUsername(username)) return;

  var allies = allyMapLower();
  if (allies[username]) return;

  var combatCfg = cfgCombat();
  var watchDist = (typeof combatCfg.WATCH_ROUTE_DISTANCE === 'number')
    ? combatCfg.WATCH_ROUTE_DISTANCE
    : DEFAULTS.WATCH_ROUTE_DISTANCE;

  var shouldWatch = false;
  if (roomName) {
    var owned = listOwnedRoomNames();
    for (var i = 0; i < owned.length; i++) {
      if (routeDistance(roomName, owned[i]) <= watchDist) {
        shouldWatch = true;
        break;
      }
    }
  }

  if (!shouldWatch) return;

  var mem = ensureCombatMemory();
  var watchTtl = (typeof combatCfg.WATCH_TTL === 'number') ? combatCfg.WATCH_TTL : DEFAULTS.WATCH_TTL;
  mem.watchList[username] = {
    firstSeen: (mem.watchList[username] && mem.watchList[username].firstSeen) || now(),
    lastSeen: now(),
    roomName: roomName || null,
    reason: reason || 'nearby_presence',
    expires: now() + watchTtl
  };
}

function classifyIncident(incident) {
  // Conservative false-positive protection for recon/probing deaths.
  if (!incident) return { validAggression: false, ignored: true, reason: 'invalid_incident' };

  // Never escalate retaliation from weak attribution evidence.
  if (incident.confidence === 'low') {
    return { validAggression: false, ignored: true, reason: 'low_confidence_attribution' };
  }

  if (!incident.attackerUsername || incident.attackerType !== 'player') {
    return { validAggression: false, ignored: true, reason: 'no_player_attacker' };
  }

  if (incident.victimWasScout && incident.inForeignOwnedRoom && (incident.hostileTowersPresent || incident.hostileSpawnsPresent)) {
    return { validAggression: false, ignored: true, reason: 'scout_probe_foreign_tower_zone' };
  }

  if (incident.victimWasScout && !incident.inMyTerritory) {
    return { validAggression: false, ignored: true, reason: 'scout_deep_foreign_room' };
  }

  if (incident.victimWasLuna && incident.inForeignOwnedRoom && !incident.inMyTerritory) {
    return { validAggression: false, ignored: true, reason: 'luna_deep_foreign_room' };
  }

  if (incident.inOwnedRoom || incident.inRemoteRoom || incident.inBorderRoom || incident.structureAttack === true) {
    return { validAggression: true, ignored: false, reason: 'territory_aggression' };
  }

  return { validAggression: false, ignored: true, reason: 'non_territory_contact' };
}

function pushIncident(incident) {
  var mem = ensureCombatMemory();
  mem.incidents.push(incident);
  if (mem.incidents.length > DEFAULTS.MAX_INCIDENTS) {
    mem.incidents.splice(0, mem.incidents.length - DEFAULTS.MAX_INCIDENTS);
  }
}

function addRetaliation(attackerUsername, reason, roomName) {
  if (!attackerUsername) return;
  var uname = lowerUsername(attackerUsername);
  if (!uname || isNpcUsername(uname)) return;
  var allies = allyMapLower();
  if (allies[uname]) return;

  var mem = ensureCombatMemory();
  var combatCfg = cfgCombat();
  var ttl = (typeof combatCfg.RETALIATION_TTL === 'number') ? combatCfg.RETALIATION_TTL : DEFAULTS.RETALIATION_TTL;
  var prev = mem.retaliation[uname];

  mem.retaliation[uname] = {
    firstAt: prev && prev.firstAt ? prev.firstAt : now(),
    lastAt: now(),
    reason: reason || 'valid_aggression',
    roomName: roomName || null,
    expires: now() + ttl,
    count: (prev && prev.count ? prev.count : 0) + 1
  };
}

function findLikelyAttackerForCreep(creep) {
  var pos = getSafeRoomPositionFromIncidentTarget(creep);
  if (!pos) return null;

  var room = (creep && creep.room) || (pos.roomName && Game.rooms[pos.roomName]) || null;
  if (!room || typeof room.find !== 'function') return null;

  var hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
  if (!hostiles.length) return null;

  var nearest = (typeof pos.findClosestByRange === 'function') ? pos.findClosestByRange(hostiles) : null;
  if (!nearest || !nearest.owner || !nearest.owner.username) return null;

  var u = nearest.owner.username;
  var lower = lowerUsername(u);
  var type = (lower === 'invader' || lower === 'source keeper') ? 'npc' : 'player';
  return {
    username: u,
    type: type,
    id: nearest.id,
    confidence: 'low',
    source: 'heuristic_nearest_hostile',
    attackType: null,
    damage: null,
    targetId: creep && creep.id ? creep.id : null
  };
}

function getSafeRoomPositionFromIncidentTarget(targetLike) {
  if (!targetLike) return null;

  if (targetLike.pos && typeof targetLike.pos.findClosestByRange === 'function' && typeof targetLike.pos.roomName === 'string') {
    return targetLike.pos;
  }

  var rawPos = targetLike.pos || null;
  if (rawPos && typeof rawPos === 'object') {
    var roomName = (typeof rawPos.roomName === 'string') ? rawPos.roomName : null;
    var x = (typeof rawPos.x === 'number') ? rawPos.x : null;
    var y = (typeof rawPos.y === 'number') ? rawPos.y : null;
    if (roomName && x != null && y != null) {
      return new RoomPosition(x, y, roomName);
    }
  }

  return null;
}

function getRoomEventLogSafe(room) {
  if (!room || typeof room.getEventLog !== 'function') return [];
  if (!global.__combatEventCache || global.__combatEventCache.tick !== now()) {
    global.__combatEventCache = { tick: now(), byRoom: {} };
  }
  var cache = global.__combatEventCache.byRoom;
  if (cache.hasOwnProperty(room.name)) return cache[room.name];
  var events = [];
  try {
    events = room.getEventLog() || [];
  } catch (e) {
    events = [];
  }
  cache[room.name] = events;
  return events;
}

function attributionFromAttackerId(attackerId, sourceTag, attackType, damage, targetId) {
  if (!attackerId) return null;
  var obj = Game.getObjectById(attackerId);
  var username = (obj && obj.owner && obj.owner.username) ? obj.owner.username : null;
  var lower = lowerUsername(username);
  var attackerType = username ? (isNpcUsername(lower) ? 'npc' : 'player') : 'unknown';
  return {
    username: username,
    type: attackerType,
    id: attackerId,
    confidence: username ? 'high' : 'medium',
    source: sourceTag || 'event_log',
    attackType: attackType || null,
    damage: (typeof damage === 'number') ? damage : null,
    targetId: targetId || null
  };
}

function findEventLogAttribution(room, targetId, includeDestroyed) {
  if (!room || !targetId) return null;
  if (typeof EVENT_ATTACK === 'undefined') return null;
  var events = getRoomEventLogSafe(room);
  if (!events || !events.length) return null;

  var i;
  var destroySeen = false;
  for (i = events.length - 1; i >= 0; i--) {
    var ev = events[i];
    if (!ev || ev.event !== EVENT_ATTACK || !ev.data) continue;
    if (ev.data.targetId !== targetId) continue;
    return attributionFromAttackerId(
      ev.objectId,
      'event_log_attack',
      ev.data.attackType,
      ev.data.damage,
      ev.data.targetId
    );
  }

  if (!includeDestroyed) return null;

  if (typeof EVENT_OBJECT_DESTROYED !== 'undefined') {
    for (i = events.length - 1; i >= 0; i--) {
      var evd = events[i];
      if (!evd || evd.event !== EVENT_OBJECT_DESTROYED) continue;
      if (evd.objectId !== targetId) continue;
      destroySeen = true;
      break;
    }
  }
  if (!destroySeen) return null;

  // Destroy events do not always include attacker identity. We recover
  // attacker evidence by pairing with the latest attack event for targetId.
  for (i = events.length - 1; i >= 0; i--) {
    var eva = events[i];
    if (!eva || eva.event !== EVENT_ATTACK || !eva.data) continue;
    if (eva.data.targetId !== targetId) continue;
    return attributionFromAttackerId(
      eva.objectId,
      'event_log_destroy_chain',
      eva.data.attackType,
      eva.data.damage,
      eva.data.targetId
    );
  }
  return null;
}

function gatherRoomHostileStructureSignals(room) {
  if (!room) return { hostileTowersPresent: false, hostileSpawnsPresent: false, foreignOwner: null };

  var towers = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function (s) { return s.structureType === STRUCTURE_TOWER; }
  }) || [];
  var spawns = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function (s) { return s.structureType === STRUCTURE_SPAWN; }
  }) || [];

  var owner = null;
  if (room.controller && room.controller.owner && room.controller.owner.username) {
    owner = room.controller.owner.username;
  }

  return {
    hostileTowersPresent: towers.length > 0,
    hostileSpawnsPresent: spawns.length > 0,
    foreignOwner: owner
  };
}

function recordCreepIncident(creep, kind) {
  if (!creep || !creep.memory) return;

  var role = creep.memory.role || creep.memory.task || null;
  var roomName = creep.memory.lastRoomName || (creep.pos && creep.pos.roomName) || null;
  var room = roomName && Game.rooms[roomName] ? Game.rooms[roomName] : null;
  var roomCtx = computeRoomContext(roomName);

  var targetId = creep.id || (creep.memory && creep.memory.lastKnownId) || null;
  var attackerInfo = findEventLogAttribution(room, targetId, kind === 'death');
  if (!attackerInfo) {
    attackerInfo = findLikelyAttackerForCreep(creep);
  }
  var signals = gatherRoomHostileStructureSignals(room);

  var foreignOwned = false;
  if (signals.foreignOwner) {
    var mine = resolveMyUsernameLower();
    foreignOwned = lowerUsername(signals.foreignOwner) !== mine;
  }

  var incident = {
    t: now(),
    kind: kind || 'damage',
    attackerUsername: attackerInfo ? attackerInfo.username : null,
    attackerType: attackerInfo ? attackerInfo.type : 'unknown',
    attackerId: attackerInfo ? attackerInfo.id : null,
    attackerEvidence: attackerInfo ? attackerInfo.source : 'unknown',
    eventAttackType: attackerInfo ? attackerInfo.attackType : null,
    eventDamage: attackerInfo ? attackerInfo.damage : null,
    eventTargetId: attackerInfo ? attackerInfo.targetId : targetId,
    victimName: creep.name,
    victimRole: role,
    roomName: roomName,
    roomType: roomCtx.inOwnedRoom ? 'owned' : (roomCtx.inRemoteRoom ? 'remote' : (roomCtx.inBorderRoom ? 'border' : 'foreign')),
    inMyTerritory: roomCtx.inMyTerritory,
    inOwnedRoom: roomCtx.inOwnedRoom,
    inRemoteRoom: roomCtx.inRemoteRoom,
    inBorderRoom: roomCtx.inBorderRoom,
    inForeignOwnedRoom: foreignOwned,
    hostileTowersPresent: signals.hostileTowersPresent,
    hostileSpawnsPresent: signals.hostileSpawnsPresent,
    victimWasScout: role === 'Scout',
    victimWasLuna: role === 'Luna',
    victimInCombatSquad: Boolean(creep.memory.squadId || creep.memory.squadFlag),
    provokedReconLikely: (role === 'Scout') || ((role === 'Luna') && !roomCtx.inMyTerritory),
    confidence: attackerInfo ? (attackerInfo.confidence || 'medium') : 'low',
    reasonCode: 'pending_classification',
    structureAttack: false
  };

  var classification = classifyIncident(incident);
  incident.reasonCode = classification.reason;
  incident.validAggression = classification.validAggression;
  incident.ignored = classification.ignored;

  pushIncident(incident);

  if (incident.attackerUsername) {
    observeOwner(incident.attackerUsername, roomName, 'incident:' + incident.reasonCode);
  }

  if (classification.validAggression && incident.attackerUsername) {
    addRetaliation(incident.attackerUsername, incident.reasonCode, roomName);
  }
}

function processCreepDamageAndDeaths() {
  var mem = ensureCombatMemory();
  var vitals = mem.creepVitals;

  // Update live creep vitals, record damage events.
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.my) continue;

    var prev = vitals[name];
    if (prev && typeof prev.hits === 'number' && creep.hits < prev.hits) {
      recordCreepIncident(creep, 'damage');
    }

    vitals[name] = {
      hits: creep.hits,
      hitsMax: creep.hitsMax,
      role: creep.memory ? (creep.memory.role || creep.memory.task || null) : null,
      id: creep.id || null,
      roomName: creep.pos ? creep.pos.roomName : null,
      t: now()
    };

    if (creep.memory) {
      creep.memory.lastRoomName = creep.pos ? creep.pos.roomName : creep.memory.lastRoomName;
      creep.memory.lastRole = creep.memory.role || creep.memory.lastRole;
    }
  }

  // Detect deaths from previous vitals snapshot.
  var stale = [];
  for (var cName in vitals) {
    if (!Object.prototype.hasOwnProperty.call(vitals, cName)) continue;
    if (Game.creeps[cName]) continue;

    var deadInfo = vitals[cName];
    var fake = {
      name: cName,
      memory: {
        role: deadInfo.role,
        task: deadInfo.role,
        lastRoomName: deadInfo.roomName,
        lastKnownId: deadInfo.id || null
      },
      pos: deadInfo.roomName ? { roomName: deadInfo.roomName } : null,
      room: deadInfo.roomName ? Game.rooms[deadInfo.roomName] : null,
      id: deadInfo.id || null
    };
    recordCreepIncident(fake, 'death');
    stale.push(cName);
  }

  for (var i = 0; i < stale.length; i++) {
    delete vitals[stale[i]];
  }
}

function processStructureDamage() {
  var mem = ensureCombatMemory();
  var vitals = mem.structureVitals;

  for (var roomName in Game.rooms) {
    if (!Object.prototype.hasOwnProperty.call(Game.rooms, roomName)) continue;
    var room = Game.rooms[roomName];
    if (!room || !room.controller || !room.controller.my) continue;

    var myStructs = room.find(FIND_MY_STRUCTURES) || [];
    var signals = gatherRoomHostileStructureSignals(room);

    for (var i = 0; i < myStructs.length; i++) {
      var s = myStructs[i];
      if (!s || !s.id || s.hits == null) continue;

      var prev = vitals[s.id];
      if (prev && typeof prev.hits === 'number' && s.hits < prev.hits) {
        var attribution = findEventLogAttribution(room, s.id, false);
        if (!attribution) {
          var nearestHostile = room.find(FIND_HOSTILE_CREEPS);
          nearestHostile = (nearestHostile && nearestHostile.length) ? s.pos.findClosestByRange(nearestHostile) : null;
          var nearestName = (nearestHostile && nearestHostile.owner && nearestHostile.owner.username) ? nearestHostile.owner.username : null;
          var nearestLower = lowerUsername(nearestName);
          attribution = {
            username: nearestName,
            type: (!nearestName) ? 'unknown' : (isNpcUsername(nearestLower) ? 'npc' : 'player'),
            id: nearestHostile ? nearestHostile.id : null,
            confidence: nearestName ? 'low' : 'low',
            source: 'heuristic_nearest_hostile',
            attackType: null,
            damage: null,
            targetId: s.id
          };
        }
        var ctx = computeRoomContext(roomName);

        var inc = {
          t: now(),
          kind: 'structure_damage',
          attackerUsername: attribution.username,
          attackerType: attribution.type,
          attackerId: attribution.id,
          attackerEvidence: attribution.source,
          eventAttackType: attribution.attackType,
          eventDamage: attribution.damage,
          eventTargetId: attribution.targetId || s.id,
          victimName: s.id,
          victimRole: 'STRUCTURE:' + s.structureType,
          roomName: roomName,
          roomType: ctx.inOwnedRoom ? 'owned' : (ctx.inRemoteRoom ? 'remote' : (ctx.inBorderRoom ? 'border' : 'foreign')),
          inMyTerritory: ctx.inMyTerritory,
          inOwnedRoom: ctx.inOwnedRoom,
          inRemoteRoom: ctx.inRemoteRoom,
          inBorderRoom: ctx.inBorderRoom,
          inForeignOwnedRoom: false,
          hostileTowersPresent: signals.hostileTowersPresent,
          hostileSpawnsPresent: signals.hostileSpawnsPresent,
          victimWasScout: false,
          victimWasLuna: false,
          victimInCombatSquad: false,
          provokedReconLikely: false,
          confidence: attribution.confidence || 'low',
          reasonCode: 'pending_classification',
          structureAttack: true
        };

        var classInfo = classifyIncident(inc);
        inc.reasonCode = classInfo.reason;
        inc.validAggression = classInfo.validAggression;
        inc.ignored = classInfo.ignored;
        pushIncident(inc);

        if (inc.attackerUsername) {
          observeOwner(inc.attackerUsername, roomName, 'structure_attack');
        }
        if (classInfo.validAggression && inc.attackerUsername) {
          addRetaliation(inc.attackerUsername, inc.reasonCode, roomName);
        }
      }

      vitals[s.id] = { hits: s.hits, roomName: roomName, t: now() };
    }
  }
}

function expireStale() {
  var mem = ensureCombatMemory();
  var t = now();

  for (var user in mem.watchList) {
    if (!Object.prototype.hasOwnProperty.call(mem.watchList, user)) continue;
    if (!hasLiveEntry(mem.watchList[user])) delete mem.watchList[user];
  }

  for (var rUser in mem.retaliation) {
    if (!Object.prototype.hasOwnProperty.call(mem.retaliation, rUser)) continue;
    if (!hasLiveEntry(mem.retaliation[rUser])) delete mem.retaliation[rUser];
  }

  var combatCfg = cfgCombat();
  var incidentTtl = (typeof combatCfg.INCIDENT_TTL === 'number') ? combatCfg.INCIDENT_TTL : DEFAULTS.INCIDENT_TTL;
  var kept = [];
  for (var i = 0; i < mem.incidents.length; i++) {
    var inc = mem.incidents[i];
    if (!inc || typeof inc.t !== 'number') continue;
    if ((t - inc.t) <= incidentTtl) kept.push(inc);
  }
  mem.incidents = kept;
}

function observeRoomIntel(room, intel, sourceTag) {
  if (!room) return;
  var data = intel || (Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].intel) || null;
  if (!data) return;

  var owner = data.owner || null;
  var reservation = data.reservation || null;
  if (owner) observeOwner(owner, room.name, sourceTag || 'intel_owner');
  if (reservation) observeOwner(reservation, room.name, sourceTag || 'intel_reservation');

  // If we have nearby enemy spawn/tower infrastructure, keep them watched.
  var hasHostileInfra = false;
  if (Array.isArray(data.enemySpawns) && data.enemySpawns.length > 0) hasHostileInfra = true;
  if (Array.isArray(data.enemyTowers) && data.enemyTowers.length > 0) hasHostileInfra = true;
  if (hasHostileInfra && owner) {
    observeOwner(owner, room.name, sourceTag || 'intel_hostile_infra');
  }
}

function runTick() {
  ensurePolicyLists();
  processCreepDamageAndDeaths();
  processStructureDamage();
  expireStale();
}

module.exports = {
  ensureMemory: ensureCombatMemory,
  runTick: runTick,
  observeRoomIntel: observeRoomIntel,
  observeOwner: observeOwner,
  shouldTargetOwnerUsername: shouldTargetOwnerUsername,
  computeRoomContext: computeRoomContext,
  isManualTarget: function (name) { return isManualTarget(lowerUsername(name)); },
  isWatched: function (name) { return isWatched(lowerUsername(name)); },
  isRetaliatory: function (name) { return isRetaliatory(lowerUsername(name)); },
  addRetaliation: addRetaliation,
  classifyIncident: classifyIncident
};
