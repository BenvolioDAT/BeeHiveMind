'use strict';

/**
 * BeeCombatSquads owns the combat squad state machine and exports a CombatAPI
 * helper bundle (INIT → FORM → ENGAGE → RETREAT). Roles consume
 * BeeCombatSquads.CombatAPI to resolve shared formation, targets, and state
 * while this module continues to surface convenience lookups for legacy
 * callers.
 */

var CoreConfig = require('core.config');

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
  return { x: pos.x, y: pos.y, roomName: pos.roomName };
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

function resolveRoomForSquad(flagName, formation, currentObj) {
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
  var room = resolveRoomForSquad(flagName, formation, currentObj);
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

var BeeCombatSquads = {
  resolveCreep: resolveCreep,
  getSquadInfo: getSquadInfo,
  sharedTarget: sharedTarget,
  getAnchor: getAnchor,
  getSquadState: function (flagName) { return CombatAPI.getSquadState(flagName); }
};

module.exports = BeeCombatSquads;
module.exports.CombatAPI = CombatAPI;
