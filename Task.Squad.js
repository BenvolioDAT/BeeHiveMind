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
  var MEMBER_STALE_TICKS  = 50;

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
  // Squad snapshot cache (members + follow counts per tick)
  // -----------------------------
  if (!global.__TASKSQUAD_CACHE) global.__TASKSQUAD_CACHE = { tick: -1, membersBySquad: {}, followCounts: {} };

  function _ensureTickCache() {
    var cache = global.__TASKSQUAD_CACHE;
    if (!cache || cache.tick !== Game.time) {
      cache = { tick: Game.time, membersBySquad: {}, followCounts: {} };
      for (var name in Game.creeps) {
        if (!Game.creeps.hasOwnProperty(name)) continue;
        var creep = Game.creeps[name];
        if (!creep || !creep.my || !creep.memory) continue;
        var sid = getSquadId(creep);
        var list = cache.membersBySquad[sid];
        if (!list) list = cache.membersBySquad[sid] = [];
        list.push(creep);

        var followId = creep.memory.followTarget;
        if (followId) {
          var role = _roleOf(creep);
          var perSquad = cache.followCounts[sid];
          if (!perSquad) perSquad = cache.followCounts[sid] = {};
          var perRole = perSquad[role];
          if (!perRole) perRole = perSquad[role] = {};
          perRole[followId] = (perRole[followId] || 0) + 1;
        }
      }
      global.__TASKSQUAD_CACHE = cache;
    }
    return cache;
  }

  function getCachedMembers(squadId) {
    var cache = _ensureTickCache();
    var id = squadId || 'Alpha';
    var members = cache.membersBySquad[id];
    // Consumers must not mutate the array; it is reused for all lookups during the tick.
    return members ? members : [];
  }

  function getFollowLoad(squadId, targetId, roleName) {
    if (!targetId) return 0;
    var cache = _ensureTickCache();
    var id = squadId || 'Alpha';
    var perSquad = cache.followCounts[id];
    if (!perSquad) return 0;
    var perRole = perSquad[roleName || ''];
    if (!perRole) return 0;
    return perRole[targetId] || 0;
  }

  function getRoleFollowMap(squadId, roleName) {
    var cache = _ensureTickCache();
    var id = squadId || 'Alpha';
    var perSquad = cache.followCounts[id];
    if (!perSquad) return {};
    var perRole = perSquad[roleName || ''];
    // Callers should treat the returned object as read-only because it is shared for the tick.
    return perRole || {};
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
    var bucket = Memory.squads[id];
    if (!bucket.members) bucket.members = {};
    if (!bucket.desiredRoles) bucket.desiredRoles = {};
    if (!bucket.roleOrder || !bucket.roleOrder.length) bucket.roleOrder = ['CombatMelee', 'CombatArcher', 'CombatMedic'];
    if (!bucket.minReady || bucket.minReady < 1) bucket.minReady = 1;
    if (bucket.leader === undefined) bucket.leader = null;
    if (bucket.leaderPri === undefined) bucket.leaderPri = null;
    return bucket;
  }

  function _rallyFlagFor(id) {
    return Game.flags[RALLY_FLAG_PREFIX + id] ||
           Game.flags[RALLY_FLAG_PREFIX + '_' + id] ||
           Game.flags[id] || null;
  }

  function _cleanupMembers(bucket, id) {
    if (!bucket || !bucket.members) return;
    for (var name in bucket.members) {
      if (!BeeToolbox || !BeeToolbox.hasOwn(bucket.members, name)) continue;
      var rec = bucket.members[name];
      if (!rec) {
        delete bucket.members[name];
        continue;
      }
      if (!Game.creeps[name]) {
        delete bucket.members[name];
        continue;
      }
      if (rec.updated && Game.time - rec.updated > MEMBER_STALE_TICKS) {
        var c = Game.creeps[name];
        if (c && c.my) {
          rec.updated = Game.time;
        } else {
          delete bucket.members[name];
        }
      }
    }
    if (bucket.leader && (!bucket.members[bucket.leader] || !Game.creeps[bucket.leader])) {
      bucket.leader = null;
      bucket.leaderPri = null;
    }
    if (id) _refreshLeader(bucket, id);
  }

  function _refreshLeader(bucket, id, candidateName) {
    if (!bucket) return;

    if (bucket.leader && (!bucket.members[bucket.leader] || !Game.creeps[bucket.leader])) {
      bucket.leader = null;
      bucket.leaderPri = null;
    }

    if (candidateName) {
      var cand = Game.creeps[candidateName];
      if (cand && cand.memory && (cand.memory.squadId || 'Alpha') === id) {
        var pri = _rolePri(cand);
        if (!bucket.leader || bucket.leaderPri == null || pri > bucket.leaderPri || bucket.leader === candidateName) {
          bucket.leader = candidateName;
          bucket.leaderPri = pri;
        }
      }
    }

    if (!bucket.leader) {
      var cache = _ensureTickCache();
      var members = cache.membersBySquad[id] || [];
      var best = null;
      var bestPri = -9999;
      for (var i = 0; i < members.length; i++) {
        var member = members[i];
        if (!member || !member.memory) continue;
        if ((member.memory.squadId || 'Alpha') !== id) continue;
        var priVal = _rolePri(member);
        if (!best || priVal > bestPri) {
          best = member;
          bestPri = priVal;
        }
      }
      if (best) {
        bucket.leader = best.name;
        bucket.leaderPri = bestPri;
      }
    }
  }

  function getRallyPos(squadId) {
    var id = squadId || 'Alpha';
    var bucket = _ensureSquadBucket(id);
    var rally = bucket && bucket.rally;
    if (rally && rally.roomName != null) {
      return new RoomPosition(rally.x, rally.y, rally.roomName);
    }
    var flag = _rallyFlagFor(id);
    if (flag) {
      bucket.rally = { x: flag.pos.x, y: flag.pos.y, roomName: flag.pos.roomName };
      return flag.pos;
    }
    return null;
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

  function _isNpcUsername(name) {
    return !name || name === 'Invader' || name === 'Source Keeper';
  }

  // FIX: Reuse the alliance helper so we only ignore creeps and structures owned by trusted players.
  function _isAllyUsername(name) {
    if (!name) return false;
    if (BeeToolbox && typeof BeeToolbox.isAllyUsername === 'function') {
      return BeeToolbox.isAllyUsername(name);
    }
    if (typeof AllianceManager !== 'undefined' && AllianceManager && typeof AllianceManager.isAlly === 'function') {
      return AllianceManager.isAlly(name);
    }
    if (typeof global !== 'undefined' && global.AllianceManager && typeof global.AllianceManager.isAlly === 'function') {
      return global.AllianceManager.isAlly(name);
    }
    return false;
  }

  function _chooseRoomTarget(me) {
    var room = me.room; if (!room) return null;

    // FIX: Include all non-allied hostiles (players and NPCs) instead of only NPC creeps.
    var hostiles = room.find(FIND_HOSTILE_CREEPS, {
      filter: function (h) {
        var owner = h.owner && h.owner.username;
        return !_isAllyUsername(owner);
      }
    });
    if (hostiles && hostiles.length) {
      var scored = _.map(hostiles, function (h) { return { h: h, s: _scoreHostile(me, h) }; });
      var best = _.min(scored, 's');
      if (best && best.h) return best.h;
    }

    var key = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s) {
      var owner = s.owner && s.owner.username;
      if (!owner) return false;
      if (_isAllyUsername(owner)) return false;
      return s.structureType === STRUCTURE_TOWER || s.structureType === STRUCTURE_SPAWN;
    }});
    if (key.length) return me.pos.findClosestByRange(key);

    var others = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s) {
      var owner = s.owner && s.owner.username;
      if (!owner) return false;
      return !_isAllyUsername(owner);
    }});
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
    var id = getSquadId(creep), S = _ensureSquadBucket(id);
    var rally = getRallyPos(id);
    if (rally) {
      S.anchor = { x: rally.x, y: rally.y, room: rally.roomName };
      S.anchorAt = Game.time;
      return rally;
    }

    var leader = null;
    if (S.leader) {
      leader = Game.creeps[S.leader] || null;
      if (!leader || !leader.memory || (leader.memory.squadId || 'Alpha') !== id) {
        S.leader = null;
        S.leaderPri = null;
        leader = null;
      }
    }
    if (!leader) {
      _refreshLeader(S, id);
      if (S.leader) leader = Game.creeps[S.leader] || null;
    }
    if (leader && leader.pos) {
      S.anchor = { x: leader.pos.x, y: leader.pos.y, room: leader.pos.roomName };
      S.anchorAt = Game.time;
      return leader.pos;
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

  function registerMember(squadId, creepName, role, opts) {
    var id = squadId || 'Alpha';
    var bucket = _ensureSquadBucket(id);
    if (!creepName) return;

    _cleanupMembers(bucket, id);

    var entry = bucket.members[creepName];
    if (!entry) {
      entry = bucket.members[creepName] = { role: role || 'unknown', rallied: false };
    }
    if (role) entry.role = role;
    entry.updated = Game.time;

    var rallyPos = null;
    if (opts && opts.rallyPos) {
      rallyPos = opts.rallyPos;
    } else if (opts && opts.creep) {
      rallyPos = getRallyPos(id);
    }
    if (rallyPos && (!bucket.rally || bucket.rally.x !== rallyPos.x || bucket.rally.y !== rallyPos.y || bucket.rally.roomName !== rallyPos.roomName)) {
      bucket.rally = { x: rallyPos.x, y: rallyPos.y, roomName: rallyPos.roomName };
    }

    var rallied = false;
    if (opts) {
      if (typeof opts.rallied === 'boolean') {
        rallied = opts.rallied;
      } else if (opts.creep && rallyPos) {
        rallied = opts.creep.pos && opts.creep.pos.inRangeTo(rallyPos, 1);
      }
    }

    if (rallied) {
      entry.rallied = true;
      entry.ralliedAt = Game.time;
    }

    _refreshLeader(bucket, id, creepName);
  }

  function isReady(squadId) {
    var id = squadId || 'Alpha';
    var bucket = _ensureSquadBucket(id);
    _cleanupMembers(bucket, id);

    var desired = bucket.desiredRoles || {};
    var counts = {};
    var totalRallied = 0;

    for (var name in bucket.members) {
      if (!BeeToolbox || !BeeToolbox.hasOwn(bucket.members, name)) continue;
      var rec = bucket.members[name];
      if (!rec) continue;
      var live = Game.creeps[name];
      if (!live || !live.my) continue;
      var role = rec.role || (live.memory && (live.memory.squadRole || live.memory.task)) || 'unknown';
      if (rec.rallied) {
        counts[role] = (counts[role] || 0) + 1;
        totalRallied += 1;
      }
    }

    var totalNeeded = 0;
    var allMet = true;
    for (var key in desired) {
      if (!BeeToolbox || !BeeToolbox.hasOwn(desired, key)) continue;
      var need = desired[key] | 0;
      if (need <= 0) continue;
      totalNeeded += need;
      if ((counts[key] || 0) < need) {
        allMet = false;
      }
    }

    if (allMet && totalNeeded > 0) {
      return true;
    }

    var threshold = bucket.minReady || 1;
    if (threshold < 1) threshold = 1;
    return totalRallied >= threshold;
  }

  // -----------------------------
  // Public API
  // -----------------------------
  API.getSquadId     = getSquadId;
  API.sharedTarget   = sharedTarget;
  API.getAnchor      = getAnchor;
  API.getRallyPos    = getRallyPos;
  API.stepToward     = stepToward;
  API.politelyYieldFor = _politelyYieldFor;
  API.registerMember = registerMember;
  API.isReady        = isReady;
  API.getCachedMembers = getCachedMembers;
  API.getFollowLoad    = getFollowLoad;
  API.getRoleFollowMap = getRoleFollowMap;

  return API;
})();

module.exports = TaskSquad;
