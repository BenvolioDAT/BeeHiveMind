// Task.Squad.js — lightweight squad brain (ES5-safe)
'use strict';

var TaskSquad = (function () {
  var API = {};

  // --- Tunables (kept tiny; roles still do their own micro) ---
  var TARGET_STICKY = 12;          // shared target re-eval window
  var RALLY_FLAG_PREFIX = 'Squad'; // e.g. "SquadAlpha"
  var MAX_TARGET_RANGE = 30;       // don't pick targets across the planet
  var HEALER_WEIGHT = -500, RANGED_WEIGHT = -260, MELEE_WEIGHT = -140, HURT_WEIGHT = -160, TOUGH_PENALTY = +25;

  function getSquadId(creep) {
    return creep.memory && creep.memory.squadId || 'Alpha';
  }

  function ensureBucket(id) {
    if (!Memory.squads) Memory.squads = {};
    if (!Memory.squads[id]) Memory.squads[id] = { targetId: null, targetAt: 0, anchor: null, anchorAt: 0 };
    return Memory.squads[id];
  }

  function rallyFlagFor(id) {
    // "SquadAlpha" or "Squad_Beta" both okay; try simple prefix+name
    return Game.flags[RALLY_FLAG_PREFIX + id] || Game.flags[RALLY_FLAG_PREFIX + '_' + id] || Game.flags[id] || null;
  }

  // ---- Target selection shared by the squad ----
  function isGood(obj) {
    return obj && obj.hits != null && obj.hits > 0 && obj.pos && obj.pos.roomName;
  }

  function scoreHostile(me, h) {
    var dist = me.pos.getRangeTo(h);
    var healer = h.getActiveBodyparts(HEAL) > 0 ? HEALER_WEIGHT : 0;
    var ranged = h.getActiveBodyparts(RANGED_ATTACK) > 0 ? RANGED_WEIGHT : 0;
    var melee  = h.getActiveBodyparts(ATTACK) > 0 ? MELEE_WEIGHT : 0;
    var tough  = h.getActiveBodyparts(TOUGH) > 0 ? TOUGH_PENALTY : 0;
    var hurt   = (1 - h.hits / h.hitsMax) * HURT_WEIGHT;
    return healer + ranged + melee + tough + hurt + dist;
  }

  function chooseRoomTarget(me) {
    var room = me.room;
    if (!room) return null;

    var hostiles = room.find(FIND_HOSTILE_CREEPS);
    if (hostiles.length) {
      var scored = _.map(hostiles, function (h) { return { h: h, s: scoreHostile(me, h) }; });
      var best = _.min(scored, 's');
      return best && best.h || null;
    }

    // fallback to priority structures
    var prio = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s) {
      return s.structureType === STRUCTURE_TOWER || s.structureType === STRUCTURE_SPAWN;
    }});
    if (prio.length) return me.pos.findClosestByRange(prio);

    var others = room.find(FIND_HOSTILE_STRUCTURES);
    return others.length ? me.pos.findClosestByRange(others) : null;
  }

  function sharedTarget(creep) {
    var id = getSquadId(creep);
    var S = ensureBucket(id);

    // still valid & sticky?
    if (S.targetId && Game.time - (S.targetAt || 0) <= TARGET_STICKY) {
      var obj = Game.getObjectById(S.targetId);
      if (isGood(obj) && creep.pos.getRangeTo(obj) <= MAX_TARGET_RANGE) return obj;
    }

    var t = chooseRoomTarget(creep);
    if (t) {
      S.targetId = t.id;
      S.targetAt = Game.time;
      return t;
    }

    // no target in room; clear
    S.targetId = null;
    S.targetAt = Game.time;
    return null;
  }

  // ---- Anchor / formation helpers ----
  function getAnchor(creep) {
    var id = getSquadId(creep);
    var S = ensureBucket(id);
    // prefer explicit rally flag
    var f = rallyFlagFor(id);
    if (f) {
      S.anchor = { x: f.pos.x, y: f.pos.y, room: f.pos.roomName };
      S.anchorAt = Game.time;
      return f.pos;
    }
    // if no flag, use the first melee (vanguard) or the lowest creep name as leader
    var names = Object.keys(Game.creeps).sort();
    var leader = null;
    for (var i = 0; i < names.length; i++) {
      var c = Game.creeps[names[i]];
      if (!c || !c.memory) continue;
      if (c.memory.squadId === id && (c.memory.task === 'CombatMelee' || c.memory.role === 'CombatMelee')) {
        leader = c; break;
      }
    }
    if (!leader) {
      for (i = 0; i < names.length; i++) {
        c = Game.creeps[names[i]];
        if (c && c.memory && c.memory.squadId === id) { leader = c; break; }
      }
    }
    if (leader && leader.pos) {
      S.anchor = { x: leader.pos.x, y: leader.pos.y, room: leader.pos.roomName };
      S.anchorAt = Game.time;
      return leader.pos;
    }
    return null;
  }

  // Friendly swap: if ally blocks our next step and would benefit from swapping, trade tiles
  function tryFriendlySwap(mover, nextPos) {
    if (!nextPos) return false;
    var blockers = nextPos.lookFor(LOOK_CREEPS);
    if (!blockers || !blockers.length) return false;
    var ally = blockers[0];
    if (!ally.my) return false;
    // same squad? great → swap
    if (ally.memory && mover.memory && ally.memory.squadId && ally.memory.squadId === mover.memory.squadId) {
      var dir = mover.pos.getDirectionTo(nextPos);
      var back = (dir + 4) % 8;
      // ask ally to move off first (best effort)
      ally.move(back);
      mover.move(dir);
      return true;
    }
    return false;
  }

  // One step toward a pos with optional swap
  function stepToward(creep, pos, range) {
    if (!pos) return ERR_NO_PATH;
    var res = creep.moveTo(pos, { range: range, reusePath: 10, maxRooms: 2, maxOps: 2000, plainCost: 2, swampCost: 6 });
    if (res !== OK) {
      // try one raw-direction step w/ swap
      var dir = creep.pos.getDirectionTo(pos);
      var dx = creep.pos.x + (dir === RIGHT || dir === TOP_RIGHT || dir === BOTTOM_RIGHT ? 1 : (dir === LEFT || dir === TOP_LEFT || dir === BOTTOM_LEFT ? -1 : 0));
      var dy = creep.pos.y + (dir === BOTTOM || dir === BOTTOM_LEFT || dir === BOTTOM_RIGHT ? 1 : (dir === TOP || dir === TOP_LEFT || dir === TOP_RIGHT ? -1 : 0));
      if (dx >= 0 && dx <= 49 && dy >= 0 && dy <= 49) {
        var np = new RoomPosition(dx, dy, creep.pos.roomName);
        if (!tryFriendlySwap(creep, np)) creep.move(dir);
      }
    }
    return res;
  }

  API.getSquadId = getSquadId;
  API.sharedTarget = sharedTarget;
  API.getAnchor = getAnchor;
  API.stepToward = stepToward;
  API.tryFriendlySwap = tryFriendlySwap;
  return API;
})();

module.exports = TaskSquad;
