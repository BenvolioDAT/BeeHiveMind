// Task.Squad.js — Traveler-powered movement + polite traffic shim (ES5-safe)
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

  // Traveler defaults (tweak if you like)
  var TRAVELER_DEFAULTS = {
    ignoreCreeps: true,    // start optimistic; Traveler flips when stuck
    stuckValue: 2,         // lower = repath sooner on micro-stalls
    repath: 0.05,          // small randomized refresh to avoid herd ruts
    maxOps: 6000,          // tune to your CPU budget
    allowHostile: false    // don’t hug red rooms unless told
    // preferHighway: true, // uncomment if your paths cross a lot of highways
  };

  // Simple role gates (edit names to match your codebase if different)
  var COMBAT_ROLES = {
    'CombatMelee': 1,
    'CombatArcher': 1,
    'CombatMedic': 1,
    'Dismantler': 1
  };

  // -----------------------------
  // Utilities
  // -----------------------------
  function _roleOf(creep) {
    return (creep && creep.memory && (creep.memory.task || creep.memory.role)) || '';
  }
  function _isCombat(creep) { return !!COMBAT_ROLES[_roleOf(creep)]; }
  function _isCivilian(creep) { return !_isCombat(creep); }

  function getSquadId(creep) {
    return (creep.memory && creep.memory.squadId) || 'Alpha';
  }

  function _ensureSquadBucket(id) {
    if (!Memory.squads) Memory.squads = {};
    if (!Memory.squads[id]) Memory.squads[id] = { targetId: null, targetAt: 0, anchor: null, anchorAt: 0 };
    return Memory.squads[id];
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

    // Priority: enemy creeps (weighted)
    var hostiles = room.find(FIND_HOSTILE_CREEPS);
    if (hostiles && hostiles.length) {
      var scored = _.map(hostiles, function (h) { return { h: h, s: _scoreHostile(me, h) }; });
      var best = _.min(scored, 's');
      if (best && best.h) return best.h;
    }

    // Next: key hostile structures (towers/spawns)
    var key = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s) {
      return s.structureType === STRUCTURE_TOWER || s.structureType === STRUCTURE_SPAWN;
    }});
    if (key.length) return me.pos.findClosestByRange(key);

    // Lastly: any hostile structure
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
  // Polite traffic shim
  // -----------------------------
  // Small helper so soldiers (or same-squad members) can move through friendly civilians without deadlocking.
  function _politelyYieldFor(mover, nextPos) {
    if (!nextPos) return;

    var blockers = nextPos.lookFor(LOOK_CREEPS);
    if (!blockers || !blockers.length) return;

    var ally = blockers[0];
    if (!ally.my) return; // Only coordinate with our creeps

    var sameSquad = (mover.memory && ally.memory &&
                     mover.memory.squadId && ally.memory.squadId &&
                     mover.memory.squadId === ally.memory.squadId);

    var soldierHasROW = _isCombat(mover) && _isCivilian(ally); // right-of-way
    if (!sameSquad && !soldierHasROW) return;

    // Compute direction mover -> ally tile
    var dir = mover.pos.getDirectionTo(nextPos);
    var back = ((dir + 4 - 1) % 8) + 1;

    var off = [
      [0, 0],
      [0, -1],  // 1: TOP
      [1, -1],  // 2: TOP_RIGHT
      [1, 0],   // 3: RIGHT
      [1, 1],   // 4: BOTTOM_RIGHT
      [0, 1],   // 5: BOTTOM
      [-1, 1],  // 6: BOTTOM_LEFT
      [-1, 0],  // 7: LEFT
      [-1, -1]  // 8: TOP_LEFT
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

    // Try: ally back-step
    var bx = ally.pos.x + off[back][0], by = ally.pos.y + off[back][1];
    if (bx >= 0 && bx <= 49 && by >= 0 && by <= 49) {
      var bpos = new RoomPosition(bx, by, ally.pos.roomName);
      if (_isTileFree(bpos)) { ally.move(back); return; }
    }

    // Try: ally side-step (left/right relative to mover direction)
    var left  = ((dir + 6 - 1) % 8) + 1; // -2
    var right = ((dir + 2 - 1) % 8) + 1; // +2
    var sides = [left, right];
    for (var s = 0; s < sides.length; s++) {
      var sd = sides[s];
      var sx = ally.pos.x + off[sd][0], sy = ally.pos.y + off[sd][1];
      if (sx < 0 || sx > 49 || sy < 0 || sy > 49) continue;
      var spos = new RoomPosition(sx, sy, ally.pos.roomName);
      if (_isTileFree(spos)) { ally.move(sd); return; }
    }
  }

  // -----------------------------
  // Traveler-backed stepToward
  // -----------------------------
  function stepToward(creep, pos, range) {
    if (!creep || !pos) return ERR_NO_PATH;

    // Ret data lets us see the planned next tile so we can coordinate yield in the same tick.
    var retData = {};
    var opts = {
      range: (typeof range === 'number' ? range : 0),
      ignoreCreeps: TRAVELER_DEFAULTS.ignoreCreeps,
      stuckValue: TRAVELER_DEFAULTS.stuckValue,
      repath: TRAVELER_DEFAULTS.repath,
      maxOps: TRAVELER_DEFAULTS.maxOps,
      allowHostile: TRAVELER_DEFAULTS.allowHostile,
      roomCallback: (BeeToolbox && BeeToolbox.roomCallback) ? BeeToolbox.roomCallback : undefined,
      returnData: retData
    };

    // Traveler drives the move; it may flip ignoreCreeps internally when stuck.
    var code = creep.travelTo((pos.pos || pos), opts);

    // If our planned next tile is a friendly civilian, ask them to scoot
    if (retData && retData.nextPos) {
      _politelyYieldFor(creep, retData.nextPos);
    }

    // Lightweight unstick (rare with Traveler, but harmless)
    var mem = creep.memory || (creep.memory = {});
    var stuck = (creep.fatigue === 0 && mem._lx === creep.pos.x && mem._ly === creep.pos.y);
    if (stuck && creep.pos.getRangeTo((pos.pos || pos)) > (opts.range || 0)) {
      _unstickWiggle(creep, (pos.pos || pos));
    }
    mem._lx = creep.pos.x; mem._ly = creep.pos.y;

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
      // Only step onto passable tiles without creeps/solid structs
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

  return API;
})();

module.exports = TaskSquad;
