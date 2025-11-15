'use strict';

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
  bucket.rally = serializePos(flag.pos);
  bucket.lastSeenTick = Game.time;
}

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
  if (sawThreat) rec.lastThreatAt = Game.time;
  mem.rooms[roomName] = rec;
}

function countHostiles(room) {
  if (!room) return { score: 0, hasThreat: false };
  var hostiles = room.find(FIND_HOSTILE_CREEPS);
  var hostileStructs = room.find(FIND_HOSTILE_STRUCTURES);
  var score = hostiles.length * 5 + hostileStructs.length * 3;
  return { score: score, hasThreat: (hostiles.length + hostileStructs.length) > 0 };
}

function sanitizeSlug(flagName) {
  if (!flagName) return 'SQUAD';
  var slug = flagName;
  if (slug.indexOf('Squad') === 0) slug = slug.substring(5);
  slug = slug.replace(/[^0-9A-Za-z]/g, '');
  if (!slug) slug = flagName.replace(/[^0-9A-Za-z]/g, '');
  if (!slug) slug = 'SQUAD';
  return slug.toUpperCase();
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
  return {
    name: flagName,
    state: extractState(flagName, bucket),
    rally: posFrom(bucket.rally || bucket.rallyPos || bucket.anchor || bucket.squadRally),
    attack: posFrom(attack),
    retreat: posFrom(bucket.retreat || bucket.retreatPos || bucket.fallback || bucket.fallbackPos),
    waypoints: normalizeWaypoints(bucket.waypoints || bucket.route || bucket.path || bucket.waypointList)
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

function ensurePrimaryFlag(plan) {
  if (!plan || !plan.rally) return null;
  if (Game.flags[plan.name]) return Game.flags[plan.name];
  var colors = FLAG_CFG.TYPES.RALLY;
  return FlagIO.ensureFlag(plan.name, plan.rally, colors.color, colors.secondary, false);
}

function buildSupportName(plan, type, index) {
  var slug = sanitizeSlug(plan.name);
  var suffix = type;
  if (index != null) suffix += '_' + index;
  return FLAG_CFG.SUPPORT_PREFIX + slug + '_' + suffix;
}

function registerFlag(flag, expected) {
  if (!flag || !flag.name || !expected) return;
  expected[flag.name] = true;
}

function ensureSupportFlag(plan, type, pos, expected, order) {
  if (!plan || !pos || !expected) return null;
  var colors = FLAG_CFG.TYPES[type];
  if (!colors) {
    if (FLAG_CFG.DEBUG) flagLogDebug('Missing color mapping for', type);
    return null;
  }
  var name = buildSupportName(plan, type, order);
  var flag = FlagIO.ensureFlag(name, pos, colors.color, colors.secondary, true);
  registerFlag(flag, expected);
  return flag;
}

function ensureSupportFlags(plan, expected) {
  if (!plan) return;
  if (plan.rally) ensureSupportFlag(plan, 'RALLY', plan.rally, expected, null);
  if (plan.attack) ensureSupportFlag(plan, 'ATTACK', plan.attack, expected, null);
  if (plan.retreat) ensureSupportFlag(plan, 'RETREAT', plan.retreat, expected, null);
  var waypoints = plan.waypoints || [];
  for (var i = 0; i < waypoints.length; i++) {
    ensureSupportFlag(plan, 'WAYPOINT', waypoints[i], expected, i + 1);
  }
}

function cleanupSupportFlags(expected) {
  for (var name in Game.flags) {
    if (!Object.prototype.hasOwnProperty.call(Game.flags, name)) continue;
    if (!isSupportFlag(name)) continue;
    if (expected && expected[name]) continue;
    var flag = Game.flags[name];
    if (flag && typeof flag.remove === 'function') flag.remove();
  }
}

function syncPlannedFlags() {
  if (!Memory.squads) return;
  var expected = {};
  for (var flagName in Memory.squads) {
    if (!Object.prototype.hasOwnProperty.call(Memory.squads, flagName)) continue;
    if (flagName.indexOf('Squad') !== 0) continue;
    var plan = resolvePlan(flagName);
    if (!plan) continue;
    if (!plan.rally && FLAG_CFG.DEBUG) flagLogDebug('No rally defined for', flagName);
    ensurePrimaryFlag(plan);
    ensureSupportFlags(plan, expected);
  }
  cleanupSupportFlags(expected);
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
  var plan = resolvedName ? resolvePlan(resolvedName) : null;
  return {
    flag: flag,
    flagName: resolvedName,
    targetRoom: targetRoom,
    plan: plan,
    mem: intel
  };
}

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

function ensureSquadFlags() {
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
    var currentState = CombatAPI.getSquadState(name);
    var nextState = currentState;
    if (currentState !== 'RETREAT') {
      nextState = threat.hasThreat ? 'ENGAGE' : 'FORM';
      if (room) {
        var targetId = CombatAPI.getAttackTarget(room, {});
        if (!targetId && !threat.hasThreat) nextState = 'FORM';
        if (targetId) nextState = 'ENGAGE';
      }
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

function buildAvoidMap(extra) {
  // Defensive copy: we build a brand-new lookup each tick so we never mutate
  // caller-owned data.
  var avoid = {};
  var allies = CoreConfig.ALLY_USERNAMES || [];
  for (var i = 0; i < allies.length; i++) {
    avoid[lowerUsername(allies[i])] = true;
  }
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
  // for a tick. Always stamp the tick number so the cache expires naturally.
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

function resolveRoomForSquad(flagName, formation, currentObj, bucket) {
  // Always try the cheapest data source first (flag cache) before falling
  // back to heavier Game lookups.
  var flag = Game.flags && Game.flags[flagName] ? Game.flags[flagName] : null;
  if (flag && flag.room) return flag.room;
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
function getSquadState(flagName) {
  var bucket = ensureSquadMemory(flagName);
  return bucket ? bucket.state : 'INIT';
}

function setSquadState(flagName, state) {
  if (!VALID_STATES[state]) return;
  var bucket = ensureSquadMemory(flagName);
  if (!bucket) return;
  var previous = bucket.state;
  if (previous !== state && console && console.log) {
    try {
      console.log('[Squad]', flagName, 'state', previous || 'INIT', '→', state);
    } catch (e) {
      // ignore logging errors in production
    }
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

  var best = null;
  var bestScore = -1000000;

  var hostiles = room.find(FIND_HOSTILE_CREEPS, {
    filter: function (creep) {
      if (!creep || !creep.owner) return false;
      return !isAlly(creep.owner, avoid);
    }
  });

  for (var i = 0; i < hostiles.length; i++) {
    var c = hostiles[i];
    var score = scoreCreep(c, anchorPos);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  var hostileStructs = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function (s) {
      if (!s) return false;
      if (!s.owner || !s.owner.username) return true;
      return !isAlly(s.owner, avoid);
    }
  });

  for (var j = 0; j < hostileStructs.length; j++) {
    var s = hostileStructs[j];
    var score2 = scoreStructure(s, anchorPos);
    if (score2 > bestScore) {
      bestScore = score2;
      best = s;
    }
  }

  return best ? best.id : null;
}

function focusFireTarget(flagName) {
  // Focus fire is called from many roles, so we aggressively cache the result
  // per flag to keep CPU usage predictable.
  if (!flagName) return null;
  var cache = currentFocusCache();
  if (cache.focus.hasOwnProperty(flagName)) {
    return cache.focus[flagName];
  }

  var bucket = ensureSquadMemory(flagName);
  var currentId = bucket && bucket.targetId ? bucket.targetId : null;
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

function decideState(flagName, creepIds, targetId) {
  // This tiny state machine is intentionally conservative. Retreat as soon as
  // anyone dips below 35% health so squads survive to fight another day.
  if (!creepIds || !creepIds.length) return 'INIT';
  for (var i = 0; i < creepIds.length; i++) {
    var c = Game.getObjectById(creepIds[i]);
    if (!c) continue;
    if (c.hits < (c.hitsMax || 1) * 0.35) return 'RETREAT';
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
  SquadFlagIntel: SquadFlagIntel,
  getSquadState: function (flagName) { return CombatAPI.getSquadState(flagName); }
};

module.exports = BeeCombatSquads;
module.exports.CombatAPI = CombatAPI;
module.exports.ensureSquadFlags = ensureSquadFlags;
module.exports.SquadFlagIntel = SquadFlagIntel;
