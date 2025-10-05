// SquadFlagManager.es5.js (sticky version)
// Places SquadAlpha/Bravo/Charlie/Delta on threatened rooms and KEEPS them
// until we SEE the room and confirm the threat is gone for a grace period.
// Only considers rooms with your non-scout creeps. ES5-safe.


'use strict';

var SquadIntents = require('Squad.Intents.es5');
var ThreatAnalyzer = require('Combat.ThreatAnalyzer.es5');

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

  var DEFAULT_INTENT = SquadIntents && SquadIntents.DEFAULT_INTENT ? SquadIntents.DEFAULT_INTENT : 'RALLY';

  // ------------- Memory bucket -------------
  // Memory.squadFlags = {
  //   rooms: {
  //     [roomName]: {
  //       lastSeen: <tick we had vision>,
  //       lastThreatAt: <tick we saw threat>,
  //       lastScore: <cached threat score>,
  //       lastPos: {x,y,roomName} // last known threat anchor,
  //       lastIntent: <recommended squad intent>,
  //       lastTags: <lightweight threat tags>
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

  // ------------- Helpers -------------

  // Look up the color pairing for a squad intent so we keep flags synchronized
  function _colorsForIntent(intent) {
    var fallback = { color: COLOR_WHITE, secondary: COLOR_BLUE };
    if (!SquadIntents || !SquadIntents.FLAG_RULES) return fallback;
    var rules = SquadIntents.FLAG_RULES;
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].intent === intent) {
        return { color: rules[i].color, secondary: rules[i].secondaryColor };
      }
    }
    return fallback;
  }

  // Basic heuristics: breach when fortifications + towers present, kite for high micro threat, assault otherwise
  function _recommendIntent(tags) {
    if (!tags) return DEFAULT_INTENT;
    if (tags.hasFortress) return 'BREACH';
    if (tags.towers > 0 || tags.spawns > 0 || tags.invaderCore) return 'ASSAULT';
    if (tags.healers > 0 || tags.ranged > 0) return 'KITE';
    if (tags.hostiles > 0) return 'ASSAULT';
    return DEFAULT_INTENT;
  }

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
    if (!room) {
      return { score: 0, pos: null, tags: {}, intent: DEFAULT_INTENT };
    }

    var s = 0;
    var pos = null;
    // Build a light threat profile so we can color the flag with the right intent hint
    var tags = {
      hostiles: 0,
      invaders: 0,
      others: 0,
      healers: 0,
      ranged: 0,
      melee: 0,
      towers: 0,
      spawns: 0,
      invaderCore: false,
      ramparts: 0,
      walls: 0,
      hasFortress: false,
    };

    var hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
    var i, invCount = 0, otherCount = 0;
    for (i = 0; i < hostiles.length; i++) {
      var h = hostiles[i];
      if (!h) continue;
      var inv = (h.owner && h.owner.username === 'Invader');
      if (inv) invCount++;
      else if (CFG.includeNonInvaderHostiles) otherCount++;

      // Count combat part types so we can distinguish kite vs push scenarios
      var hasHeal = false;
      var hasRanged = false;
      var hasMelee = false;
      var body = h.body || [];
      for (var b = 0; b < body.length; b++) {
        var part = body[b];
        if (!part || part.hits <= 0) continue;
        if (part.type === HEAL) hasHeal = true;
        else if (part.type === RANGED_ATTACK) hasRanged = true;
        else if (part.type === ATTACK) hasMelee = true;
      }
      if (hasHeal) tags.healers++;
      if (hasRanged) tags.ranged++;
      if (hasMelee) tags.melee++;

      if (!pos) pos = h.pos;
    }
    tags.hostiles = hostiles.length;
    tags.invaders = invCount;
    tags.others = otherCount;

    if (invCount > 0) {
      s += invCount * CFG.score.invaderCreep;
    }
    if (otherCount > 0) {
      s += otherCount * CFG.score.otherHostileCreep;
    }

    var cores = room.find(FIND_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_INVADER_CORE; } }) || [];
    if (cores.length) {
      s += CFG.score.invaderCore;
      tags.invaderCore = true;
      if (!pos) pos = cores[0].pos;
    }

    var towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_TOWER; } }) || [];
    tags.towers = towers.length;
    if (towers.length) {
      s += towers.length * CFG.score.hostileTower;
      if (!pos) pos = towers[0].pos;
    }

    var spawns = room.find(FIND_HOSTILE_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_SPAWN; } }) || [];
    tags.spawns = spawns.length;
    if (spawns.length) {
      s += spawns.length * CFG.score.hostileSpawn;
      if (!pos) pos = spawns[0].pos;
    }

    // Pull cached fortress data so we do not rescan ramparts/walls every tick
    var intel = ThreatAnalyzer && ThreatAnalyzer.getIntel ? ThreatAnalyzer.getIntel(room.name) : null;
    if (intel && intel.ramparts && intel.ramparts.length) tags.ramparts = intel.ramparts.length;
    if (intel && intel.walls && intel.walls.length) tags.walls = intel.walls.length;
    if (!intel) {
      var ramps = room.find(FIND_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_RAMPART && !s.my; } }) || [];
      var walls = room.find(FIND_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_WALL; } }) || [];
      tags.ramparts = ramps.length;
      tags.walls = walls.length;
    }

    tags.hasFortress = (tags.ramparts > 0) && (tags.towers > 0 || tags.spawns > 0);

    var intent = _recommendIntent(tags);

    if (!pos) pos = new RoomPosition(25, 25, room.name);
    return { score: s, pos: pos, tags: tags, intent: intent };
  }

  // Ensure a flag is at a position (idempotent, slight nudge if tile blocked)
  function _ensureFlagAt(name, pos, intent, tags) {
    var f = Game.flags[name];
    var colors = _colorsForIntent(intent || DEFAULT_INTENT);
    if (f) {
      // If intent changed we repaint the flag so Task.Squad picks up the new marching orders
      if ((f.color !== colors.color) || (f.secondaryColor !== colors.secondary)) {
        try { f.setColor(colors.color, colors.secondary); } catch (errSet) {} // Screeps docs: Flag.setColor(primary, secondary)
      }
      if (intent) {
        f.memory = f.memory || {};
        f.memory.intent = intent;
      }
      if (tags) {
        f.memory = f.memory || {};
        f.memory.lastTags = tags;
      }
      if (f.pos.roomName === pos.roomName && f.pos.x === pos.x && f.pos.y === pos.y) return;
      try { f.remove(); } catch (e) {}
    }
    var rc = pos.roomName && Game.rooms[pos.roomName]
      ? Game.rooms[pos.roomName].createFlag(pos, name, colors.color, colors.secondary) // Screeps docs: Room.createFlag(pos, name, color, secondary)
      : ERR_INVALID_TARGET;

    if (rc !== OK && Game.rooms[pos.roomName]) {
      var i, dx, dy, x, y;
      for (i = 1; i <= 2; i++) {
        for (dx = -i; dx <= i; dx++) {
          for (dy = -i; dy <= i; dy++) {
            if (Math.abs(dx) !== i && Math.abs(dy) !== i) continue;
            x = pos.x + dx; y = pos.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (Game.rooms[pos.roomName].createFlag(x, y, name, colors.color, colors.secondary) === OK) {
              var placed = Game.flags[name];
              if (placed) {
                placed.memory = placed.memory || {};
                if (intent) placed.memory.intent = intent;
                if (tags) placed.memory.lastTags = tags;
              }
              return;
            }
          }
        }
      }
    }

    if (rc === OK) {
      var nf = Game.flags[name];
      if (nf) {
        nf.memory = nf.memory || {};
        if (intent) nf.memory.intent = intent;
        if (tags) nf.memory.lastTags = tags;
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
    var tick = Game.time | 0;

    // 1) Scan rooms where we have non-scout creeps (staggered)
    var rooms = _roomsWithNonScoutCreeps();
    for (var r = 0; r < rooms.length; r++) {
      var rn = rooms[r];
      var room = Game.rooms[rn];
      if (!room) continue; // no vision; do not change any state

      if ((tick + _roomHashMod(rn, 4)) % (CFG.scanModulo || 1)) continue; // stagger

      var info = _scoreRoom(room);
      var rec = mem.rooms[rn];
      if (!rec) {
        rec = {
          lastSeen: 0,
          lastThreatAt: 0,
          lastPos: null,
          lastScore: 0,
          lastIntent: DEFAULT_INTENT,
          lastIntentAt: 0,
          lastTags: null,
        };
        mem.rooms[rn] = rec;
      }

      rec.lastSeen = tick;
      rec.lastScore = info.score | 0;
      // Cache the suggested intent so other modules (and future ticks without vision) can stay aligned
      rec.lastIntent = info.intent || DEFAULT_INTENT;
      rec.lastIntentAt = tick;
      rec.lastTags = info.tags || null;
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
        var intent = rrec && rrec.lastIntent ? rrec.lastIntent : DEFAULT_INTENT;
        var tags = rrec && rrec.lastTags ? rrec.lastTags : null;
        _ensureFlagAt(fname, pos, intent, tags);
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
      var intentNew = rec3 && rec3.lastIntent ? rec3.lastIntent : DEFAULT_INTENT;
      var tagsNew = rec3 && rec3.lastTags ? rec3.lastTags : null;
      _ensureFlagAt(fname, placePos, intentNew, tagsNew);
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
