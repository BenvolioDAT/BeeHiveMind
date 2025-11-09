
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

    // Flag names managed (priority order)
    names: ['SquadAlpha', 'SquadBravo', 'SquadCharlie', 'SquadDelta'],

    // Hard cap (normally just names.length)
    maxFlags: 4
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
    if (!Memory.squadFlags) Memory.squadFlags = { rooms: {}, bindings: {} };
    if (!Memory.squadFlags.rooms) Memory.squadFlags.rooms = {};
    if (!Memory.squadFlags.bindings) Memory.squadFlags.bindings = {};
    return Memory.squadFlags;
  }

  function _ensureSquadMem(id) {
    if (!id) return null;
    if (!Memory.squads) Memory.squads = {};
    if (!Memory.squads[id]) Memory.squads[id] = { targetId: null, targetAt: 0, anchor: null, anchorAt: 0 };
    return Memory.squads[id];
  }

  function _squadIdFromFlagName(name) {
    if (!name) return null;
    if (name.indexOf('Squad_') === 0) return name.substring(6);
    if (name.indexOf('Squad') === 0) return name.substring(5);
    return null;
  }

  function _rememberAnchor(flagName, pos) {
    if (!pos) return;
    var squadId = _squadIdFromFlagName(flagName);
    if (!squadId) return;
    var bucket = _ensureSquadMem(squadId);
    if (!bucket) return;
    bucket.anchor = { x: pos.x, y: pos.y, roomName: pos.roomName };
    bucket.anchor.room = pos.roomName;
    bucket.anchorAt = Game.time;
  }

  function _clearAnchor(flagName) {
    var squadId = _squadIdFromFlagName(flagName);
    if (!squadId || !Memory.squads || !Memory.squads[squadId]) return;
    Memory.squads[squadId].anchor = null;
    Memory.squads[squadId].anchorAt = Game.time;
  }

  // ------------- Helpers -------------

  // Rooms that currently have at least one of YOUR non-scout creeps
  function _roomsWithNonScoutCreeps() {
    var set = {};
    for (var cname in Game.creeps) {
      var c = Game.creeps[cname];
      if (!c || !c.my || !c.memory) continue;
      var tagSource = (c.memory.role != null) ? c.memory.role : c.memory.task;
      var tag = (tagSource || '').toString().toLowerCase();
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

  // PvE-only scoring: never score player structures; only Invader threats.
  function _scoreRoom(room) {
    var s = 0;
    var pos = null;

    // --- Hard bail: if this is a player room, do NOT score it (no PvP) ---
    var ctrl = room.controller;
    if (ctrl) {
      // Owned by someone else (not you), and not the NPC 'Invader' => bail
      if (ctrl.owner && !ctrl.my && ctrl.owner.username !== 'Invader') {
        return { score: 0, pos: null };
      }
      // Reserved by a player (not Invader) => bail
      if (ctrl.reservation &&
          ctrl.reservation.username &&
          ctrl.reservation.username !== 'Invader') {
        return { score: 0, pos: null };
      }
    }

    // --- Score Invader Core (PvE objective) ---
    var cores = room.find(FIND_STRUCTURES, {
      filter: function (st) {
        return st.structureType === STRUCTURE_INVADER_CORE;
      }
    });
    if (cores.length > 0) {
      s += cores.length * CFG.score.invaderCore; // e.g., +15 each
      if (!pos) pos = cores[0].pos;
    }

    // --- Score only INVADER hostile creeps (avoid PvP creeps) ---
    var invaderCreeps = room.find(FIND_HOSTILE_CREEPS, {
      filter: function (c) {
        return c.owner && c.owner.username === 'Invader';
      }
    });
    if (invaderCreeps.length > 0) {
      s += invaderCreeps.length * CFG.score.invaderCreep; // e.g., +5 each
      if (!pos) pos = invaderCreeps[0].pos;
    }

    // --- Score only INVADER towers (skip player towers entirely) ---
    var invaderTowers = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function (st) {
        return st.structureType === STRUCTURE_TOWER &&
              st.owner && st.owner.username === 'Invader';
      }
    });
    if (invaderTowers.length > 0) {
      s += invaderTowers.length * CFG.score.hostileTower; // e.g., +10 each
      if (!pos) pos = invaderTowers[0].pos;
    }

    // --- Score only INVADER spawns (skip player spawns entirely) ---
    var invaderSpawns = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function (st) {
        return st.structureType === STRUCTURE_SPAWN &&
              st.owner && st.owner.username === 'Invader';
      }
    });
    if (invaderSpawns.length > 0) {
      s += invaderSpawns.length * CFG.score.hostileSpawn; // e.g., +6 each
      if (!pos) pos = invaderSpawns[0].pos;
    }

    // Return total threat score and a representative position to drop a Squad* flag near
    return { score: s, pos: pos };
  }

  // Ensure a flag is at a position (idempotent, slight nudge if tile blocked)
  function _ensureFlagAt(name, pos) {
    var f = Game.flags[name];
    if (f) {
      if (f.pos.roomName === pos.roomName && f.pos.x === pos.x && f.pos.y === pos.y) {
        _rememberAnchor(name, f.pos);
        return;
      }
      try { f.remove(); } catch (e) {}
    }
    var rc = pos.roomName && Game.rooms[pos.roomName]
      ? Game.rooms[pos.roomName].createFlag(pos, name)
      : ERR_INVALID_TARGET;

    if (rc !== OK && Game.rooms[pos.roomName]) {
      var i, dx, dy, x, y;
      for (i = 1; i <= 2; i++) {
        for (dx = -i; dx <= i; dx++) {
          for (dy = -i; dy <= i; dy++) {
            if (Math.abs(dx) !== i && Math.abs(dy) !== i) continue;
            x = pos.x + dx; y = pos.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (Game.rooms[pos.roomName].createFlag(x, y, name) === OK) {
              _rememberAnchor(name, new RoomPosition(x, y, pos.roomName));
              return;
            }
          }
        }
      }
    }
    if (rc === OK) {
      _rememberAnchor(name, pos);
    }
  }

  function _removeFlag(name) {
    var f = Game.flags[name];
    if (f) { try { f.remove(); } catch (e) {} }
    _clearAnchor(name);
  }

  // ------------- Core logic -------------
  function ensureSquadFlags() {
    var mem = _mem();
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
    var boundNames = {};
    var nameIdx, fname, boundRoom;

    for (nameIdx = 0; nameIdx < CFG.names.length; nameIdx++) {
      fname = CFG.names[nameIdx];
      boundRoom = mem.bindings[fname];

      if (!boundRoom) continue; // unbound, will assign later

      boundNames[fname] = true;

      var rrec = mem.rooms[boundRoom]; // may be undefined if we never scanned it yet
      var keep = true;

      if (Game.rooms[boundRoom]) {
        // We have vision: drop only if threat has NOT been seen for > dropGrace
        var lastAt = rrec && rrec.lastThreatAt || 0;
        if ((tick - lastAt) > CFG.dropGrace) {
          // Confirmed clear long enough -> remove binding + flag
          _removeFlag(fname);
          delete mem.bindings[fname];
          keep = false;
        }
      }
      if (keep) {
        // Ensure the flag exists and is near the last known threat position (if we have it)
        var pos = (rrec && rrec.lastPos)
          ? new RoomPosition(rrec.lastPos.x, rrec.lastPos.y, rrec.lastPos.roomName)
          : new RoomPosition(25, 25, boundRoom);
        _ensureFlagAt(fname, pos);
        _rememberAnchor(fname, pos);
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
          if (mem.bindings[n2] === rn) { already = true; break; }
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
    var maxN = Math.min(CFG.maxFlags, CFG.names.length);
    var usedCount = 0;
    for (nameIdx = 0; nameIdx < maxN; nameIdx++) {
      fname = CFG.names[nameIdx];
      if (mem.bindings[fname]) { usedCount++; continue; }

      var pick = candidates.shift();
      if (!pick) break;

      mem.bindings[fname] = pick.rn;
      usedCount++;

      // Drop it at last known position (or center as fallback)
      var rec3 = mem.rooms[pick.rn];
      var placePos = (rec3 && rec3.lastPos)
        ? new RoomPosition(rec3.lastPos.x, rec3.lastPos.y, rec3.lastPos.roomName)
        : new RoomPosition(25,25,pick.rn);
      _ensureFlagAt(fname, placePos);
      _rememberAnchor(fname, placePos);
    }

    // 4) Cleanup: remove flags beyond managed list or unconfigured names
    // (Not strictly required if you only use these names.)
    for (var fName in Game.flags) {
      if (!Game.flags.hasOwnProperty(fName)) continue;
      if (CFG.names.indexOf(fName) === -1) continue; // not ours
      // If we somehow ended with a flag present without a binding, keep it only if we rebind it now.
      if (!mem.bindings[fName]) {
        // Unbound and not assigned -> remove to avoid drift
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
