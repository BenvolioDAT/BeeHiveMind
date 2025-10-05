'use strict';

/**
 * Combat.ThreatAnalyzer.es5.js
 * -----------------------------------------------
 * Provides cached threat intelligence for combat squads:
 *  - Tower DPS projections (per Screeps tower formula; see StructureTower::attack docs)
 *  - Hostile categorization with healer/ranged/melee priority
 *  - Fortress awareness (rampart cover, static defenses)
 *  - Intent-aware helpers used by the squad controller + micro tasks
 *
 * ES5 ONLY: no const/let/arrow/template usage.
 */

var Traveler; try { Traveler = require('Traveler'); } catch (err) { Traveler = null; }

var CACHE_TTL = 25;            // ticks to keep intel fresh when we have vision
var NO_VISION_TTL = 200;       // memory retention without vision (avoids frequent wipes)
var HOSTILE_CACHE_TTL = 5;     // re-scan hostiles more aggressively while in combat
var SAFE_MARGIN = 0.10;        // fudge factor for tower DPS (stay conservative)

var THREAT_WEIGHTS = {
  healer:  600,
  ranged:  320,
  melee:   180,
  dismantler: 140,
  worker:  40,
  tower:   500,
  spawn:   280,
  rampart: 120,
  wall:    80,
  controller: 200,
};

var STRUCTURE_PRI = {
  'tower': THREAT_WEIGHTS.tower,
  'spawn': THREAT_WEIGHTS.spawn,
  'extension': 60,
  'link': 40,
  'lab': 75,
  'terminal': 90,
  'storage': 90,
  'rampart': THREAT_WEIGHTS.rampart,
  'wall': THREAT_WEIGHTS.wall,
  'controller': THREAT_WEIGHTS.controller,
};

// Lightweight global cache (resets on global reset)
if (!global.__combatIntel) {
  global.__combatIntel = { tick: 0, rooms: {} };
}

function _mem() {
  if (!Memory.combatIntel) Memory.combatIntel = { rooms: {} };
  if (!Memory.combatIntel.rooms) Memory.combatIntel.rooms = {};
  return Memory.combatIntel.rooms;
}

function _globalBucket(roomName) {
  var bucket = global.__combatIntel.rooms[roomName];
  if (!bucket) {
    bucket = { tick: 0, data: null };
    global.__combatIntel.rooms[roomName] = bucket;
  }
  return bucket;
}

function _packPos(pos) {
  if (!pos) return null;
  return { x: pos.x, y: pos.y, roomName: pos.roomName };
}

function _unpackPos(obj) {
  if (!obj) return null;
  return new RoomPosition(obj.x, obj.y, obj.roomName);
}

function _towerDamageAtRange(range) {
  // Screeps docs: StructureTower::attack uses 600 dmg up to range 5, linearly
  // dropping to 150 dmg at range 20. Beyond 20 stays 150.
  if (range <= 5) return 600;
  if (range >= 20) return 150;
  return Math.max(150, 600 - ((range - 5) * 30));
}

function _analyzeTowers(room) {
  var result = [];
  var towers = [];
  if (!room) return result;
  towers = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function (s) { return s.structureType === STRUCTURE_TOWER; }
  });
  for (var i = 0; i < towers.length; i++) {
    var t = towers[i];
    result.push({ id: t.id, pos: _packPos(t.pos), energy: t.energy || 0, hits: t.hits, active: t.isActive ? t.isActive() : true });
  }
  return result;
}

function _categorizeHostiles(room) {
  var out = [];
  if (!room) return out;
  var hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
  for (var i = 0; i < hostiles.length; i++) {
    var h = hostiles[i];
    var parts = h.body || [];
    var counts = { heal: 0, ranged: 0, attack: 0, work: 0, tough: 0 };
    for (var j = 0; j < parts.length; j++) {
      var p = parts[j];
      if (!p || p.hits <= 0) continue;
      if (p.type === HEAL) counts.heal++;
      else if (p.type === RANGED_ATTACK) counts.ranged++;
      else if (p.type === ATTACK) counts.attack++;
      else if (p.type === WORK) counts.work++;
      else if (p.type === TOUGH) counts.tough++;
    }
    var role = 'worker';
    if (counts.heal > 0) role = 'healer';
    else if (counts.ranged > 0) role = 'ranged';
    else if (counts.attack > 0) role = 'melee';
    else if (counts.work >= 3) role = 'dismantler';

    out.push({
      id: h.id,
      pos: _packPos(h.pos),
      role: role,
      owner: h.owner && h.owner.username,
      hits: h.hits,
      hitsMax: h.hitsMax,
      counts: counts,
      tough: counts.tough,
      creep: h,
    });
  }
  return out;
}

function _staticStructures(room) {
  var out = [];
  if (!room) return out;
  var structs = room.find(FIND_HOSTILE_STRUCTURES) || [];
  for (var i = 0; i < structs.length; i++) {
    var s = structs[i];
    var key = STRUCTURE_PRI[s.structureType];
    if (!key) continue;
    out.push({ id: s.id, pos: _packPos(s.pos), type: s.structureType, priority: key, hits: s.hits, hitsMax: s.hitsMax });
  }
  return out;
}

function _ramparts(room) {
  var out = [];
  if (!room) return out;
  var ramps = room.find(FIND_STRUCTURES, {
    filter: function (s) { return s.structureType === STRUCTURE_RAMPART && !s.my; }
  });
  for (var i = 0; i < ramps.length; i++) {
    out.push(_packPos(ramps[i].pos));
  }
  return out;
}

function _walls(room) {
  var out = [];
  if (!room) return out;
  var walls = room.find(FIND_STRUCTURES, {
    filter: function (s) { return s.structureType === STRUCTURE_WALL; }
  });
  for (var i = 0; i < walls.length; i++) {
    out.push(_packPos(walls[i].pos));
  }
  return out;
}

function _storeIntel(roomName, data, hasVision) {
  var memRooms = _mem();
  var bucket = memRooms[roomName];
  if (!bucket) bucket = (memRooms[roomName] = {});
  bucket.tick = Game.time;
  bucket.noVisionExpires = hasVision ? Game.time + NO_VISION_TTL : (bucket.noVisionExpires || 0);
  bucket.data = data;

  var g = _globalBucket(roomName);
  g.tick = Game.time;
  g.data = data;
}

function _needsRefresh(bucket, ttl) {
  if (!bucket || !bucket.data) return true;
  var tick = bucket.tick | 0;
  return (Game.time - tick) > ttl;
}

function getIntel(roomName) {
  if (!roomName) return null;
  var g = _globalBucket(roomName);
  if (!_needsRefresh(g, CACHE_TTL)) return g.data;

  var memRooms = _mem();
  var memBucket = memRooms[roomName];
  if (memBucket && memBucket.data && (Game.time - (memBucket.tick | 0)) <= CACHE_TTL) {
    g.tick = memBucket.tick;
    g.data = memBucket.data;
    return g.data;
  }

  var room = Game.rooms[roomName];
  if (!room) {
    if (memBucket && memBucket.data && Game.time <= (memBucket.noVisionExpires || 0)) {
      g.tick = memBucket.tick;
      g.data = memBucket.data;
      return g.data;
    }
    return null;
  }

  var intel = {
    roomName: roomName,
    analyzedAt: Game.time,
    towers: _analyzeTowers(room),
    hostiles: _categorizeHostiles(room),
    structures: _staticStructures(room),
    ramparts: _ramparts(room),
    walls: _walls(room),
    controllerOwned: (room.controller && room.controller.owner && !room.controller.my) ? true : false,
  };

  _storeIntel(roomName, intel, true);
  return intel;
}

function _posKey(pos) {
  if (!pos) return 'unknown';
  return pos.x + ':' + pos.y + ':' + pos.roomName;
}

function _hasHostileCover(intel, pos) {
  if (!intel || !pos) return false;
  var key = _posKey(pos);
  if (intel._coverCache && intel._coverCache[key] != null) return intel._coverCache[key];
  if (!intel._coverCache) intel._coverCache = {};
  var covered = false;
  var i;
  for (i = 0; i < (intel.ramparts || []).length; i++) {
    var rp = intel.ramparts[i];
    if (rp.x === pos.x && rp.y === pos.y && rp.roomName === pos.roomName) {
      covered = true;
      break;
    }
  }
  if (!covered) {
    for (i = 0; i < (intel.walls || []).length; i++) {
      var w = intel.walls[i];
      if (w.x === pos.x && w.y === pos.y && w.roomName === pos.roomName) {
        covered = true;
        break;
      }
    }
  }
  intel._coverCache[key] = covered;
  return covered;
}

function estimateTowerDps(roomName, pos) {
  if (!roomName || !pos) return 0;
  var intel = getIntel(roomName);
  if (!intel || !intel.towers || intel.towers.length === 0) return 0;

  var position = pos.pos ? pos.pos : pos;
  var dmg = 0;
  for (var i = 0; i < intel.towers.length; i++) {
    var tw = intel.towers[i];
    if (!tw.pos) continue;
    var towerPos = _unpackPos(tw.pos);
    if (!towerPos) continue;
    var range = towerPos.getRangeTo(position);
    var base = _towerDamageAtRange(range);
    if (tw.energy <= 0) base = 0;
    dmg += base;
  }

  // Cover check: if target tile has hostile rampart/wall, tower beam cannot reach us.
  if (_hasHostileCover(intel, position)) {
    return 0;
  }

  dmg = dmg * (1 + SAFE_MARGIN);
  return dmg;
}

function _scoreHostile(intel, hostile, options) {
  if (!hostile) return -Infinity;
  var score = 0;
  var role = hostile.role || 'worker';
  var base = THREAT_WEIGHTS[role] || 0;
  score += base;
  if (hostile.counts && hostile.counts.heal > 0) {
    score += hostile.counts.heal * 30;
  }
  if (hostile.counts && hostile.counts.ranged > 2) score += 40;
  if (hostile.counts && hostile.counts.attack > 3) score += 25;

  if (options && options.anchorPos) {
    var anchor = options.anchorPos;
    var hostilePos = _unpackPos(hostile.pos);
    if (hostilePos) {
      var dist = anchor.getRangeTo(hostilePos);
      score += Math.max(0, 20 - dist);
    }
  }

  // Penalize if under rampart cover (hard to hit).
  if (_hasHostileCover(intel, _unpackPos(hostile.pos))) {
    score -= 120;
  }
  return score;
}

function _scoreStructure(intel, target, options) {
  if (!target) return -Infinity;
  var priority = target.priority || 0;
  var score = priority;
  if (options && options.anchorPos) {
    var anchor = options.anchorPos;
    var tpos = _unpackPos(target.pos);
    if (tpos) {
      var range = anchor.getRangeTo(tpos);
      score += Math.max(0, 10 - range);
    }
  }
  if (_hasHostileCover(intel, _unpackPos(target.pos))) {
    score -= 50;
  }
  return score;
}

function selectPrimaryTarget(roomName, options) {
  if (!roomName) return null;
  var intel = getIntel(roomName);
  if (!intel) return null;

  var anchorPos = options && options.anchorPos ? options.anchorPos : null;
  if (!anchorPos && options && options.anchor) anchorPos = options.anchor.pos || options.anchor;
  if (!anchorPos && options && options.fallbackPos) anchorPos = options.fallbackPos;

  var best = null;
  var bestScore = -Infinity;

  var hostiles = intel.hostiles || [];
  var i;
  for (i = 0; i < hostiles.length; i++) {
    var h = hostiles[i];
    var score = _scoreHostile(intel, h, { anchorPos: anchorPos });
    if (score > bestScore) {
      bestScore = score;
      best = { type: 'creep', hostile: h, score: score };
    }
  }

  // If no living creeps worth focusing, consider structures
  if (!best || bestScore < 100) {
    var structures = intel.structures || [];
    for (i = 0; i < structures.length; i++) {
      var s = structures[i];
      var sScore = _scoreStructure(intel, s, { anchorPos: anchorPos });
      if (sScore > bestScore) {
        bestScore = sScore;
        best = { type: 'structure', structure: s, score: sScore };
      }
    }
  }

  if (!best) return null;
  if (best.type === 'creep') {
    return Game.getObjectById(best.hostile.id) || _unpackPos(best.hostile.pos);
  }
  return Game.getObjectById(best.structure.id) || _unpackPos(best.structure.pos);
}

function hpsForCreep(creep) {
  if (!creep) return 0;
  // Healing per active part (docs: Creep::heal = 12, rangedHeal = 4)
  var healParts = creep.getActiveBodyparts ? creep.getActiveBodyparts(HEAL) : 0;
  return healParts * 12;
}

function totalSquadHps(creeps) {
  var total = 0;
  if (!creeps) return 0;
  for (var i = 0; i < creeps.length; i++) total += hpsForCreep(creeps[i]);
  return total;
}

function projectedTowerPressure(roomName, creeps) {
  if (!creeps || !creeps.length) return 0;
  var worst = 0;
  for (var i = 0; i < creeps.length; i++) {
    var c = creeps[i];
    if (!c || !c.pos) continue;
    var dmg = estimateTowerDps(roomName, c.pos);
    if (dmg > worst) worst = dmg;
  }
  return worst;
}

function shouldCommitAssault(roomName, creeps) {
  if (!roomName || !creeps || !creeps.length) return false;
  var hps = totalSquadHps(creeps);
  var towerDps = projectedTowerPressure(roomName, creeps);
  if (towerDps <= 0) return true;
  return (hps * 1.05) > towerDps; // require 5% margin for safety
}

function registerHostiles(room) {
  if (!room) return;
  var intel = getIntel(room.name);
  if (!intel) return;
  if ((Game.time - (intel.analyzedAt || 0)) >= HOSTILE_CACHE_TTL) {
    // Force refresh
    var hostiles = _categorizeHostiles(room);
    intel.hostiles = hostiles;
    intel.analyzedAt = Game.time;
    _storeIntel(room.name, intel, true);
  }
}

module.exports = {
  getIntel: getIntel,
  estimateTowerDps: estimateTowerDps,
  selectPrimaryTarget: selectPrimaryTarget,
  totalSquadHps: totalSquadHps,
  projectedTowerPressure: projectedTowerPressure,
  shouldCommitAssault: shouldCommitAssault,
  registerHostiles: registerHostiles,
};
