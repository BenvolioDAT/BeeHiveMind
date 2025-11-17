'use strict';

var CoreLogger = require('core.logger');
var LOG_LEVEL = CoreLogger.LOG_LEVEL;

var combatLog = CoreLogger.createLogger('CombatSquads', LOG_LEVEL.DEBUG);

/**
 * BeeCombatSquads owns the combat squad state machine and exports a CombatAPI
 * helper bundle (INIT → FORM → ENGAGE → RETREAT). Roles consume
 * BeeCombatSquads.CombatAPI to resolve shared formation, targets, and state
 * while this module continues to surface convenience lookups for legacy
 * callers.
 */

var CoreConfig = require('core.config');

// --- Squad flag orchestration (ported from SquadFlagManager) ---------------
var FLAG_CFG = {
  DEBUG: false,
  SUPPORT_PREFIX: 'SQUAD_',
  TYPES: {
    RALLY: { color: COLOR_GREEN, secondary: COLOR_WHITE },
    ATTACK: { color: COLOR_RED, secondary: COLOR_WHITE },
    RETREAT: { color: COLOR_YELLOW, secondary: COLOR_WHITE },
    WAYPOINT: { color: COLOR_BLUE, secondary: COLOR_WHITE }
  }
};

var THREAT_DECAY_TICKS = 150;

function flagLogDebug() {
  if (!FLAG_CFG.DEBUG || !console || !console.log) return;
  var args = Array.prototype.slice.call(arguments);
  args.unshift('[SquadFlags]');
  console.log.apply(console, args);
}

function isSupportFlag(name) {
  return Boolean(name && name.indexOf(FLAG_CFG.SUPPORT_PREFIX) === 0);
}

function isSquadFlag(name) {
  if (!name) return false;
  if (isSupportFlag(name)) return false;
  return name.indexOf('Squad') === 0;
}

function ensureSquadFlagMemory() {
  if (!Memory.squadFlags) Memory.squadFlags = { rooms: {}, bindings: {} };
  if (!Memory.squadFlags.rooms) Memory.squadFlags.rooms = {};
  if (!Memory.squadFlags.bindings) Memory.squadFlags.bindings = {};
  return Memory.squadFlags;
}

/**
 * ensureSquadMemoryFromFlag seeds Memory.squads with rally + member slots so
 * the rest of the CombatAPI always finds a bucket, even for new flags.
 */
function ensureSquadMemoryFromFlag(flag) {
  if (!flag || !flag.name || !flag.pos) return;
  if (!Memory.squads) Memory.squads = {};
  if (!Memory.squads[flag.name]) {
    Memory.squads[flag.name] = {
      state: 'INIT',
      targetId: null,
      rally: null,
      lastSeenTick: 0,
      members: { leader: null, buddy: null, medic: null }
    };
  }
  var bucket = Memory.squads[flag.name];
  if (!bucket.members) bucket.members = { leader: null, buddy: null, medic: null };
  if (!bucket.rally) {
    bucket.rally = serializePos(flag.pos);
  }
  bucket.lastSeenTick = Game.time;
}

/**
 * updateRoomRecord keeps SquadFlagIntel fresh so spawning + UI can see
 * last-known threat scores even without vision. The helper also applies a
 * soft decay when no threat is present so stale rooms naturally drop to 0.
 */
function updateRoomRecord(mem, flag, room, threatScore, sawThreat) {
  if (!flag || !flag.pos) return;
  var roomName = flag.pos.roomName;
  if (!mem.rooms[roomName]) {
    mem.rooms[roomName] = { lastSeen: 0, lastThreatAt: 0, lastPos: null, lastScore: 0 };
  }
  var rec = mem.rooms[roomName];
  rec.lastSeen = Game.time;
  rec.lastPos = { x: flag.pos.x, y: flag.pos.y, roomName: roomName };
  if (typeof threatScore === 'number') rec.lastScore = threatScore;
  if (sawThreat) {
    rec.lastThreatAt = Game.time;
  } else if (rec.lastScore > 0) {
    var sinceLastThreat = Game.time - (rec.lastThreatAt || rec.lastSeen || 0);
    if (sinceLastThreat > THREAT_DECAY_TICKS) {
      rec.lastScore = 0;
    }
  }
  mem.rooms[roomName] = rec;
}

// BHM Combat Fix: central hostile detection + ally filtering helpers.
var _cachedMyUsername = null;

function resolveMyUsername() {
  if (_cachedMyUsername) return _cachedMyUsername;
  if (global.__beeUsername) {
    _cachedMyUsername = lowerUsername(global.__beeUsername);
    return _cachedMyUsername;
  }
  for (var name in Game.spawns) {
    if (!Object.prototype.hasOwnProperty.call(Game.spawns, name)) continue;
    var spawn = Game.spawns[name];
    if (!spawn || !spawn.my || !spawn.owner || !spawn.owner.username) continue;
    _cachedMyUsername = lowerUsername(spawn.owner.username);
    global.__beeUsername = spawn.owner.username;
    return _cachedMyUsername;
  }
  for (var cname in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, cname)) continue;
    var creep = Game.creeps[cname];
    if (!creep || !creep.my || !creep.owner || !creep.owner.username) continue;
    _cachedMyUsername = lowerUsername(creep.owner.username);
    global.__beeUsername = creep.owner.username;
    return _cachedMyUsername;
  }
  return null;
}

/**
 * combatSettings centralizes all combat toggles so detection + spawn + roles
 * stay perfectly in sync with CoreConfig.
 */
function combatSettings() {
  if (!CoreConfig || !CoreConfig.settings || !CoreConfig.settings.combat) return {};
  return CoreConfig.settings.combat;
}

function combatDebugEnabled() {
  var settings = combatSettings();
  return settings && settings.DEBUG_LOGS === true;
}

function combatDebugLog() {
  if (!combatDebugEnabled() || !console || !console.log) return;
  var args = Array.prototype.slice.call(arguments);
  args.unshift('[CombatDBG]');
  console.log.apply(console, args);
}

/**
 * Owner filtering is centralized so every detection helper respects
 * CoreConfig (PVP toggle + ally list + PvE allowances).
 */
function shouldTargetOwner(owner, avoidMap) {
  if (!owner || !owner.username) return false;
  var username = lowerUsername(owner.username);
  if (avoidMap && avoidMap[username]) return false;
  var myName = resolveMyUsername();
  if (myName && username === myName) return false;
  var settings = combatSettings();
  if (username === 'invader') {
    return settings.ALLOW_INVADERS_IN_FOREIGN_ROOMS !== false;
  }
  if (username === 'source keeper') {
    return settings.TREAT_SOURCE_KEEPERS_AS_PVE !== false;
  }
  if (settings.ALLOW_PVP === false) return false;
  return true;
}

function isHostileCreep(creep, avoidMap) {
  if (!creep || !creep.owner) return false;
  return shouldTargetOwner(creep.owner, avoidMap);
}

function isHostilePowerCreep(powerCreep, avoidMap) {
  if (!powerCreep || !powerCreep.owner) return false;
  return shouldTargetOwner(powerCreep.owner, avoidMap);
}

function isHostileStructure(structure, avoidMap) {
  if (!structure || structure.my) return false;
  if (structure.structureType === STRUCTURE_INVADER_CORE) return true;
  if (!structure.owner) return false;
  return shouldTargetOwner(structure.owner, avoidMap);
}

/**
 * gatherHostileCandidates is the shared ingress for hostile detection.
 * Every downstream scoring/state helper consumes this bundle so we only
 * pay for expensive FIND calls once per tick and they all respect the same
 * ally avoidance map + config gates.
 */
function gatherHostileCandidates(room, avoidMap) {
  var candidates = { creeps: [], power: [], structures: [] };
  if (!room || typeof room.find !== 'function') return candidates;
  candidates.creeps = room.find(FIND_HOSTILE_CREEPS, {
    filter: function (creep) { return isHostileCreep(creep, avoidMap); }
  });
  if (typeof FIND_HOSTILE_POWER_CREEPS !== 'undefined') {
    candidates.power = room.find(FIND_HOSTILE_POWER_CREEPS, {
      filter: function (p) { return isHostilePowerCreep(p, avoidMap); }
    });
  }
  candidates.structures = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function (s) { return isHostileStructure(s, avoidMap); }
  });
  return candidates;
}

function computeThreatScore(candidates) {
  if (!candidates) return 0;
  var creepScore = (candidates.creeps ? candidates.creeps.length : 0) * 5;
  var structScore = (candidates.structures ? candidates.structures.length : 0) * 3;
  var powerScore = (candidates.power ? candidates.power.length : 0) * 7;
  return creepScore + structScore + powerScore;
}

/**
 * pickBestTarget scores creeps/power/structures relative to the squad anchor
 * and returns the highest priority object for focusFire.
 */
function pickBestTarget(candidates, anchorPos) {
  if (!candidates) return null;
  var best = null;
  var bestScore = -1000000;
  var i;
  if (candidates.creeps) {
    for (i = 0; i < candidates.creeps.length; i++) {
      var creep = candidates.creeps[i];
      var score = scoreCreep(creep, anchorPos);
      if (score > bestScore) {
        bestScore = score;
        best = creep;
      }
    }
  }
  if (candidates.power) {
    for (i = 0; i < candidates.power.length; i++) {
      var powerCreep = candidates.power[i];
      var scoreP = scorePowerCreep(powerCreep, anchorPos);
      if (scoreP > bestScore) {
        bestScore = scoreP;
        best = powerCreep;
      }
    }
  }
  if (candidates.structures) {
    for (i = 0; i < candidates.structures.length; i++) {
      var structure = candidates.structures[i];
      var scoreS = scoreStructure(structure, anchorPos);
      if (scoreS > bestScore) {
        bestScore = scoreS;
        best = structure;
      }
    }
  }
  return best;
}

/**
 * countHostiles collapses gatherHostileCandidates() into a cheap summary
 * so auto-defense + spawn logic can reason about aggregate threat over time.
 */
function countHostiles(room) {
  if (!room) return { score: 0, hasThreat: false };
  var avoid = buildAvoidMap();
  var candidates = gatherHostileCandidates(room, avoid);
  var score = computeThreatScore(candidates);
  var total = 0;
  if (candidates.creeps) total += candidates.creeps.length;
  if (candidates.power) total += candidates.power.length;
  if (candidates.structures) total += candidates.structures.length;
  return { score: score, hasThreat: total > 0 };
}

function samePos(a, b) {
  return Boolean(a && b && a.x === b.x && a.y === b.y && a.roomName === b.roomName);
}

function posFrom(data) {
  var raw = serializePos(data);
  if (!raw || raw.x == null || raw.y == null || !raw.roomName) return null;
  return raw;
}

function resolvePlan(flagName) {
  if (!flagName || !Memory.squads) return null;
  var bucket = Memory.squads[flagName];
  if (!bucket) return null;
  var attack = bucket.target || bucket.targetPos || bucket.attack || bucket.focusTargetPos;
  if (!attack && bucket.focusTarget) {
    var obj = Game.getObjectById(bucket.focusTarget);
    if (obj && obj.pos) attack = obj.pos;
  }
  var attackPos = posFrom(attack);
  var rallyPos = posFrom(bucket.rally || bucket.rallyPos || bucket.anchor || bucket.squadRally);
  var targetRoomName = bucket.targetRoom || (attackPos ? attackPos.roomName : null);
  var displayPos = null;
  if (attackPos && attackPos.roomName) {
    displayPos = roomCenter(attackPos.roomName);
  } else if (targetRoomName) {
    displayPos = roomCenter(targetRoomName);
  }
  return {
    name: flagName,
    state: extractState(flagName, bucket),
    rally: rallyPos,
    attack: attackPos,
    retreat: posFrom(bucket.retreat || bucket.retreatPos || bucket.fallback || bucket.fallbackPos),
    waypoints: normalizeWaypoints(bucket.waypoints || bucket.route || bucket.path || bucket.waypointList),
    targetRoom: targetRoomName,
    displayPos: displayPos
  };
}

function extractState(flagName, mem) {
  if (mem && mem.state) return mem.state;
  if (CombatAPI && typeof CombatAPI.getSquadState === 'function') {
    return CombatAPI.getSquadState(flagName);
  }
  return 'INIT';
}

function normalizeWaypoints(raw) {
  if (!raw) return [];
  var list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw.points && Array.isArray(raw.points)) list = raw.points;
  else list = [raw];
  var normalized = [];
  for (var i = 0; i < list.length; i++) {
    var pos = posFrom(list[i]);
    if (pos) normalized.push(pos);
  }
  return normalized;
}

var FlagIO = {
  ensureFlag: function ensureFlag(name, pos, color, secondary, allowAlternate) {
    if (!name || !pos) return null;
    var desired = posFrom(pos);
    if (!desired) {
      if (FLAG_CFG.DEBUG) flagLogDebug('Invalid position for', name);
      return null;
    }
    var existing = Game.flags[name];
    if (existing) {
      if (existing.pos && !samePos(existing.pos, desired) && existing.setPosition) {
        var moveRc = existing.setPosition(desired.x, desired.y);
        if (moveRc !== OK && FLAG_CFG.DEBUG) {
          flagLogDebug('Failed to move flag', name, '->', moveRc);
        }
      }
      var needsPrimary = color != null && existing.color !== color;
      var needsSecondary = secondary != null && existing.secondaryColor !== secondary;
      if ((needsPrimary || needsSecondary) && existing.setColor) {
        existing.setColor(color || existing.color, secondary || existing.secondaryColor);
      }
      return existing;
    }
    var roomName = desired.roomName;
    if (!roomName) {
      if (FLAG_CFG.DEBUG) flagLogDebug('Missing room for', name);
      return null;
    }
    var room = Game.rooms[roomName];
    if (!room) {
      if (FLAG_CFG.DEBUG) flagLogDebug('No vision in', roomName, 'to place flag', name);
      return null;
    }
    if (color == null || secondary == null) {
      if (FLAG_CFG.DEBUG) flagLogDebug('Color undefined for', name);
      return null;
    }
    var result = room.createFlag(desired.x, desired.y, name, color, secondary);
    if (typeof result === 'string') return Game.flags[result];
    if (result === ERR_NAME_EXISTS && allowAlternate !== false) {
      var altName = name + '_1';
      if (!Game.flags[altName]) {
        var retry = room.createFlag(desired.x, desired.y, altName, color, secondary);
        if (typeof retry === 'string') return Game.flags[retry];
      } else if (samePos(Game.flags[altName].pos, desired)) {
        return Game.flags[altName];
      }
    }
    if (result !== OK && FLAG_CFG.DEBUG) flagLogDebug('Failed to place', name, '->', result);
    return existing || null;
  },
  getOrMake: function getOrMake(name, roomName, x, y, color, secondary) {
    if (!roomName || x == null || y == null) return null;
    return this.ensureFlag(name, { x: x, y: y, roomName: roomName }, color, secondary);
  }
};

function roomCenter(roomName) {
  if (!roomName) return null;
  return { x: 25, y: 25, roomName: roomName };
}

function resolveDisplayPosition(plan) {
  if (!plan) return null;
  if (plan.displayPos) return plan.displayPos;
  if (plan.attack && plan.attack.roomName) return roomCenter(plan.attack.roomName);
  if (plan.targetRoom) return roomCenter(plan.targetRoom);
  if (plan.rally) return plan.rally;
  var intel = Memory.squadFlags;
  if (intel && intel.bindings && intel.bindings[plan.name]) {
    return roomCenter(intel.bindings[plan.name]);
  }
  if (Game.flags && Game.flags[plan.name] && Game.flags[plan.name].pos) {
    return serializePos(Game.flags[plan.name].pos);
  }
  return null;
}

function ensurePrimaryFlag(plan) {
  if (!plan || !plan.name) return null;
  var displayPos = resolveDisplayPosition(plan);
  if (!displayPos) return null;
  var colors = FLAG_CFG.TYPES.RALLY;
  return FlagIO.ensureFlag(plan.name, displayPos, colors.color, colors.secondary, false);
}

function cleanupSupportFlags() {
  for (var name in Game.flags) {
    if (!Object.prototype.hasOwnProperty.call(Game.flags, name)) continue;
    if (!isSupportFlag(name)) continue;
    var flag = Game.flags[name];
    if (flag && typeof flag.remove === 'function') flag.remove();
  }
}

function syncPlannedFlags() {
  if (!Memory.squads) return;
  for (var flagName in Memory.squads) {
    if (!Object.prototype.hasOwnProperty.call(Memory.squads, flagName)) continue;
    if (flagName.indexOf('Squad') !== 0) continue;
    var plan = resolvePlan(flagName);
    if (!plan) continue;
    ensurePrimaryFlag(plan);
  }
  cleanupSupportFlags();
}

function resolveSquadTarget(identifier) {
  var intel = ensureSquadFlagMemory();
  var bindings = intel.bindings || {};
  var names = [];
  if (identifier) {
    names.push(identifier);
    if (identifier.indexOf('Squad') !== 0) names.push('Squad' + identifier);
    if (identifier.indexOf('Squad_') !== 0) names.push('Squad_' + identifier);
  }
  var seen = {};
  var flag = null;
  var targetRoom = null;
  var resolvedName = null;
  for (var i = 0; i < names.length; i++) {
    var candidate = names[i];
    if (!candidate || seen[candidate]) continue;
    seen[candidate] = true;
    if (!flag && Game.flags && Game.flags[candidate]) {
      flag = Game.flags[candidate];
      if (!resolvedName) resolvedName = candidate;
    }
    if (!targetRoom && bindings[candidate]) {
      targetRoom = bindings[candidate];
      if (!resolvedName) resolvedName = candidate;
    }
  }
  if (!flag && resolvedName && Game.flags && Game.flags[resolvedName]) {
    flag = Game.flags[resolvedName];
  }
  if (!targetRoom && flag && flag.pos) {
    targetRoom = flag.pos.roomName;
    if (!resolvedName) resolvedName = flag.name;
  }
  if (!targetRoom && resolvedName && Memory.squads && Memory.squads[resolvedName]) {
    var bucket = Memory.squads[resolvedName];
    if (bucket && bucket.targetRoom) {
      targetRoom = bucket.targetRoom;
    }
  }
  var plan = resolvedName ? resolvePlan(resolvedName) : null;
  return {
    flag: flag,
    flagName: resolvedName,
    targetRoom: targetRoom,
    plan: plan,
    mem: intel
  };
}

/**
 * threatScoreForRoom exposes the decayed intel view so spawners can react
 * even while vision is missing. Scores fall to zero after THREAT_DECAY_TICKS.
 */
function threatScoreForRoom(roomName) {
  if (!roomName) return 0;
  var intel = ensureSquadFlagMemory();
  var rooms = intel.rooms || {};
  var rec = rooms[roomName];
  if (!rec || typeof rec.lastScore !== 'number') return 0;
  var score = rec.lastScore | 0;
  if (score <= 0) return 0;
  var lastThreatTick = rec.lastThreatAt || rec.lastSeen || 0;
  if (!lastThreatTick) return 0;
  if ((Game.time - lastThreatTick) > THREAT_DECAY_TICKS) return 0;
  return score;
}

/**
 * ensureSquadFlags is the top-level heartbeat for the combat pipeline. It
 * refreshes auto-defense plans, syncs flag memory, resolves a shared focus
 * target per squad, and finally pushes the derived state back into memory.
 */
function ensureSquadFlags() {
  refreshAutoDefensePlans();
  var mem = ensureSquadFlagMemory();
  var seen = {};

  for (var name in Game.flags) {
    if (!Object.prototype.hasOwnProperty.call(Game.flags, name)) continue;
    if (!isSquadFlag(name)) continue;
    var flag = Game.flags[name];
    seen[name] = true;
    mem.bindings[name] = flag.pos.roomName;

    ensureSquadMemoryFromFlag(flag);

    var room = flag.room || null;
    var threat = countHostiles(room);
    var targetId = CombatAPI.focusFireTarget(name);
    var currentState = CombatAPI.getSquadState(name);
    var nextState = currentState;
    if (currentState !== 'RETREAT') {
      var hostilePresent = threat.hasThreat || Boolean(targetId);
      nextState = hostilePresent ? 'ENGAGE' : 'FORM';
    }
    CombatAPI.setSquadState(name, nextState);
    updateRoomRecord(mem, flag, room, threat.score, threat.hasThreat);
  }

  for (var existing in mem.bindings) {
    if (!Object.prototype.hasOwnProperty.call(mem.bindings, existing)) continue;
    if (!seen[existing]) delete mem.bindings[existing];
  }

  for (var roomName in mem.rooms) {
    if (!Object.prototype.hasOwnProperty.call(mem.rooms, roomName)) continue;
    var rec = mem.rooms[roomName];
    if (!rec) continue;
    if ((Game.time - (rec.lastSeen || 0)) > 20000) delete mem.rooms[roomName];
  }

  cleanupFinishedSquads();
  syncPlannedFlags();
}

// --- Shared helpers -------------------------------------------------------
// Using top-level helpers instead of nested functions makes them easier to
// unit-test and reuse while keeping the logic approachable for new engineers.
// Each helper below is intentionally tiny and single-purpose so you can read
// it in isolation before seeing how it plugs into the larger orchestration.
var VALID_STATES = { INIT: true, FORM: true, ENGAGE: true, RETREAT: true };

function lowerUsername(str) {
  if (!str) return '';
  return String(str).toLowerCase();
}

function ensureSquadMemory(flagName) {
  // Habit: always normalize/guard your inputs at the very top of a helper.
  if (!flagName) return null;
  if (!Memory.squads) Memory.squads = {};
  var bucket = Memory.squads[flagName];
  if (!bucket) {
    bucket = {
      state: 'INIT',
      targetId: null,
      members: { leader: null, buddy: null, medic: null },
      rally: null,
      lastSeenTick: 0
    };
    Memory.squads[flagName] = bucket;
  } else {
    if (!bucket.members) bucket.members = { leader: null, buddy: null, medic: null };
    if (!bucket.state) bucket.state = 'INIT';
  }
  return bucket;
}

function serializePos(pos) {
  if (!pos) return null;
  if (pos instanceof RoomPosition) {
    return { x: pos.x, y: pos.y, roomName: pos.roomName };
  }
  if (pos.pos) return serializePos(pos.pos);
  if (pos.x != null && pos.y != null && pos.roomName) {
    return { x: pos.x, y: pos.y, roomName: pos.roomName };
  }
  if (typeof pos === 'string' && Game && Game.flags) {
    var flag = Game.flags[pos];
    if (flag && flag.pos) return serializePos(flag.pos);
  }
  return null;
}

function deserializePos(data) {
  if (!data || data.x == null || data.y == null || !data.roomName) return null;
  return new RoomPosition(data.x, data.y, data.roomName);
}

function squadHasLiveMembers(flagName) {
  if (!flagName || !Memory.squads || !Memory.squads[flagName]) return false;
  var members = Memory.squads[flagName].members || {};
  if (members.leader && Game.getObjectById(members.leader)) return true;
  if (members.buddy && Game.getObjectById(members.buddy)) return true;
  if (members.medic && Game.getObjectById(members.medic)) return true;
  return false;
}

function pickRallyPoint(room) {
  if (!room) return null;
  var spawns = room.find ? room.find(FIND_MY_SPAWNS) : null;
  if (spawns && spawns.length) return serializePos(spawns[0].pos);
  if (room.controller) return serializePos(room.controller.pos);
  return serializePos(new RoomPosition(25, 25, room.name));
}

function resolveTargetRoomForSquad(flagName, bucket, intel) {
  if (bucket) {
    if (bucket.targetRoom) return bucket.targetRoom;
    var attackSource = bucket.targetPos || bucket.target || bucket.attack || bucket.focusTargetPos;
    var attackPos = posFrom(attackSource);
    if (attackPos && attackPos.roomName) return attackPos.roomName;
    var rallyPos = posFrom(bucket.rally);
    if (rallyPos && rallyPos.roomName) return rallyPos.roomName;
  }
  var mem = intel || ensureSquadFlagMemory();
  if (mem && mem.bindings && mem.bindings[flagName]) return mem.bindings[flagName];
  return null;
}

function shouldCleanupSquad(flagName, bucket, intel) {
  if (!flagName || !bucket) return false;
  if (bucket.autoDefense) return false;
  if (squadHasLiveMembers(flagName)) return false;
  var targetRoom = resolveTargetRoomForSquad(flagName, bucket, intel);
  if (targetRoom && threatScoreForRoom(targetRoom) > 0) return false;
  return true;
}

function cleanupFinishedSquads() {
  if (!Memory.squads) return;
  var intel = ensureSquadFlagMemory();
  var pending = [];
  for (var flagName in Memory.squads) {
    if (!Object.prototype.hasOwnProperty.call(Memory.squads, flagName)) continue;
    var bucket = Memory.squads[flagName];
    if (!shouldCleanupSquad(flagName, bucket, intel)) continue;
    pending.push(flagName);
  }
  for (var i = 0; i < pending.length; i++) {
    var name = pending[i];
    var flag = Game.flags && Game.flags[name] ? Game.flags[name] : null;
    if (flag && typeof flag.remove === 'function') flag.remove();
    delete Memory.squads[name];
    if (intel && intel.bindings && intel.bindings[name]) delete intel.bindings[name];
  }
}

function cleanupAutoDefense(flagName) {
  if (!flagName || !Memory.squads || !Memory.squads[flagName]) return;
  var bucket = Memory.squads[flagName];
  if (!bucket.autoDefense) return;
  var targetRoom = bucket.targetRoom;
  if (Game.flags && Game.flags[flagName] && typeof Game.flags[flagName].remove === 'function') {
    Game.flags[flagName].remove();
  }
  var intel = Memory.squadFlags;
  if (intel) {
    if (intel.bindings && intel.bindings[flagName]) delete intel.bindings[flagName];
    if (targetRoom && intel.rooms && intel.rooms[targetRoom]) delete intel.rooms[targetRoom];
  }
  delete Memory.squads[flagName];
}

// BHM Combat Fix: automatically maintain one defensive squad per owned room.
/**
 * ensureAutoDefenseForRoom wires each owned room to a defensive squad entry
 * and only persists that plan while mobile hostiles exist. Static PvE
 * structures (e.g. Invader cores) are tracked via intel but do not keep
 * respawning new defenders forever.
 */
function ensureAutoDefenseForRoom(room) {
  if (!room || !room.controller || !room.controller.my) return;
  var flagName = 'Squad' + room.name;
  var avoid = buildAvoidMap();
  var candidates = gatherHostileCandidates(room, avoid);
  var score = computeThreatScore(candidates);
  var mobile = 0;
  if (candidates.creeps) mobile += candidates.creeps.length;
  if (candidates.power) mobile += candidates.power.length;
  var bucket = Memory.squads ? Memory.squads[flagName] : null;
  if (mobile <= 0) {
    if (bucket && bucket.autoDefense) {
      bucket.lastKnownScore = 0;
      bucket.targetId = null;
      bucket.focusTarget = null;
      bucket.targetPos = null;
      bucket.focusTargetPos = null;
      if (!squadHasLiveMembers(flagName)) {
        cleanupAutoDefense(flagName);
      }
    }
    return;
  }

  var mem = ensureSquadMemory(flagName);
  mem.autoDefense = true;
  mem.planType = 'AUTO_DEFENSE';
  mem.targetRoom = room.name;
  mem.lastKnownScore = score;
  mem.lastDefenseTick = Game.time;
  mem.lastSeenTick = Game.time;

  if (!mem.rally) {
    mem.rally = pickRallyPoint(room);
  }
  var rallyPos = mem.rally ? deserializePos(mem.rally) : null;
  if (!rallyPos) {
    mem.rally = pickRallyPoint(room);
    rallyPos = mem.rally ? deserializePos(mem.rally) : null;
  }

  var anchor = rallyPos || (room.controller ? room.controller.pos : null);
  var best = pickBestTarget(candidates, anchor);
  var attackPos = null;
  if (best && best.pos) attackPos = best.pos;
  else if (candidates.creeps && candidates.creeps[0] && candidates.creeps[0].pos) attackPos = candidates.creeps[0].pos;
  else if (room.controller) attackPos = room.controller.pos;
  else attackPos = new RoomPosition(25, 25, room.name);

  if (best && best.id) {
    mem.targetId = best.id;
    mem.focusTarget = best.id;
  }
  if (attackPos) {
    var serialized = serializePos(attackPos);
    mem.targetPos = serialized;
    mem.focusTargetPos = serialized;
    mem.target = serialized;
  }

  var intel = ensureSquadFlagMemory();
  updateRoomRecord(intel, { pos: attackPos }, room, score, true);
}

/**
 * refreshAutoDefensePlans walks all owned rooms and wires them into
 * ensureAutoDefenseForRoom so defender squads automatically form/dissolve
 * as local intel changes.
 */
function refreshAutoDefensePlans() {
  for (var roomName in Game.rooms) {
    if (!Object.prototype.hasOwnProperty.call(Game.rooms, roomName)) continue;
    var room = Game.rooms[roomName];
    if (!room || !room.controller || !room.controller.my) continue;
    ensureAutoDefenseForRoom(room);
  }
}

/**
 * buildAvoidMap merges CoreConfig allies + squad formation owners into a
 * lookup so no detection routine accidentally targets a friendly user.
 */
function buildAvoidMap(extra) {
  // Defensive copy: we build a brand-new lookup each tick so we never mutate
  // caller-owned data.
  var avoid = {};
  var allies = CoreConfig.ALLY_USERNAMES || [];
  for (var i = 0; i < allies.length; i++) {
    avoid[lowerUsername(allies[i])] = true;
  }
  var myName = resolveMyUsername();
  if (myName) avoid[myName] = true;
  if (extra) {
    for (var k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) {
        avoid[lowerUsername(k)] = true;
      }
    }
  }
  return avoid;
}

function currentFocusCache() {
  // The global cache lets every creep share the same expensive computations
  // for a tick.
  // Always stamp the tick number so the cache expires naturally.
  if (!global.__combatApiCache || global.__combatApiCache.tick !== Game.time) {
    global.__combatApiCache = { tick: Game.time, focus: {} };
  }
  return global.__combatApiCache;
}

function isAlly(owner, avoidMap) {
  if (!owner || !owner.username) return false;
  return avoidMap[lowerUsername(owner.username)] === true;
}

function pickByRole(creeps, roleName, excludeId) {
  // Because Screeps API calls are expensive, we pass already-fetched creep
  // objects around instead of repeatedly calling Game.getObjectById.
  for (var i = 0; i < creeps.length; i++) {
    var c = creeps[i];
    if (!c || !c.memory) continue;
    if (excludeId && c.id === excludeId) continue;
    if (!roleName) return c;
    if (c.memory.role === roleName) return c;
  }
  return null;
}

function scoreCreep(target, anchorPos) {
  // Teaching moment: scoring systems are a great way to express intent.
  // Instead of deeply nested if/else statements we assign weights to traits
  // and let math pick the winner.
  if (!target) return -1000000;
  var score = 0;
  var heal = target.getActiveBodyparts ? target.getActiveBodyparts(HEAL) : 0;
  var ranged = target.getActiveBodyparts ? target.getActiveBodyparts(RANGED_ATTACK) : 0;
  var melee = target.getActiveBodyparts ? target.getActiveBodyparts(ATTACK) : 0;
  var tough = target.getActiveBodyparts ? target.getActiveBodyparts(TOUGH) : 0;
  score += heal * 600;
  score += ranged * 300;
  score += melee * 150;
  score -= tough * 25;
  score += (target.hitsMax || 0) - (target.hits || 0);
  if (anchorPos) score -= anchorPos.getRangeTo(target) * 5;
  return score;
}

function scorePowerCreep(powerCreep, anchorPos) {
  if (!powerCreep) return -1000000;
  var score = 600;
  if (powerCreep.powers) {
    var abilityCount = Object.keys(powerCreep.powers).length;
    score += abilityCount * 75;
  }
  if (powerCreep.hitsMax && powerCreep.hits != null) {
    score += (powerCreep.hitsMax - powerCreep.hits);
  }
  if (anchorPos) score -= anchorPos.getRangeTo(powerCreep) * 5;
  return score;
}

function scoreStructure(structure, anchorPos) {
  if (!structure) return -1000000;
  var score = 0;
  var type = structure.structureType || '';
  if (type === STRUCTURE_INVADER_CORE) score += 1200;
  if (type === STRUCTURE_TOWER) score += 800;
  if (type === STRUCTURE_SPAWN) score += 500;
  if (structure.hitsMax && structure.hits != null) {
    score += (structure.hitsMax - structure.hits);
  }
  if (anchorPos) score -= anchorPos.getRangeTo(structure) * 5;
  return score;
}

/**
 * buildAvoidanceFromSquadMembers prevents a squad from targeting itself or
 * allied creeps by treating every member's owner as "friendly" for the
 * duration of the focusFire scan.
 */
function buildAvoidanceFromSquadMembers(formation) {
  // We skip friendly owners so the squad never targets itself or friends.
  var avoid = {};
  if (!formation) return avoid;
  var leader = formation.leader ? Game.getObjectById(formation.leader) : null;
  var buddy = formation.buddy ? Game.getObjectById(formation.buddy) : null;
  var medic = formation.medic ? Game.getObjectById(formation.medic) : null;
  if (leader && leader.owner && leader.owner.username) avoid[leader.owner.username] = true;
  if (buddy && buddy.owner && buddy.owner.username) avoid[buddy.owner.username] = true;
  if (medic && medic.owner && medic.owner.username) avoid[medic.owner.username] = true;
  return avoid;
}

/**
 * resolveRoomForSquad tries every cheap source (flag → members → memory) so
 * focusFireTarget can continue scanning even when only one squad member has
 * vision of the hostile room.
 */
function resolveRoomForSquad(flagName, formation, currentObj, bucket) {
  // Always try the cheapest data source first (flag cache) before falling
  // back to heavier Game lookups.
  var flag = Game.flags && Game.flags[flagName] ? Game.flags[flagName] : null;
  if (flag && flag.room) return flag.room;
  if (flag && flag.pos && Game.rooms && Game.rooms[flag.pos.roomName]) {
    return Game.rooms[flag.pos.roomName];
  }
  var leader = formation && formation.leader ? Game.getObjectById(formation.leader) : null;
  if (leader && leader.room) return leader.room;
  var buddy = formation && formation.buddy ? Game.getObjectById(formation.buddy) : null;
  if (buddy && buddy.room) return buddy.room;
  var medic = formation && formation.medic ? Game.getObjectById(formation.medic) : null;
  if (medic && medic.room) return medic.room;
  if (currentObj && currentObj.room) return currentObj.room;
  if (bucket) {
    if (bucket.targetRoom && Game.rooms && Game.rooms[bucket.targetRoom]) {
      return Game.rooms[bucket.targetRoom];
    }
    if (bucket.rally) {
      var rallyPos = deserializePos(bucket.rally);
      if (rallyPos && Game.rooms && Game.rooms[rallyPos.roomName]) {
        return Game.rooms[rallyPos.roomName];
      }
    }
  }
  return null;
}

// --- CombatAPI ------------------------------------------------------------
// Keeping the API object as a simple literal removes the IIFE and makes each
// helper function easier to trace and document.
/**
 * getSquadState exposes the shared squad FSM state so every creep reports
 * the same FORM/ENGAGE/RETREAT answer for a given flag.
 */
function getSquadState(flagName) {
  var bucket = ensureSquadMemory(flagName);
  return bucket ? bucket.state : 'INIT';
}

function setSquadState(flagName, state) {
  if (!VALID_STATES[state]) return;
  var bucket = ensureSquadMemory(flagName);
  if (!bucket) return;
  var previous = bucket.state;
  if (previous !== state && combatDebugEnabled()) {
    combatDebugLog('[SquadState]', flagName, previous || 'INIT', '→', state,
      'hpCheckAt', Game.time);
  }
  bucket.state = state;
}

function assignFormation(flagName, creepIdsArray) {
  // Formation assignment is intentionally verbose so newer coders can see the
  // decision tree. Each early return/branch is documented below.
  var bucket = ensureSquadMemory(flagName);
  var rallyPos = null;
  var flag = Game.flags && Game.flags[flagName] ? Game.flags[flagName] : null;
  if (flag && flag.pos) {
    bucket.rally = serializePos(flag.pos);
    rallyPos = flag.pos;
    bucket.lastSeenTick = Game.time;
  } else if (bucket.rally) {
    rallyPos = deserializePos(bucket.rally);
  }

  var creeps = [];
  var ids = [];
  if (creepIdsArray && creepIdsArray.length) {
    for (var i = 0; i < creepIdsArray.length; i++) {
      var id = creepIdsArray[i];
      var c = Game.getObjectById(id);
      if (!c) continue;
      creeps.push(c);
      ids.push(id);
    }
  }

  // Prefer a melee leader, fall back to the first available body.
  var leader = pickByRole(creeps, 'CombatMelee', null) || creeps[0] || null;
  var leaderId = leader ? leader.id : null;
  // Never assign the same creep twice; we pass leaderId into helper guards.
  var medic = pickByRole(creeps, 'CombatMedic', leaderId);
  var buddy = pickByRole(creeps, 'CombatArcher', leaderId);
  if (!buddy) {
    buddy = pickByRole(creeps, null, leaderId);
    if (!buddy && creeps.length > 1) {
      buddy = (creeps[0] && creeps[0].id !== leaderId) ? creeps[0] : creeps[1];
    }
  }

  var medicId = medic ? medic.id : null;
  var buddyId = buddy ? buddy.id : null;

  bucket.members = {
    leader: leaderId,
    buddy: buddyId,
    medic: medicId
  };

  return {
    leaderId: leaderId,
    buddyId: buddyId,
    medicId: medicId,
    rallyPos: rallyPos || deserializePos(bucket.rally)
  };
}

/**
 * getAttackTarget converts a live Room + avoid map into a concrete hostile id
 * by pulling fresh candidates, scoring them, and returning the highest value.
 */
function getAttackTarget(room, avoidAlliesSet) {
  // Finding a target involves a few steps; we annotate each to highlight the
  // "gather inputs → score options → pick winner" pattern.
  if (!room) return null;
  var avoid = buildAvoidMap(avoidAlliesSet);
  var anchorPos = null;
  var myCreeps = room.find(FIND_MY_CREEPS);
  if (myCreeps && myCreeps.length) anchorPos = myCreeps[0].pos;
  if (!anchorPos && room.controller) anchorPos = room.controller.pos;
  if (!anchorPos) anchorPos = new RoomPosition(25, 25, room.name);

  var candidates = gatherHostileCandidates(room, avoid);
  var best = pickBestTarget(candidates, anchorPos);
  return best ? best.id : null;
}

/**
 * focusFireTarget is the one true targeting oracle. It caches per-flag focus
 * results (target id + timestamp) so every role + orchestrator sees the exact
 * same hostile id when deciding movement or state transitions.
 */
function focusFireTarget(flagName) {
  // Focus fire is called from many roles, so we aggressively cache the result
  // per flag to keep CPU usage predictable.
  if (!flagName) return null;
  var cache = currentFocusCache();
  if (cache.focus.hasOwnProperty(flagName)) {
    return cache.focus[flagName];
  }

  var bucket = ensureSquadMemory(flagName);
  var prevId = bucket && bucket.targetId ? bucket.targetId : null;
  var currentId = prevId;
  var currentObj = currentId ? Game.getObjectById(currentId) : null;

  var formation = bucket && bucket.members ? bucket.members : null;
  var room = resolveRoomForSquad(flagName, formation, currentObj, bucket);
  var avoid = buildAvoidanceFromSquadMembers(bucket ? bucket.members : null);

  var nextId = null;
  if (room) {
    var pick = getAttackTarget(room, avoid);
    if (pick) {
      nextId = pick;
    }
    bucket.lastSeenTick = Game.time;
  }

  if (!nextId && currentObj) {
    nextId = currentObj.id;
  }

  bucket.targetId = nextId || null;
  cache.focus[flagName] = nextId || null;

  if (prevId !== bucket.targetId) {
    try {
      combatLog.debug(
        '[tick', Game.time, '] focusFireTarget',
        'flag=', flagName,
        'room=', room ? room.name : '(no room)',
        'prevTarget=', prevId,
        'nextTarget=', bucket.targetId
      );
    } catch (e) {}
  }

  if (combatDebugEnabled() && currentId !== nextId) {
    combatDebugLog('[Focus]', flagName, 'room', room ? room.name : (bucket ? bucket.targetRoom : null),
      'target', currentId || 'none', '→', nextId || 'none');
  }

  return nextId || null;
}

var CombatAPI = {
  getSquadState: getSquadState,
  setSquadState: setSquadState,
  assignFormation: assignFormation,
  focusFireTarget: focusFireTarget,
  getAttackTarget: getAttackTarget
};

// --- BeeCombatSquads cache + exports -------------------------------------
function cacheRoot() {
  // Same cache pattern as CombatAPI: always rebuild once per tick.
  if (!global.__beeSquadCache || global.__beeSquadCache.tick !== Game.time) {
    global.__beeSquadCache = { tick: Game.time, byFlag: {} };
    rebuildCache(global.__beeSquadCache.byFlag);
  }
  return global.__beeSquadCache;
}

function resolveFlagName(creep) {
  // Normalize both legacy (squadId) and modern (squadFlag) memories so
  // downstream helpers have a single field to trust.
  if (!creep || !creep.memory) return null;
  if (creep.memory.squadFlag) return creep.memory.squadFlag;
  var sid = creep.memory.squadId;
  if (!sid) return null;
  return 'Squad' + sid;
}

function collectCreepsByFlag() {
  // Iterating over Game.creeps is unavoidable, so we keep the inner loop
  // tiny and store only what later steps need (creep ids).
  var byFlag = {};
  for (var name in Game.creeps) {
    if (!Game.creeps.hasOwnProperty(name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.my) continue;
    var flagName = resolveFlagName(creep);
    if (!flagName) continue;
    creep.memory.squadFlag = flagName;
    if (!byFlag[flagName]) byFlag[flagName] = [];
    byFlag[flagName].push(creep.id);
  }
  return byFlag;
}

/**
 * decideState watches squad HP and focusFire results to toggle between
 * FORM → ENGAGE → RETREAT with a bit of hysteresis so squads can re-enter
 * combat after their medics top everyone off.
 */
function decideState(flagName, creepIds, targetId) {
  if (!creepIds || !creepIds.length) return 'INIT';
  var injured = false;
  var fullyHealed = true;
  for (var i = 0; i < creepIds.length; i++) {
    var c = Game.getObjectById(creepIds[i]);
    if (!c) continue;
    var maxHits = c.hitsMax || 1;
    var ratio = (c.hits || 0) / maxHits;
    if (ratio < 0.35) injured = true;
    if (ratio < 0.75) fullyHealed = false;
  }
  if (injured) return 'RETREAT';
  var previous = CombatAPI.getSquadState(flagName);
  if (previous === 'RETREAT' && !fullyHealed) {
    return 'RETREAT';
  }
  if (targetId) return 'ENGAGE';
  return 'FORM';
}

function assignRecord(flagName, creepIds) {
  // assignRecord glues the API + cache layers together. Keeping it verbose
  // may feel repetitive, but that repetition is exactly what helps a novice
  // trace data from formation → memory → callers.
  var ids = creepIds || [];
  var formation = CombatAPI.assignFormation(flagName, ids);
  var targetId = CombatAPI.focusFireTarget(flagName);
  var state = decideState(flagName, ids, targetId);
  CombatAPI.setSquadState(flagName, state);

  var rally = null;
  if (formation && formation.rallyPos) rally = formation.rallyPos;
  var leader = formation && formation.leaderId ? Game.getObjectById(formation.leaderId) : null;
  var buddy = formation && formation.buddyId ? Game.getObjectById(formation.buddyId) : null;
  var medic = formation && formation.medicId ? Game.getObjectById(formation.medicId) : null;

  var mem = Memory.squads ? Memory.squads[flagName] : null;
  if (mem) {
    // Habit: update timestamps immediately so debugging memory in the console
    // reveals whether the squad is actively ticking.
    mem.lastSeenTick = Game.time;
    mem.members = mem.members || { leader: null, buddy: null, medic: null };
    mem.members.leader = formation.leaderId || null;
    mem.members.buddy = formation.buddyId || null;
    mem.members.medic = formation.medicId || null;
    if (rally) {
      mem.rally = { x: rally.x, y: rally.y, roomName: rally.roomName };
    }
    mem.targetId = targetId || null;
    mem.state = state;
  }

  return {
    flagName: flagName,
    state: state,
    leaderId: formation.leaderId || null,
    buddyId: formation.buddyId || null,
    medicId: formation.medicId || null,
    leader: leader,
    buddy: buddy,
    medic: medic,
    rallyPos: rally,
    targetId: targetId || null,
    creepIds: ids.slice()
  };
}

function rebuildCache(store) {
  // Step 1: add every active squad based on creep memory.
  var creepsByFlag = collectCreepsByFlag();
  for (var flagName in creepsByFlag) {
    if (!creepsByFlag.hasOwnProperty(flagName)) continue;
    store[flagName] = assignRecord(flagName, creepsByFlag[flagName]);
  }

  // Step 2: ensure we still track empty squads so they can reform later.
  for (var fname in Game.flags) {
    if (!Game.flags.hasOwnProperty(fname)) continue;
    if (store[fname]) continue;
    if (fname.indexOf('Squad') !== 0) continue;
    store[fname] = assignRecord(fname, []);
  }
}

function getRecord(flagName) {
  if (!flagName) return null;
  var cache = cacheRoot();
  return cache.byFlag[flagName] || null;
}

function resolveCreep(creep) {
  var flagName = resolveFlagName(creep);
  if (!flagName) return null;
  var record = getRecord(flagName);
  if (!record) {
    record = assignRecord(flagName, []);
    var cache = cacheRoot();
    cache.byFlag[flagName] = record;
  }
  return {
    flagName: flagName,
    info: record
  };
}

function getSquadInfo(flagName) {
  return getRecord(flagName);
}

function sharedTarget(creep) {
  var ctx = resolveCreep(creep);
  if (!ctx || !ctx.info || !ctx.info.targetId) return null;
  return Game.getObjectById(ctx.info.targetId);
}

function getAnchor(creep) {
  var ctx = resolveCreep(creep);
  if (!ctx || !ctx.info) return null;
  return ctx.info.rallyPos || null;
}

/**
 * listSquadFlags exposes every tracked squad flag so BeeSpawnManager can
 * rank threats without guessing flag names.
 */
function listSquadFlags() {
  if (!Memory.squads) return [];
  var names = [];
  for (var flagName in Memory.squads) {
    if (!Object.prototype.hasOwnProperty.call(Memory.squads, flagName)) continue;
    if (flagName.indexOf('Squad') !== 0) continue;
    names.push(flagName);
  }
  return names;
}

/**
 * getLiveThreatForRoom bridges the auto-defense intel cache with live
 * visibility. When we have vision we return a fresh score + best target id;
 * otherwise we fall back to threatScoreForRoom so spawning can still react.
 */
function getLiveThreatForRoom(roomName) {
  if (!roomName) return { score: 0, hasThreat: false, bestId: null };
  var room = (typeof roomName === 'string') ? Game.rooms[roomName] : roomName;
  if (!room) {
    var cachedScore = threatScoreForRoom(roomName);
    return { score: cachedScore, hasThreat: cachedScore > 0, bestId: null };
  }
  var avoid = buildAvoidMap();
  var candidates = gatherHostileCandidates(room, avoid);
  var score = computeThreatScore(candidates);
  var anchor = room.controller ? room.controller.pos : null;
  var best = pickBestTarget(candidates, anchor);
  var total = 0;
  if (candidates.creeps) total += candidates.creeps.length;
  if (candidates.power) total += candidates.power.length;
  if (candidates.structures) total += candidates.structures.length;
  var bestId = best ? best.id : null;

  try {
    combatLog.debug(
      '[tick', Game.time, '] getLiveThreatForRoom',
      'room=', room ? room.name : String(roomName),
      'score=', score,
      'count=', total,
      'bestId=', bestId
    );
  } catch (e) {}

  return { score: score, hasThreat: total > 0, bestId: bestId };
}

var SquadFlagIntel = {
  ensureMemory: ensureSquadFlagMemory,
  resolvePlan: resolvePlan,
  resolveSquadTarget: resolveSquadTarget,
  threatScoreForRoom: threatScoreForRoom,
  ensureSquadMemoryFromFlag: ensureSquadMemoryFromFlag
};

var BeeCombatSquads = {
  resolveCreep: resolveCreep,
  getSquadInfo: getSquadInfo,
  sharedTarget: sharedTarget,
  getAnchor: getAnchor,
  ensureSquadFlags: ensureSquadFlags,
  refreshAutoDefensePlans: refreshAutoDefensePlans,
  SquadFlagIntel: SquadFlagIntel,
  listSquadFlags: listSquadFlags,
  getLiveThreatForRoom: getLiveThreatForRoom,
  getSquadState: function (flagName) { return CombatAPI.getSquadState(flagName); }
};

module.exports = BeeCombatSquads;
module.exports.CombatAPI = CombatAPI;
module.exports.ensureSquadFlags = ensureSquadFlags;
module.exports.SquadFlagIntel = SquadFlagIntel;
module.exports.refreshAutoDefensePlans = refreshAutoDefensePlans;
module.exports.listSquadFlags = listSquadFlags;
module.exports.getLiveThreatForRoom = getLiveThreatForRoom;
