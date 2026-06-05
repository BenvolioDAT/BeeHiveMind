'use strict';

// BeeCombatIntel.js - shared combat target scoring and primary-player intel.
// This module is intentionally ES5-only and CPU-conscious:
// * Room scans are cached in Memory and only refreshed on a cadence.
// * Target scoring works from already-found objects whenever callers have them.
// * Squad target memory is sticky so combat creeps focus fire instead of
//   changing targets every tick.

var CoreConfig = require('core.config');

var DEFAULT_COMBAT_PLAYER_CONFIG = {
  primaryHostileUsername: 'giaco',
  aggressiveMode: true,
  debugCombatTargets: false,
  stickyTargetTicks: 7,
  primarySwitchScoreBonus: 2500,
  combatIntelScanInterval: 10,
  combatIntelTtl: 5000,
  maxAttackRoomDistance: 3
};

var DEFAULT_COMBAT_SPAWN_CONFIG = {
  enableGiacoResponse: true,
  minEnergyStorageForAttackSquad: 50000,
  minRclForAttackSquad: 4,
  maxCombatSquads: 1,
  defensiveMeleeTarget: 1,
  defensiveArcherTarget: 2,
  defensiveMedicTarget: 1,
  attackSquadMeleeTarget: 1,
  attackSquadArcherTarget: 2,
  attackSquadMedicTarget: 1
};

function settingsCombat() {
  return CoreConfig && CoreConfig.settings && CoreConfig.settings.combat
    ? CoreConfig.settings.combat
    : {};
}

function copyDefaults(defaults, overrides) {
  var out = {};
  var key;
  for (key in defaults) {
    if (Object.prototype.hasOwnProperty.call(defaults, key)) out[key] = defaults[key];
  }
  overrides = overrides || {};
  for (key in overrides) {
    if (Object.prototype.hasOwnProperty.call(overrides, key) && overrides[key] !== undefined) {
      out[key] = overrides[key];
    }
  }
  return out;
}

function configNumber(value, fallback) {
  if (typeof value === 'number' && !isNaN(value)) return value;
  return fallback;
}

function getPlayerConfig() {
  var combat = settingsCombat();
  return copyDefaults(DEFAULT_COMBAT_PLAYER_CONFIG, combat.COMBAT_PLAYER_CONFIG || combat.combatPlayer || {});
}

function getSpawnConfig() {
  var combat = settingsCombat();
  return copyDefaults(DEFAULT_COMBAT_SPAWN_CONFIG, combat.COMBAT_SPAWN_CONFIG || combat.combatSpawn || {});
}

function lowerUsername(name) {
  if (!name) return '';
  return String(name).toLowerCase();
}

function primaryUsernameLower() {
  return lowerUsername(getPlayerConfig().primaryHostileUsername || 'giaco');
}

function isPrimaryHostileUsername(name) {
  return !!name && lowerUsername(name) === primaryUsernameLower();
}

function getOwnerUsername(obj) {
  if (!obj) return null;
  if (obj.owner && obj.owner.username) return obj.owner.username;
  if (obj.reservation && obj.reservation.username) return obj.reservation.username;
  if (obj.controller) {
    if (obj.controller.owner && obj.controller.owner.username) return obj.controller.owner.username;
    if (obj.controller.reservation && obj.controller.reservation.username) return obj.controller.reservation.username;
  }
  return null;
}

function isNpcUsername(name) {
  var key = lowerUsername(name);
  return key === 'invader' || key === 'source keeper';
}

function isPrimaryHostileCreep(creep) {
  return !!(creep && creep.owner && isPrimaryHostileUsername(creep.owner.username));
}

function isPrimaryHostileStructure(structure) {
  return !!(structure && structure.owner && isPrimaryHostileUsername(structure.owner.username));
}

function isPrimaryHostileController(controller) {
  if (!controller) return false;
  if (controller.owner && isPrimaryHostileUsername(controller.owner.username)) return true;
  if (controller.reservation && isPrimaryHostileUsername(controller.reservation.username)) return true;
  return false;
}

function isPrimaryHostileRoom(room) {
  return !!(room && room.controller && isPrimaryHostileController(room.controller));
}

function isAllyUsername(name) {
  if (!name) return false;
  var allies = CoreConfig && CoreConfig.ALLY_USERNAMES ? CoreConfig.ALLY_USERNAMES : [];
  var key = lowerUsername(name);
  for (var i = 0; i < allies.length; i++) {
    if (lowerUsername(allies[i]) === key) return true;
  }
  return false;
}

function shouldAvoidOwner(name, avoidMap) {
  if (!name) return false;
  var key = lowerUsername(name);
  if (avoidMap && avoidMap[key]) return true;
  if (isAllyUsername(name)) return true;
  return false;
}

function countActiveParts(target, partType) {
  if (!target || typeof target.getActiveBodyparts !== 'function') return 0;
  return target.getActiveBodyparts(partType) || 0;
}

function cacheRoot() {
  if (!global.__beeCombatIntelCache || global.__beeCombatIntelCache.tick !== Game.time) {
    global.__beeCombatIntelCache = { tick: Game.time, rooms: {} };
  }
  return global.__beeCombatIntelCache;
}

function getImportantPositions(room) {
  if (!room || !room.name) return [];
  var root = cacheRoot();
  if (root.rooms[room.name] && root.rooms[room.name].importantPositions) {
    return root.rooms[room.name].importantPositions;
  }
  if (!root.rooms[room.name]) root.rooms[room.name] = {};

  var out = [];
  if (room.controller) out.push(room.controller.pos);
  if (room.storage) out.push(room.storage.pos);
  if (room.terminal) out.push(room.terminal.pos);

  var structures = room.find(FIND_MY_STRUCTURES, {
    filter: function (s) {
      return s.structureType === STRUCTURE_SPAWN ||
        s.structureType === STRUCTURE_TOWER ||
        s.structureType === STRUCTURE_RAMPART;
    }
  }) || [];
  for (var i = 0; i < structures.length; i++) {
    if (structures[i] && structures[i].pos) out.push(structures[i].pos);
  }
  root.rooms[room.name].importantPositions = out;
  return out;
}

function isNearImportantFriendlyPosition(target, range) {
  if (!target || !target.pos || !target.room) return false;
  var positions = getImportantPositions(target.room);
  var maxRange = typeof range === 'number' ? range : 3;
  for (var i = 0; i < positions.length; i++) {
    if (positions[i] && positions[i].roomName === target.pos.roomName &&
        positions[i].getRangeTo(target.pos) <= maxRange) {
      return true;
    }
  }
  return false;
}

function getHostileRampartAt(pos) {
  if (!pos || !Game.rooms || !Game.rooms[pos.roomName]) return null;
  var room = Game.rooms[pos.roomName];
  var structures = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y) || [];
  for (var i = 0; i < structures.length; i++) {
    var st = structures[i];
    if (!st || st.structureType !== STRUCTURE_RAMPART) continue;
    if (st.my) continue;
    return st;
  }
  return null;
}

function getAttackableTargetForCreep(creep, target) {
  if (!creep || !target || !target.pos) return target || null;
  var rampart = getHostileRampartAt(target.pos);
  if (rampart && target.id !== rampart.id) return rampart;
  return target;
}

function ownerBaseScore(target) {
  var username = getOwnerUsername(target);
  if (isPrimaryHostileUsername(username)) return 20000;
  if (username && !isNpcUsername(username)) return 5000;
  if (username && isNpcUsername(username)) return 1000;
  if (target && target.structureType === STRUCTURE_INVADER_CORE) return 1000;
  return 0;
}

function distancePenalty(anchorPos, target) {
  if (!anchorPos || !target || !target.pos) return 0;
  if (anchorPos.roomName !== target.pos.roomName) return 250;
  return anchorPos.getRangeTo(target.pos) * 12;
}

function scoreCreepTarget(actor, target, opts) {
  var score = ownerBaseScore(target);
  var heal = countActiveParts(target, HEAL);
  var ranged = countActiveParts(target, RANGED_ATTACK);
  var attack = countActiveParts(target, ATTACK);
  var work = countActiveParts(target, WORK);
  var tough = countActiveParts(target, TOUGH);
  var primary = isPrimaryHostileCreep(target);

  if (heal > 0) score += primary ? 15000 : 4000;
  else if (ranged > 0 || attack > 0) score += primary ? 12000 : 3500;
  else if (work > 0) score += primary ? 6500 : 1500;
  else score += primary ? 4000 : 500;

  score += heal * 700;
  score += ranged * 350;
  score += attack * 300;
  score += work * 120;
  score -= tough * 30;

  if (work > 0 && isNearImportantFriendlyPosition(target, 3)) score += primary ? 3000 : 1200;
  if (target.hitsMax && target.hits != null) {
    score += Math.min(1200, Math.max(0, target.hitsMax - target.hits));
  }
  if (getHostileRampartAt(target.pos)) score -= 250;
  score -= distancePenalty(opts && opts.anchorPos, target);
  return score;
}

function scorePowerCreepTarget(actor, target, opts) {
  var score = ownerBaseScore(target) + 2500;
  if (target && target.powers) score += Object.keys(target.powers).length * 250;
  if (target && target.hitsMax && target.hits != null) {
    score += Math.min(1000, Math.max(0, target.hitsMax - target.hits));
  }
  score -= distancePenalty(opts && opts.anchorPos, target);
  return score;
}

function structureTypeScore(structure) {
  if (!structure) return 0;
  var type = structure.structureType;
  if (type === STRUCTURE_TOWER) return 3500;
  if (type === STRUCTURE_SPAWN) return 3000;
  if (type === STRUCTURE_EXTENSION) return 2500;
  if (type === STRUCTURE_STORAGE || type === STRUCTURE_TERMINAL) return 2200;
  if (type === STRUCTURE_RAMPART || type === STRUCTURE_WALL) return 1200;
  if (type === STRUCTURE_INVADER_CORE) return 3200;
  if (type === STRUCTURE_ROAD || type === STRUCTURE_CONTAINER) return 200;
  return 1000;
}

function scoreStructureTarget(actor, target, opts) {
  var score = ownerBaseScore(target) + structureTypeScore(target);
  if (target && target.hitsMax && target.hits != null) {
    score += Math.min(1500, Math.max(0, target.hitsMax - target.hits));
  }
  score -= distancePenalty(opts && opts.anchorPos, target);
  return score;
}

function getCombatTargetScore(actor, target, opts) {
  opts = opts || {};
  if (!target || !target.pos) return -1000000;
  var username = getOwnerUsername(target);
  if (shouldAvoidOwner(username, opts.avoidMap)) return -1000000;
  if (target.my) return -1000000;
  if (target.getActiveBodyparts) return scoreCreepTarget(actor, target, opts);
  if (target.powers) return scorePowerCreepTarget(actor, target, opts);
  if (target.structureType) return scoreStructureTarget(actor, target, opts);
  return -1000000;
}

function pickBestTarget(actor, targets, opts) {
  if (!targets || !targets.length) return null;
  opts = opts || {};
  if (!opts.anchorPos && actor && actor.pos) opts.anchorPos = actor.pos;
  var best = null;
  var bestScore = -1000000;
  for (var i = 0; i < targets.length; i++) {
    var target = targets[i];
    var score = getCombatTargetScore(actor, target, opts);
    if (score > bestScore) {
      bestScore = score;
      best = target;
    }
  }
  if (!best) return null;
  return { target: best, score: bestScore };
}

function pickBestTargetFromCandidates(actor, candidates, opts) {
  var all = [];
  var i;
  if (candidates && candidates.creeps) {
    for (i = 0; i < candidates.creeps.length; i++) all.push(candidates.creeps[i]);
  }
  if (candidates && candidates.power) {
    for (i = 0; i < candidates.power.length; i++) all.push(candidates.power[i]);
  }
  if (candidates && candidates.structures) {
    for (i = 0; i < candidates.structures.length; i++) all.push(candidates.structures[i]);
  }
  return pickBestTarget(actor, all, opts);
}

function getCandidateThreatScore(candidates, anchorPos) {
  var best = pickBestTargetFromCandidates(null, candidates, { anchorPos: anchorPos });
  var count = 0;
  if (candidates && candidates.creeps) count += candidates.creeps.length;
  if (candidates && candidates.power) count += candidates.power.length;
  if (candidates && candidates.structures) count += candidates.structures.length;
  if (!best) return count;
  return count + Math.max(0, Math.floor(best.score / 1000));
}

function collectHostileTargets(room, opts) {
  opts = opts || {};
  var out = [];
  if (!room || typeof room.find !== 'function') return out;
  var creeps = room.find(FIND_HOSTILE_CREEPS) || [];
  for (var i = 0; i < creeps.length; i++) {
    if (getCombatTargetScore(null, creeps[i], opts) > -1000000) out.push(creeps[i]);
  }
  if (opts.includeStructures !== false) {
    var structures = room.find(FIND_HOSTILE_STRUCTURES) || [];
    for (var j = 0; j < structures.length; j++) {
      if (getCombatTargetScore(null, structures[j], opts) > -1000000) out.push(structures[j]);
    }
  }
  return out;
}

function ensureRootMemory() {
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.combat) Memory.__BHM.combat = {};
  if (!Memory.__BHM.combat.primaryHostileRooms) Memory.__BHM.combat.primaryHostileRooms = {};
  return Memory.__BHM.combat;
}

function ensureRoomMemory(roomName) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  return Memory.rooms[roomName];
}

function scanRoomCombatIntel(room, opts) {
  opts = opts || {};
  if (!room || !room.name) return null;
  var cfg = getPlayerConfig();
  var roomMem = ensureRoomMemory(room.name);
  var previous = roomMem.combatIntel || null;
  var interval = Math.max(1, Number(configNumber(cfg.combatIntelScanInterval, 10)));
  if (!opts.force && previous && previous.primaryHostilePresent !== true &&
      previous.lastScanned && (Game.time - previous.lastScanned) < interval) {
    return previous;
  }

  var hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
  var hostileStructures = room.find(FIND_HOSTILE_STRUCTURES) || [];
  var combatParts = 0;
  var healParts = 0;
  var primaryPresent = isPrimaryHostileRoom(room);
  var primaryScore = 0;
  var best = null;
  var i;

  for (i = 0; i < hostiles.length; i++) {
    combatParts += countActiveParts(hostiles[i], ATTACK);
    combatParts += countActiveParts(hostiles[i], RANGED_ATTACK);
    healParts += countActiveParts(hostiles[i], HEAL);
    if (isPrimaryHostileCreep(hostiles[i])) primaryPresent = true;
  }
  for (i = 0; i < hostileStructures.length; i++) {
    if (isPrimaryHostileStructure(hostileStructures[i])) primaryPresent = true;
  }

  var candidates = {
    creeps: hostiles,
    power: [],
    structures: hostileStructures
  };
  best = pickBestTargetFromCandidates(null, candidates, {
    anchorPos: room.controller ? room.controller.pos : new RoomPosition(25, 25, room.name)
  });
  primaryScore = best ? best.score : 0;

  var hostileTowerCount = 0;
  var hostileSpawnCount = 0;
  for (i = 0; i < hostileStructures.length; i++) {
    if (hostileStructures[i].structureType === STRUCTURE_TOWER) hostileTowerCount++;
    if (hostileStructures[i].structureType === STRUCTURE_SPAWN) hostileSpawnCount++;
  }

  var intel = {
    primaryHostilePresent: primaryPresent,
    primaryHostileUsername: cfg.primaryHostileUsername || 'giaco',
    hostileCreepCount: hostiles.length,
    hostileCombatParts: combatParts,
    hostileHealParts: healParts,
    hostileTowerCount: hostileTowerCount,
    hostileSpawnCount: hostileSpawnCount,
    primaryHostileRoom: isPrimaryHostileRoom(room),
    controllerOwner: room.controller && room.controller.owner ? room.controller.owner.username : null,
    controllerReservation: room.controller && room.controller.reservation ? room.controller.reservation.username : null,
    bestTargetId: best && best.target ? best.target.id : null,
    bestTargetScore: primaryScore,
    lastScanned: Game.time
  };
  roomMem.combatIntel = intel;

  if (primaryPresent) {
    var root = ensureRootMemory();
    root.primaryHostileRooms[room.name] = {
      roomName: room.name,
      lastSeen: Game.time,
      primaryHostilePresent: primaryPresent,
      primaryHostileRoom: intel.primaryHostileRoom,
      controllerOwner: intel.controllerOwner,
      controllerReservation: intel.controllerReservation,
      hostileCreepCount: hostiles.length,
      hostileCombatParts: combatParts,
      hostileHealParts: healParts,
      hostileTowerCount: hostileTowerCount,
      hostileSpawnCount: hostileSpawnCount,
      bestTargetScore: primaryScore
    };
  }

  return intel;
}

function scanVisibleRooms(opts) {
  var out = {};
  for (var roomName in Game.rooms) {
    if (!Object.prototype.hasOwnProperty.call(Game.rooms, roomName)) continue;
    var intel = scanRoomCombatIntel(Game.rooms[roomName], opts);
    if (intel) out[roomName] = intel;
  }
  cleanupStaleCombatIntel();
  return out;
}

function cleanupStaleCombatIntel() {
  var root = ensureRootMemory();
  var cfg = getPlayerConfig();
  var ttl = Math.max(100, Number(configNumber(cfg.combatIntelTtl, 5000)));
  var rooms = root.primaryHostileRooms || {};
  for (var roomName in rooms) {
    if (!Object.prototype.hasOwnProperty.call(rooms, roomName)) continue;
    if ((Game.time - (rooms[roomName].lastSeen || 0)) > ttl) delete rooms[roomName];
  }
}

function getRoomCombatIntel(roomName) {
  return Memory.rooms && Memory.rooms[roomName] ? Memory.rooms[roomName].combatIntel : null;
}

function hasPrimaryHostileInRoom(roomName) {
  var intel = getRoomCombatIntel(roomName);
  return !!(intel && intel.primaryHostilePresent);
}

function pickPrimaryHostileTargetRoom(homeRoomName) {
  var root = ensureRootMemory();
  var rooms = root.primaryHostileRooms || {};
  var cfg = getPlayerConfig();
  var maxDistance = Math.max(1, Number(configNumber(cfg.maxAttackRoomDistance, 3)));
  var best = null;
  var bestScore = -1000000;
  for (var roomName in rooms) {
    if (!Object.prototype.hasOwnProperty.call(rooms, roomName)) continue;
    var rec = rooms[roomName];
    if (!rec || !rec.roomName) continue;
    var distance = 0;
    if (homeRoomName && Game.map && typeof Game.map.getRoomLinearDistance === 'function') {
      distance = Game.map.getRoomLinearDistance(homeRoomName, rec.roomName, true);
      if (typeof distance === 'number' && distance > maxDistance) continue;
    }
    var score = rec.bestTargetScore || 0;
    if (rec.primaryHostileRoom) score += 5000;
    if (isPrimaryHostileUsername(rec.controllerReservation)) score += 3000;
    if (rec.hostileTowerCount <= 0) score += 1200;
    score += Math.max(0, 1000 - (Game.time - (rec.lastSeen || 0)));
    score -= distance * 250;
    if (score > bestScore) {
      bestScore = score;
      best = {
        roomName: rec.roomName,
        score: score,
        distance: distance,
        intel: rec
      };
    }
  }
  return best;
}

function ensureSquadCombatMemory(flagName) {
  if (!flagName) return null;
  if (!Memory.squads) Memory.squads = {};
  if (!Memory.squads[flagName]) Memory.squads[flagName] = {};
  var bucket = Memory.squads[flagName];
  if (!bucket.combat) {
    bucket.combat = {
      targetId: null,
      targetRoom: null,
      targetUsername: null,
      targetScore: 0,
      lastTargetTick: 0
    };
  }
  return bucket.combat;
}

function updateSquadCombatTarget(flagName, room, anchorPos, candidates, opts) {
  opts = opts || {};
  var combat = ensureSquadCombatMemory(flagName);
  if (!combat) return { targetId: null, target: null, score: 0 };
  var current = combat.targetId ? Game.getObjectById(combat.targetId) : null;
  var currentScore = current ? getCombatTargetScore(null, current, { anchorPos: anchorPos, avoidMap: opts.avoidMap }) : -1000000;
  var best = pickBestTargetFromCandidates(null, candidates, { anchorPos: anchorPos, avoidMap: opts.avoidMap });
  var bestTarget = best ? best.target : null;
  var bestScore = best ? best.score : -1000000;
  var cfg = getPlayerConfig();
  var stickyTicks = Math.max(1, Number(configNumber(cfg.stickyTargetTicks, 7)));
  var switchBonus = Math.max(0, Number(configNumber(cfg.primarySwitchScoreBonus, 2500)));
  var target = bestTarget;
  var score = bestScore;
  var age = Game.time - (combat.lastTargetTick || 0);

  if (current && currentScore > -1000000) {
    target = current;
    score = currentScore;
    if (bestTarget && bestTarget.id !== current.id) {
      var bestIsPrimary = isPrimaryHostileUsername(getOwnerUsername(bestTarget));
      var currentIsPrimary = isPrimaryHostileUsername(getOwnerUsername(current));
      var muchBetter = bestScore > (currentScore + switchBonus);
      if (age >= stickyTicks || (bestIsPrimary && (!currentIsPrimary || muchBetter))) {
        target = bestTarget;
        score = bestScore;
      }
    }
  }

  if (!target || score <= -1000000) {
    combat.targetId = null;
    combat.targetRoom = null;
    combat.targetUsername = null;
    combat.targetScore = 0;
    combat.lastTargetTick = Game.time;
    return { targetId: null, target: null, score: 0 };
  }

  combat.targetId = target.id || null;
  combat.targetRoom = target.pos ? target.pos.roomName : (room ? room.name : null);
  combat.targetUsername = getOwnerUsername(target);
  combat.targetScore = score;
  combat.lastTargetTick = Game.time;
  return { targetId: combat.targetId, target: target, score: score };
}

function drawTargetDebug(creep, target, score, label) {
  var cfg = getPlayerConfig();
  if (!cfg.debugCombatTargets || !creep || !target || !creep.room || !creep.room.visual) return;
  if (!target.pos || target.pos.roomName !== creep.pos.roomName) return;
  var text = label || (isPrimaryHostileUsername(getOwnerUsername(target)) ? 'PRIMARY HOSTILE' : 'TARGET');
  creep.room.visual.line(creep.pos, target.pos, { color: '#ff3333', width: 0.12, opacity: 0.55 });
  creep.room.visual.text(text, target.pos.x, target.pos.y - 0.8, {
    color: '#ff5555',
    font: 0.5,
    opacity: 0.9,
    align: 'center'
  });
  if (typeof score === 'number') {
    creep.room.visual.text(String(Math.floor(score)), target.pos.x, target.pos.y - 1.25, {
      color: '#ffffff',
      font: 0.45,
      opacity: 0.85,
      align: 'center'
    });
  }
}

module.exports = {
  COMBAT_PLAYER_CONFIG: DEFAULT_COMBAT_PLAYER_CONFIG,
  COMBAT_SPAWN_CONFIG: DEFAULT_COMBAT_SPAWN_CONFIG,
  getPlayerConfig: getPlayerConfig,
  getSpawnConfig: getSpawnConfig,
  isPrimaryHostileUsername: isPrimaryHostileUsername,
  isPrimaryHostileCreep: isPrimaryHostileCreep,
  isPrimaryHostileStructure: isPrimaryHostileStructure,
  isPrimaryHostileController: isPrimaryHostileController,
  isPrimaryHostileRoom: isPrimaryHostileRoom,
  getOwnerUsername: getOwnerUsername,
  countActiveParts: countActiveParts,
  getCombatTargetScore: getCombatTargetScore,
  pickBestTarget: pickBestTarget,
  pickBestTargetFromCandidates: pickBestTargetFromCandidates,
  getCandidateThreatScore: getCandidateThreatScore,
  collectHostileTargets: collectHostileTargets,
  getAttackableTargetForCreep: getAttackableTargetForCreep,
  getHostileRampartAt: getHostileRampartAt,
  scanRoomCombatIntel: scanRoomCombatIntel,
  scanVisibleRooms: scanVisibleRooms,
  getRoomCombatIntel: getRoomCombatIntel,
  hasPrimaryHostileInRoom: hasPrimaryHostileInRoom,
  pickPrimaryHostileTargetRoom: pickPrimaryHostileTargetRoom,
  ensureSquadCombatMemory: ensureSquadCombatMemory,
  updateSquadCombatTarget: updateSquadCombatTarget,
  drawTargetDebug: drawTargetDebug
};
