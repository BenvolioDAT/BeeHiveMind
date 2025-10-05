// SquadFlagManager.es5.js (intent-aware version)
// Places squad intent flags (Rally/Assault) on threatened rooms and KEEPS them
// until we SEE the room and confirm the threat is gone for a grace period.
// Only considers rooms with your non-scout creeps. ES5-safe.

'use strict';

var SquadFlagManager = (function () {

  // ------------- Config -------------
  var CFG = {
    // Stagger scanning work: 1 = every tick, 3 = ~1/3 of rooms per tick (by hash)
    scanModulo: 3,

    // Scoring threshold before we consider a room a threat (for assignment)
    minThreatScore: 5,

    // Consider non-Invader hostiles too?
    includeNonInvaderHostiles: false,

    // Threat scoring knobs
    score: {
      invaderCreep: 5,      // per invader creep
      otherHostileCreep: 2, // per non-invader hostile (if enabled)
      invaderCore: 15,      // core present
      hostileTower: 10,     // hostile tower
      hostileSpawn: 6       // hostile spawn
    },

    // Persistence:
    // - We only DROP a bound flag when we have vision AND
    //   (Game.time - lastThreatAt) > dropGrace.
    dropGrace: 50,

    // When assigning an unbound flag, treat rooms as "recently threatened" if
    // last threat was seen within this window (helps with stagger & brief vision gaps).
    assignRecentWindow: 20,

    // Squad IDs managed (priority order)
    squads: ['Alpha', 'Bravo', 'Charlie', 'Delta'],

    // Hard cap (normally just squads.length)
    maxFlags: 4
  };

  // Intent palette so Task.Squad can resolve behavior via Squad.Intents.
  var INTENT_COLOR = {
    ASSAULT: { color: COLOR_RED, secondary: COLOR_RED },
    RALLY: { color: COLOR_WHITE, secondary: COLOR_BLUE }
  };

  // ------------- Memory bucket -------------
  // Memory.squadFlags = {
  //   rooms: {
  //     [roomName]: {
  //       lastSeen: <tick we had vision>,
  //       lastThreatAt: <tick we saw threat>,
  //       lastPos: {x,y,roomName} // last known threat anchor
  //     }
  //   },
  //   bindings: { 'SquadAlpha': 'W1N1', 'SquadBravo': 'W2N3', ... }
  // }
  function _mem() {
    if (!Memory.squadFlags) Memory.squadFlags = { rooms: {}, bindings: {}, version: 0 };
    if (!Memory.squadFlags.rooms) Memory.squadFlags.rooms = {};
    if (!Memory.squadFlags.bindings) Memory.squadFlags.bindings = {};
    return Memory.squadFlags;
  }

  // Legacy bindings used flag names; upgrade them to squad-focused objects once.
  function _upgradeBindings(mem) {
    if (!mem || mem.version >= 1) return;

    var oldBindings = mem.bindings || {};
    var converted = {};
    var key;

    for (key in oldBindings) {
      if (!oldBindings.hasOwnProperty(key)) continue;
      var value = oldBindings[key];
      if (typeof value === 'string') {
        var squadId = key;
        if (squadId.indexOf('Squad') === 0) {
          squadId = squadId.substring(5);
        }
        converted[squadId] = {
          squadId: squadId,
          room: value,
          intent: 'ASSAULT',
          flagName: null,
          lastIntentAt: 0
        };
      } else if (value && value.room) {
        if (!value.squadId) value.squadId = key;
        converted[value.squadId] = value;
      }
    }

    mem.bindings = converted;
    mem.version = 1;
  }

  // Ensure we always have an object to track intent/room for a squad slot.
  function _bindingFor(mem, squadId) {
    var b = mem.bindings[squadId];
    if (!b) {
      b = {
        squadId: squadId,
        room: null,
        intent: 'RALLY',
        flagName: null,
        lastIntentAt: 0
      };
      mem.bindings[squadId] = b;
    }
    return b;
  }

  // Decide the current intent: active threat -> ASSAULT, otherwise stage at RALLY.
  function _intentFor(rec) {
    if (!rec) return 'RALLY';
    if ((rec.lastScore | 0) >= CFG.minThreatScore) return 'ASSAULT';
    return 'RALLY';
  }

  // Prefix names for Task.Squad flag discovery (matches Squad.Intents mappings).
  function _intentFlagName(intent, squadId) {
    if (intent === 'ASSAULT') return 'Assault' + squadId;
    return 'Rally' + squadId;
  }

  // ------------- Helpers -------------

  // Rooms that currently have at least one of YOUR non-scout creeps
  function _roomsWithNonScoutCreeps() {
    var set = {};
    for (var cname in Game.creeps) {
      var c = Game.creeps[cname];
      if (!c || !c.my || !c.memory) continue;
      var tag = (c.memory.task || c.memory.role || '').toString().toLowerCase();
      if (tag === 'scout' || tag.indexOf('scout') === 0) continue;
      set[c.pos.roomName] = true;
    }
    var out = [];
    for (var rn in set) out.push(rn);
    return out;
  }

  // Hash mod to spread scans
  function _roomHashMod(roomName, mod) {
    if (mod <= 1) return 0;
    var h = 0, i;
    for (i = 0; i < roomName.length; i++) h = ((h * 31) + roomName.charCodeAt(i)) | 0;
    return Math.abs(h) % mod;
  }

  // Compute threat score + a representative position (anchor)
  function _scoreRoom(room) {
    if (!room) return { score: 0, pos: null };

    var s = 0;
    var pos = null;

    var hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
    var i, invCount = 0, otherCount = 0;

    for (i = 0; i < hostiles.length; i++) {
      var h = hostiles[i];
      var inv = (h.owner && h.owner.username === 'Invader');
      if (inv) invCount++;
      else if (CFG.includeNonInvaderHostiles) otherCount++;
    }

    if (invCount > 0) {
      s += invCount * CFG.score.invaderCreep;
      if (!pos) {
        for (i = 0; i < hostiles.length; i++) {
          if (hostiles[i].owner && hostiles[i].owner.username === 'Invader') { pos = hostiles[i].pos; break; }
        }
      }
    }
    if (otherCount > 0) {
      s += otherCount * CFG.score.otherHostileCreep;
      if (!pos && hostiles.length) pos = hostiles[0].pos;
    }

    var cores = room.find(FIND_STRUCTURES, { filter: function(s){ return s.structureType===STRUCTURE_INVADER_CORE; } }) || [];
    if (cores.length) {
      s += CFG.score.invaderCore;
      if (!pos) pos = cores[0].pos;
    }

    var towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function(s){ return s.structureType===STRUCTURE_TOWER; } }) || [];
    if (towers.length) {
      s += towers.length * CFG.score.hostileTower;
      if (!pos) pos = towers[0].pos;
    }

    var spawns = room.find(FIND_HOSTILE_STRUCTURES, { filter: function(s){ return s.structureType===STRUCTURE_SPAWN; } }) || [];
    if (spawns.length) {
      s += spawns.length * CFG.score.hostileSpawn;
      if (!pos) pos = spawns[0].pos;
    }

    if (!pos) pos = new RoomPosition(25, 25, room.name);
    return { score: s, pos: pos };
  }

  // Ensure a flag is at a position (idempotent, slight nudge if tile blocked)
  // Maintain (or create) a flag at the desired anchor with the correct intent colors.
  function _ensureFlagAt(name, pos, intent) {
    var colors = INTENT_COLOR[intent] || INTENT_COLOR.RALLY;
    var f = Game.flags[name];
    if (f) {
      if (colors && (f.color !== colors.color || f.secondaryColor !== colors.secondary)) {
        try { f.setColor(colors.color, colors.secondary); } catch (e) {}
      }
      if (f.pos.roomName === pos.roomName && f.pos.x === pos.x && f.pos.y === pos.y) return;
      try {
        f.setPosition(pos);
        return;
      } catch (errSet) {
        try { f.remove(); } catch (errRem) {}
      }
    }
    var rc = pos.roomName && Game.rooms[pos.roomName]
      ? Game.rooms[pos.roomName].createFlag(pos, name, colors.color, colors.secondary)
      : ERR_INVALID_TARGET;

    if (rc !== OK && Game.rooms[pos.roomName]) {
      var i, dx, dy, x, y;
      for (i = 1; i <= 2; i++) {
        for (dx = -i; dx <= i; dx++) {
          for (dy = -i; dy <= i; dy++) {
            if (Math.abs(dx) !== i && Math.abs(dy) !== i) continue;
            x = pos.x + dx; y = pos.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (Game.rooms[pos.roomName].createFlag(x, y, name, colors.color, colors.secondary) === OK) return;
          }
        }
      }
    }
  }

  function _removeFlag(name) {
    var f = Game.flags[name];
    if (f) { try { f.remove(); } catch (e) {} }
  }

  // ------------- Core logic -------------
  function ensureSquadFlags() {
    var mem = _mem();
    _upgradeBindings(mem);
    var tick = Game.time | 0;

    // 1) Scan rooms where we have non-scout creeps (staggered)
    var rooms = _roomsWithNonScoutCreeps();
    for (var r = 0; r < rooms.length; r++) {
      var rn = rooms[r];
      var room = Game.rooms[rn];
      if (!room) continue; // no vision; do not change any state

      if ((tick + _roomHashMod(rn, 4)) % (CFG.scanModulo || 1)) continue; // stagger

      var info = _scoreRoom(room);
      var rec = mem.rooms[rn] || (mem.rooms[rn] = { lastSeen: 0, lastThreatAt: 0, lastPos: null, lastScore: 0 });

      rec.lastSeen = tick;
      rec.lastScore = info.score | 0;
      if (info.score >= CFG.minThreatScore) {
        rec.lastThreatAt = tick;
        rec.lastPos = { x: info.pos.x, y: info.pos.y, roomName: info.pos.roomName };
      } else {
        // still keep lastThreatAt; we only drop after dropGrace with vision (handled below)
        // update lastPos to center if we have nothing better
        if (!rec.lastPos) rec.lastPos = { x: 25, y: 25, roomName: rn };
      }
      mem.rooms[rn] = rec;
    }

    // 2) Maintain existing bindings (flags already assigned to rooms)
    var nameIdx, squadId, binding;

    for (nameIdx = 0; nameIdx < CFG.squads.length; nameIdx++) {
      squadId = CFG.squads[nameIdx];
      binding = _bindingFor(mem, squadId);
      if (!binding.room) continue;

      var rrec = mem.rooms[binding.room];
      var keep = true;

      if (Game.rooms[binding.room]) {
        var lastAt = rrec && rrec.lastThreatAt || 0;
        if ((tick - lastAt) > CFG.dropGrace) {
          if (binding.flagName) { _removeFlag(binding.flagName); }
          binding.room = null;
          binding.flagName = null;
          keep = false;
        }
      }
      if (keep) {
        // Refresh intent based on current intel so squads switch between staging and pushing.
        var intent = _intentFor(rrec);
        if (binding.intent !== intent) {
          binding.intent = intent;
          binding.lastIntentAt = tick;
          if (binding.flagName && binding.flagName !== _intentFlagName(intent, squadId)) {
            _removeFlag(binding.flagName);
            binding.flagName = null;
          }
        }
        var pos = (rrec && rrec.lastPos)
          ? new RoomPosition(rrec.lastPos.x, rrec.lastPos.y, rrec.lastPos.roomName)
          : new RoomPosition(25, 25, binding.room);
        var desiredName = _intentFlagName(binding.intent, squadId);
        _ensureFlagAt(desiredName, pos, binding.intent);
        binding.flagName = desiredName;
      }
    }

    // 3) Assign unbound flags to the strongest unbound recent threats
    // Gather candidate rooms: seen a threat recently (within assignRecentWindow) and not already bound
    var candidates = [];
    var now = tick;
    for (var rn in mem.rooms) {
      if (!mem.rooms.hasOwnProperty(rn)) continue;
      var rec2 = mem.rooms[rn];
      if (!rec2 || typeof rec2.lastThreatAt !== 'number') continue;
      if ((now - rec2.lastThreatAt) <= CFG.assignRecentWindow) {
        // Avoid double-binding: if already bound by any flag, skip
        var already = false;
        for (var n2 in mem.bindings) {
          if (!mem.bindings.hasOwnProperty(n2)) continue;
          var bindRec = mem.bindings[n2];
          var boundRoom = null;
          if (!bindRec) boundRoom = null;
          else if (typeof bindRec === 'string') boundRoom = bindRec;
          else boundRoom = bindRec.room;
          if (boundRoom === rn) { already = true; break; }
        }
        if (!already) {
          // Prefer rooms that were seen more recently; tie-break by lastThreatAt
          candidates.push({ rn: rn, lastSeen: rec2.lastSeen | 0, lastThreatAt: rec2.lastThreatAt | 0 });
        }
      }
    }

    // Sort: newest threat first, then newest vision
    candidates.sort(function(a,b){
      if (b.lastThreatAt !== a.lastThreatAt) return b.lastThreatAt - a.lastThreatAt;
      return b.lastSeen - a.lastSeen;
    });

    // Assign each unbound flag up to maxFlags
    var maxN = Math.min(CFG.maxFlags, CFG.squads.length);
    for (nameIdx = 0; nameIdx < maxN; nameIdx++) {
      squadId = CFG.squads[nameIdx];
      binding = _bindingFor(mem, squadId);
      if (binding.room) continue;

      var pick = candidates.shift();
      if (!pick) break;

      binding.room = pick.rn;
      binding.intent = 'ASSAULT';
      binding.lastIntentAt = tick;
      binding.flagName = null;

      // Spawn a fresh Assault flag so the squad knows to mobilize immediately.
      var rec3 = mem.rooms[pick.rn];
      var placePos = (rec3 && rec3.lastPos)
        ? new RoomPosition(rec3.lastPos.x, rec3.lastPos.y, rec3.lastPos.roomName)
        : new RoomPosition(25,25,pick.rn);
      var desired = _intentFlagName('ASSAULT', squadId);
      _ensureFlagAt(desired, placePos, 'ASSAULT');
      binding.flagName = desired;
    }

    // 4) Cleanup: remove flags beyond managed list or unconfigured names
    // (Not strictly required if you only use these names.)
    var allowed = {};
    var legacy = {};
    for (nameIdx = 0; nameIdx < CFG.squads.length; nameIdx++) {
      squadId = CFG.squads[nameIdx];
      allowed['Rally' + squadId] = true;
      allowed['Assault' + squadId] = true;
      legacy['Squad' + squadId] = true;
    }

    for (var fName in Game.flags) {
      if (!Game.flags.hasOwnProperty(fName)) continue;
      // Clear legacy static flags so new intent-aware markers do not conflict.
      if (legacy[fName] && !allowed[fName]) { _removeFlag(fName); continue; }
      if (!allowed[fName]) continue;
      var stillBound = false;
      for (nameIdx = 0; nameIdx < CFG.squads.length; nameIdx++) {
        squadId = CFG.squads[nameIdx];
        binding = mem.bindings[squadId];
        if (binding && binding.flagName === fName) { stillBound = true; break; }
      }
      if (!stillBound) {
        _removeFlag(fName);
      }
    }

    // Optional: prune ancient room records (keeps Memory tidy)
    for (var k in mem.rooms) {
      if (!mem.rooms.hasOwnProperty(k)) continue;
      if ((tick - (mem.rooms[k].lastSeen | 0)) > 20000) delete mem.rooms[k];
    }
  }

  return {
    ensureSquadFlags: ensureSquadFlags
  };
})();

module.exports = SquadFlagManager;
