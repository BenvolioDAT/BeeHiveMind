"use strict";

var BeeToolbox = require('BeeToolbox');

var SCAN_INTERVAL = 50;
var MAX_RADIUS = 6;
var HOSTILE_DECAY = 1500;
var HOSTILE_PENALTY = 5;
var TOWER_PENALTY = 8;

var __cache = Object.create(null);

function ensureState(homeName) {
  if (!__cache[homeName]) {
    __cache[homeName] = {
      nextScan: 0,
      ranked: []
    };
  }
  return __cache[homeName];
}

function parseRoomName(name) {
  if (!BeeToolbox.isValidRoomName(name)) return null;
  var match = name.match(/^([WE])(\d+)([NS])(\d+)$/);
  if (!match) return null;
  var x = parseInt(match[2], 10);
  var y = parseInt(match[4], 10);
  if (match[1] === 'W') x = -x - 1;
  if (match[3] === 'S') y = -y - 1;
  return { x: x, y: y };
}

function isHighwayRoom(name) {
  var coords = parseRoomName(name);
  if (!coords) return false;
  return (Math.abs(coords.x) % 10 === 0) || (Math.abs(coords.y) % 10 === 0);
}

function gatherCandidates(homeName) {
  if (!Game || !Game.map || typeof Game.map.describeExits !== 'function') return [];
  var visited = Object.create(null);
  var queue = [{ name: homeName, dist: 0 }];
  visited[homeName] = true;
  var result = [];
  while (queue.length) {
    var node = queue.shift();
    if (!node) break;
    if (node.dist > 0) {
      result.push(node);
    }
    if (node.dist >= MAX_RADIUS) continue;
    var exits = Game.map.describeExits(node.name) || {};
    for (var dir in exits) {
      if (!Object.prototype.hasOwnProperty.call(exits, dir)) continue;
      var nextName = exits[dir];
      if (!nextName || visited[nextName]) continue;
      visited[nextName] = true;
      queue.push({ name: nextName, dist: node.dist + 1 });
    }
  }
  return result;
}

function countSources(roomName) {
  var visible = Game.rooms[roomName];
  if (visible) {
    var srcs = visible.find(FIND_SOURCES);
    return Array.isArray(srcs) ? srcs.length : 0;
  }
  var mem = (Memory.rooms && Memory.rooms[roomName]) || {};
  if (mem.sources && typeof mem.sources === 'object') {
    var count = 0;
    for (var key in mem.sources) {
      if (Object.prototype.hasOwnProperty.call(mem.sources, key)) count += 1;
    }
    if (count > 0) return count;
  }
  if (mem.intel && typeof mem.intel.sources === 'number') {
    return mem.intel.sources;
  }
  return 0;
}

function hostilePenalty(roomName, visible, mem, myName) {
  var penalty = 0;
  var towerThreat = false;
  if (visible) {
    var hostiles = visible.find(FIND_HOSTILE_CREEPS);
    if (hostiles && hostiles.length) {
      penalty += HOSTILE_PENALTY;
    }
    var hostileStructures = visible.find(FIND_HOSTILE_STRUCTURES, {
      filter: function (s) {
        return s.structureType === STRUCTURE_TOWER;
      }
    });
    if (hostileStructures && hostileStructures.length) {
      penalty += TOWER_PENALTY;
      towerThreat = true;
    }
    if (visible.controller && visible.controller.owner && visible.controller.owner.username && visible.controller.owner.username !== myName) {
      penalty += HOSTILE_PENALTY;
      towerThreat = true;
    }
  } else if (mem) {
    if (mem.hostile) {
      penalty += HOSTILE_PENALTY;
    }
    if (mem._invaderLock && mem._invaderLock.locked) {
      var tick = mem._invaderLock.t | 0;
      if (tick === 0 || (Game.time - tick) <= HOSTILE_DECAY) {
        penalty += HOSTILE_PENALTY;
      }
    }
  }
  return { value: penalty, tower: towerThreat };
}

function reservationPenalty(visible, mem, myName) {
  if (visible) {
    if (visible.controller && visible.controller.reservation && visible.controller.reservation.username !== myName) {
      return 3;
    }
    if (visible.controller && visible.controller.owner && visible.controller.owner.username && visible.controller.owner.username !== myName) {
      return 6;
    }
  } else if (mem && mem.controller && mem.controller.reservation) {
    var res = mem.controller.reservation;
    if (res.username && res.username !== myName) {
      return 3;
    }
  }
  return 0;
}

function pathTerrainBonus(roomName) {
  if (isHighwayRoom(roomName)) return 0.5;
  return 0;
}

function scoreCandidate(homeRoom, candidate) {
  var reasons = {};
  var score = 0;
  var sources = countSources(candidate.name);
  if (sources <= 0) {
    reasons.needsScout = 1;
    sources = 0;
  }
  score += sources * 2;
  reasons.sources = sources;

  var dist = candidate.dist;
  score += 1 / (1 + dist);
  reasons.distance = dist;

  var terrainBonus = pathTerrainBonus(candidate.name);
  if (terrainBonus) {
    reasons.highwayBonus = terrainBonus;
    score += terrainBonus;
  }

  var visible = Game.rooms[candidate.name];
  var mem = (Memory.rooms && Memory.rooms[candidate.name]) || {};
  var myName = (homeRoom.controller && homeRoom.controller.owner) ? homeRoom.controller.owner.username : null;

  var hostile = hostilePenalty(candidate.name, visible, mem, myName);
  if (hostile.value) {
    reasons.hostilePenalty = hostile.value;
    score -= hostile.value;
  }
  if (hostile.tower) {
    reasons.towerThreat = 1;
  }

  var resPenalty = reservationPenalty(visible, mem, myName);
  if (resPenalty) {
    reasons.reservationPenalty = resPenalty;
    score -= resPenalty;
  }

  if (!visible) {
    reasons.needsScout = 1;
  }

  return { roomName: candidate.name, score: score, reasons: reasons };
}

function rankTargets(homeRoom) {
  var state = ensureState(homeRoom.name);
  if (Game.time < state.nextScan) {
    return state.ranked;
  }
  var candidates = gatherCandidates(homeRoom.name);
  var results = [];
  for (var i = 0; i < candidates.length; i++) {
    var scored = scoreCandidate(homeRoom, candidates[i]);
    if (scored) {
      results.push(scored);
    }
  }
  results.sort(function (a, b) {
    if (b.score === a.score) {
      return (a.roomName < b.roomName) ? -1 : 1;
    }
    return b.score - a.score;
  });
  state.ranked = results;
  state.nextScan = Game.time + SCAN_INTERVAL;
  return results;
}

function cloneReasons(input) {
  var out = {};
  for (var key in input) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      out[key] = input[key];
    }
  }
  return out;
}

var ExpansionAI = {
  /**
   * Rank expansion targets within a defined radius around a home room.
   * @param {Room} homeRoom Owned room to expand from.
   * @param {object} kpis KPI snapshot (unused but reserved for future heuristics).
   * @returns {Array} Sorted target descriptors.
   * @cpu Heavy path scan every SCAN_INTERVAL ticks.
   */
  rankExpansionTargets: function (homeRoom, kpis) {
    if (!homeRoom || !homeRoom.controller || !homeRoom.controller.my) return [];
    var ranked = rankTargets(homeRoom) || [];
    var result = [];
    for (var i = 0; i < ranked.length; i++) {
      var entry = ranked[i];
      result.push({ roomName: entry.roomName, score: entry.score, reasons: cloneReasons(entry.reasons) });
    }
    return result;
  },

  /**
   * Build a staged plan for establishing a forward operating base in the target room.
   * @param {Room} homeRoom Source room coordinating the expansion.
   * @param {object} target Ranked target entry.
   * @returns {object} Expansion plan structure.
   * @cpu O(1) per invocation.
   */
  planFOB: function (homeRoom, target) {
    var reasons = target ? target.reasons || {} : {};
    var sources = reasons.sources || 1;
    var remoteCount = sources > 0 ? sources : 1;
    var hostile = reasons.hostilePenalty ? true : false;
    var towerThreat = reasons.towerThreat ? true : false;
    return {
      steps: [
        { type: 'SCOUT', room: target ? target.roomName : null },
        { type: 'RESERVE', room: target ? target.roomName : null, rclMin: 3 },
        { type: 'ROAD', from: homeRoom ? homeRoom.name : null, to: target ? target.roomName : null },
        { type: 'CONTAINER_AT_SOURCES' },
        { type: 'CLAIM_AND_BOOTSTRAP', room: target ? target.roomName : null, rclMin: 4 }
      ],
      spawnQueue: [
        { role: 'scout', count: 1 },
        { role: 'claimer', count: 1, when: 'reservation-needed' },
        { role: 'remoteharvest', count: Math.max(1, remoteCount) },
        { role: 'trucker', count: Math.max(1, remoteCount) }
      ],
      abortIf: { hostiles: hostile, towerThreat: towerThreat }
    };
  }
};

module.exports = ExpansionAI;
