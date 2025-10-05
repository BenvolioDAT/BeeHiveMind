// Task.Squad.js — Traveler-powered movement + polite traffic shim + tile reservations (ES5-safe)
'use strict';

/**
 * Dependencies:
 *   - Traveler.js (attaches creep.travelTo)
 *   - (Optional) BeeToolbox.roomCallback for custom cost matrices
 */
var BeeToolbox; try { BeeToolbox = require('BeeToolbox'); } catch (e) { BeeToolbox = null; }
try { require('Traveler'); } catch (e2) { /* ensure Traveler is loaded once */ }

var TaskSquad = (function () {
  var API = {};

  // -----------------------------
  // Tunables
  // -----------------------------
  var TARGET_STICKY_TICKS = 12; // how long to keep a chosen target before re-eval
  var RALLY_FLAG_PREFIX   = 'Squad'; // e.g. "SquadAlpha", "Squad_Beta"
  var MAX_TARGET_RANGE    = 30;

  // Target scoring
  var HEALER_WEIGHT = -500, RANGED_WEIGHT = -260, MELEE_WEIGHT = -140, HURT_WEIGHT = -160, TOUGH_PENALTY = +25;

  // Traveler defaults for combat
  var TRAVELER_DEFAULTS = {
    ignoreCreeps: false,   // start conservative for squads; Traveler flips when stuck
    stuckValue: 2,
    repath: 0.05,
    maxOps: 6000,
    allowHostile: false
  };

  // Role priority (higher number = higher right-of-way)
  var ROLE_PRI = {
    'CombatMelee': 90,
    'Dismantler':  80,
    'CombatArcher':70,
    'CombatMedic': 60
  };

  var COMBAT_ROLES = {
    'CombatMelee': 1,
    'CombatArcher': 1,
    'CombatMedic': 1,
    'Dismantler': 1
  };

  var STANDDOWN_SCORE_THRESHOLD = 3;
  var STANDDOWN_GRACE_TICKS = 25;

  // -----------------------------
  // Per-tick move reservation map
  // -----------------------------
  if (!global.__MOVE_RES__) global.__MOVE_RES__ = { tick: -1, rooms: {} };

  function _resetReservations() {
    if (global.__MOVE_RES__.tick !== Game.time) {
      global.__MOVE_RES__.tick = Game.time;
      global.__MOVE_RES__.rooms = {};
    }
  }

  function _key(x, y) { return x + '_' + y; }

  function _reserveTile(creep, pos, priority) {
    _resetReservations();
    var roomName = pos.roomName || (pos.pos && pos.pos.roomName);
    if (!roomName) return true; // nothing to do

    var roomMap = global.__MOVE_RES__.rooms[roomName];
    if (!roomMap) roomMap = (global.__MOVE_RES__.rooms[roomName] = {});

    var k = _key(pos.x || pos.pos.x, pos.y || pos.pos.y);
    var cur = roomMap[k];
    if (!cur) {
      roomMap[k] = { name: creep.name, pri: priority|0 };
      return true;
    }

    // If the same creep, ok
    if (cur.name === creep.name) return true;

    // Higher priority wins
    if ((priority|0) > (cur.pri|0)) {
      roomMap[k] = { name: creep.name, pri: priority|0 };
      return true;
    }

    return false; // someone stronger already owns it this tick
  }

  // -----------------------------
  // Utilities
  // -----------------------------
  function _roleOf(creep) {
    return (creep && creep.memory && (creep.memory.task || creep.memory.role)) || '';
  }
  function _isCombat(creep) { return !!COMBAT_ROLES[_roleOf(creep)]; }
  function _isCivilian(creep) { return !_isCombat(creep); }
  function _rolePri(creep) {
    var r = _roleOf(creep);
    var p = ROLE_PRI[r];
    return (p == null) ? 10 : p; // default low priority for unknown roles
  }
  function _movedThisTick(creep) { return creep && creep.memory && creep.memory._movedAt === Game.time; }

  function getSquadId(creep) {
    return (creep.memory && creep.memory.squadId) || 'Alpha';
  }

  function _ensureSquadBucket(id) {
    if (!Memory.squads) Memory.squads = {};
    if (!Memory.squads[id]) Memory.squads[id] = { targetId: null, targetAt: 0, anchor: null, anchorAt: 0 };
    return Memory.squads[id];
  }

  function _resolveTargetRoom(creep) {
    if (!creep) return null;
    var id = getSquadId(creep);
    var S = _ensureSquadBucket(id);
    if (creep.memory && creep.memory.targetRoom) return creep.memory.targetRoom;
    if (S && S.targetRoom) return S.targetRoom;
    var mem = Memory.squadFlags || {};
    var bindings = mem.bindings || {};
    if (S && S.flagName && bindings[S.flagName]) return bindings[S.flagName];
    if (S && S.flagName && Game.flags[S.flagName] && Game.flags[S.flagName].pos) {
      return Game.flags[S.flagName].pos.roomName;
    }
    return null;
  }

  function _bindingActiveFor(roomName) {
    if (!roomName) return false;
    var mem = Memory.squadFlags || {};
    var bindings = mem.bindings || {};
    for (var flag in bindings) {
      if (!bindings.hasOwnProperty(flag)) continue;
      if (bindings[flag] === roomName) return true;
    }
    return false;
  }

  function shouldRecycle(creep) {
    if (!creep || creep.spawning) return false;
    var targetRoom = _resolveTargetRoom(creep);
    if (!targetRoom) return false;

    var mem = Memory.squadFlags || {};
    var roomInfo = (mem.rooms && mem.rooms[targetRoom]) || {};
    var score = roomInfo.lastScore || 0;
    var lastThreatAt = roomInfo.lastThreatAt || 0;
    var bindingActive = _bindingActiveFor(targetRoom);
    var hasVision = !!Game.rooms[targetRoom];

    if (hasVision) {
      var hostiles = Game.rooms[targetRoom].find(FIND_HOSTILE_CREEPS) || [];
      if (hostiles.length) return false;
    }

    if (bindingActive) {
      if (score > STANDDOWN_SCORE_THRESHOLD) return false;
      if ((Game.time - lastThreatAt) <= STANDDOWN_GRACE_TICKS) return false;
    } else {
      if ((Game.time - lastThreatAt) <= STANDDOWN_GRACE_TICKS) return false;
    }

    if (!hasVision && bindingActive) return false;

    if (creep.room && creep.room.find(FIND_HOSTILE_CREEPS).length) return false;

    return true;
  }

  function recycleToHome(creep) {
    if (!creep) return false;
    if (creep.memory) creep.memory.recycling = true;

    var homeName = (creep.memory && creep.memory.homeRoom) || Memory.firstSpawnRoom || null;
    var targetSpawn = null;

    if (homeName && Game.rooms[homeName]) {
      var spawns = Game.rooms[homeName].find(FIND_MY_SPAWNS);
      if (spawns && spawns.length) targetSpawn = spawns[0];
    }
    if (!targetSpawn) {
      targetSpawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
    }

    if (targetSpawn) {
      if (!creep.pos.isNearTo(targetSpawn)) {
        stepToward(creep, targetSpawn.pos, 1);
      } else {
        targetSpawn.recycleCreep(creep);
      }
      return true;
    }

    if (homeName && creep.pos.roomName !== homeName) {
      stepToward(creep, new RoomPosition(25, 25, homeName), 1);
      return true;
    }

    return false;
  }

  function _rallyFlagFor(id) {
    return Game.flags[RALLY_FLAG_PREFIX + id] ||
           Game.flags[RALLY_FLAG_PREFIX + '_' + id] ||
           Game.flags[id] || null;
  }

  function _isGood(obj) { return obj && obj.hits != null && obj.hits > 0 && obj.pos && obj.pos.roomName; }

  function _scoreHostile(me, h) {
    var dist   = me.pos.getRangeTo(h);
    var healer = h.getActiveBodyparts(HEAL) > 0 ? HEALER_WEIGHT : 0;
    var ranged = h.getActiveBodyparts(RANGED_ATTACK) > 0 ? RANGED_WEIGHT : 0;
    var melee  = h.getActiveBodyparts(ATTACK) > 0 ? MELEE_WEIGHT : 0;
    var tough  = h.getActiveBodyparts(TOUGH) > 0 ? TOUGH_PENALTY : 0;
    var hurt   = (1 - h.hits / Math.max(1, h.hitsMax)) * HURT_WEIGHT;
    return healer + ranged + melee + tough + hurt + dist;
  }

  function _chooseRoomTarget(me) {
    var room = me.room; if (!room) return null;

    var hostiles = room.find(FIND_HOSTILE_CREEPS);
    if (hostiles && hostiles.length) {
      var scored = _.map(hostiles, function (h) { return { h: h, s: _scoreHostile(me, h) }; });
      var best = _.min(scored, 's');
      if (best && best.h) return best.h;
    }

    var key = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s) {
      return s.structureType === STRUCTURE_TOWER || s.structureType === STRUCTURE_SPAWN;
    }});
    if (key.length) return me.pos.findClosestByRange(key);

    var others = room.find(FIND_HOSTILE_STRUCTURES);
    if (others.length) return me.pos.findClosestByRange(others);

    return null;
  }

  function sharedTarget(creep) {
    var id = getSquadId(creep);
    var S  = _ensureSquadBucket(id);

    if (S.targetId && Game.time - (S.targetAt || 0) <= TARGET_STICKY_TICKS) {
      var keep = Game.getObjectById(S.targetId);
      if (_isGood(keep) && creep.pos.getRangeTo(keep) <= MAX_TARGET_RANGE) return keep;
    }
    var nxt = _chooseRoomTarget(creep);
    if (nxt) { S.targetId = nxt.id; S.targetAt = Game.time; return nxt; }
    S.targetId = null; S.targetAt = Game.time;
    return null;
  }

  function getAnchor(creep) {
    var id = getSquadId(creep), S = _ensureSquadBucket(id), f = _rallyFlagFor(id);
    if (f) { S.anchor = { x: f.pos.x, y: f.pos.y, room: f.pos.roomName }; S.anchorAt = Game.time; return f.pos; }

    // Fallback: the first melee in squad, else any member
    var names = Object.keys(Game.creeps).sort(), leader = null, i, c;
    for (i = 0; i < names.length; i++) {
      c = Game.creeps[names[i]];
      if (c && c.memory && c.memory.squadId === id && (_roleOf(c) === 'CombatMelee')) { leader = c; break; }
    }
    if (!leader) {
      for (i = 0; i < names.length; i++) {
        c = Game.creeps[names[i]];
        if (c && c.memory && c.memory.squadId === id) { leader = c; break; }
      }
    }
    if (leader && leader.pos) {
      S.anchor = { x: leader.pos.x, y: leader.pos.y, room: leader.pos.roomName };
      S.anchorAt = Game.time; return leader.pos;
    }
    return null;
  }

  // -----------------------------
  // Polite traffic shim (priority aware)
  // -----------------------------
  function _politelyYieldFor(mover, nextPos) {
    if (!nextPos) return;

    var blockers = nextPos.lookFor(LOOK_CREEPS);
    if (!blockers || !blockers.length) return;

    var ally = blockers[0];
    if (!ally || !ally.my) return;

    // If ally already moved this tick, don't disturb
    if (_movedThisTick(ally)) return;

    var sameSquad = (mover.memory && ally.memory &&
                     mover.memory.squadId && ally.memory.squadId &&
                     mover.memory.squadId === ally.memory.squadId);

    var moverPri = _rolePri(mover);
    var allyPri  = _rolePri(ally);

    // Only try to move ally if:
    //   - same squad and mover has >= priority, or
    //   - mover is combat and ally is civilian (ROW)
    var allow = (sameSquad && moverPri >= allyPri) || (_isCombat(mover) && _isCivilian(ally));
    if (!allow) return;

    // Compute direction mover -> ally tile
    var dir = mover.pos.getDirectionTo(nextPos);
    var back = ((dir + 4 - 1) % 8) + 1;

    var off = [
      [0, 0],
      [0, -1],  [1, -1],  [1, 0],   [1, 1],
      [0, 1],   [-1, 1],  [-1, 0],  [-1, -1]
    ];

    function _isTileFree(pos) {
      if (!pos || pos.x <= 0 || pos.x >= 49 || pos.y <= 0 || pos.y >= 49) return false;
      var look = pos.look();
      for (var i = 0; i < look.length; i++) {
        var o = look[i];
        if (o.type === LOOK_TERRAIN && o.terrain === 'wall') return false;
        if (o.type === LOOK_CREEPS) return false;
        if (o.type === LOOK_STRUCTURES) {
          var st = o.structure.structureType;
          if (st !== STRUCTURE_ROAD && st !== STRUCTURE_CONTAINER &&
             (st !== STRUCTURE_RAMPART || !o.structure.my)) return false;
        }
      }
      return true;
    }

    // Try ally back-step
    var bx = ally.pos.x + off[back][0], by = ally.pos.y + off[back][1];
    if (bx >= 0 && bx <= 49 && by >= 0 && by <= 49) {
      var bpos = new RoomPosition(bx, by, ally.pos.roomName);
      if (_isTileFree(bpos) && _reserveTile(ally, bpos, allyPri)) { ally.move(back); ally.memory._movedAt = Game.time; return; }
    }

    // Try side-steps (left/right)
    var left  = ((dir + 6 - 1) % 8) + 1; // -2
    var right = ((dir + 2 - 1) % 8) + 1; // +2
    var sides = [left, right];
    for (var s = 0; s < sides.length; s++) {
      var sd = sides[s];
      var sx = ally.pos.x + off[sd][0], sy = ally.pos.y + off[sd][1];
      if (sx < 0 || sx > 49 || sy < 0 || sy > 49) continue;
      var spos = new RoomPosition(sx, sy, ally.pos.roomName);
      if (_isTileFree(spos) && _reserveTile(ally, spos, allyPri)) { ally.move(sd); ally.memory._movedAt = Game.time; return; }
    }
  }

  // -----------------------------
  // Traveler-backed stepToward with reservations
  // -----------------------------
  function stepToward(creep, pos, range) {
    if (!creep || !pos) return ERR_NO_PATH;

    // Already close enough?
    var tgtPos = (pos.pos || pos);
    var needRange = (typeof range === 'number' ? range : 0);
    if (creep.pos.getRangeTo(tgtPos) <= needRange) return OK;

    var retData = {};
    var opts = {
      range: needRange,
      ignoreCreeps: TRAVELER_DEFAULTS.ignoreCreeps,
      stuckValue: TRAVELER_DEFAULTS.stuckValue,
      repath: TRAVELER_DEFAULTS.repath,
      maxOps: TRAVELER_DEFAULTS.maxOps,
      allowHostile: TRAVELER_DEFAULTS.allowHostile,
      roomCallback: (BeeToolbox && BeeToolbox.roomCallback) ? BeeToolbox.roomCallback : undefined,
      returnData: retData
    };

    // Ask Traveler to plan + possibly move
    var code = creep.travelTo(tgtPos, opts);

    var myPri = _rolePri(creep);

    // If a nextPos is planned, try to claim it. If we lose the reservation race to
    // a higher-priority unit, stop this tick (prevents “dance”).
    if (retData && retData.nextPos) {
      // If another creep is physically there, try to politely yield them first
      _politelyYieldFor(creep, retData.nextPos);

      // Re-check reservation after yield attempt
      if (!_reserveTile(creep, retData.nextPos, myPri)) {
        // Could not reserve (someone more important got it) → do nothing this tick
        return ERR_BUSY;
      }
    }

    // Mark that we issued movement this tick (helps yield logic)
    creep.memory = creep.memory || {};
    creep.memory._movedAt = Game.time;

    // Lightweight unstick (rare)
    var stuck = (creep.fatigue === 0 && creep.memory._lx === creep.pos.x && creep.memory._ly === creep.pos.y);
    if (stuck && creep.pos.getRangeTo(tgtPos) > needRange) {
      _unstickWiggle(creep, tgtPos);
    }
    creep.memory._lx = creep.pos.x; creep.memory._ly = creep.pos.y;

    return code;
  }

  function _unstickWiggle(creep, goalPos) {
    var bestDir = 0, bestScore = 1e9, d, x, y, p, score;
    for (d = 1; d <= 8; d++) {
      x = creep.pos.x + (d === RIGHT || d === TOP_RIGHT || d === BOTTOM_RIGHT ? 1 :
                         d === LEFT  || d === TOP_LEFT  || d === BOTTOM_LEFT  ? -1 : 0);
      y = creep.pos.y + (d === BOTTOM || d === BOTTOM_LEFT || d === BOTTOM_RIGHT ? 1 :
                         d === TOP    || d === TOP_LEFT   || d === TOP_RIGHT    ? -1 : 0);
      if (x < 0 || x > 49 || y < 0 || y > 49) continue;
      p = new RoomPosition(x, y, creep.pos.roomName);
      var pass = true, look = p.look(), i;
      for (i = 0; i < look.length; i++) {
        var o = look[i];
        if (o.type === LOOK_TERRAIN && o.terrain === 'wall') { pass = false; break; }
        if (o.type === LOOK_CREEPS) { pass = false; break; }
        if (o.type === LOOK_STRUCTURES) {
          var st = o.structure.structureType;
          if (st !== STRUCTURE_ROAD && st !== STRUCTURE_CONTAINER &&
             (st !== STRUCTURE_RAMPART || !o.structure.my)) { pass = false; break; }
        }
      }
      if (!pass) continue;
      score = p.getRangeTo(goalPos);
      if (score < bestScore) { bestScore = score; bestDir = d; }
    }
    if (bestDir) creep.move(bestDir);
  }

  // -----------------------------
  // Public API
  // -----------------------------
  API.getSquadId   = getSquadId;
  API.sharedTarget = sharedTarget;
  API.getAnchor    = getAnchor;
  API.stepToward   = stepToward;
  API.shouldRecycle = shouldRecycle;
  API.recycleToHome = recycleToHome;

  return API;
})();

module.exports = TaskSquad;
