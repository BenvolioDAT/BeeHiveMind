/**
 * role.CombatMelee.js — PvE melee vanguard with defensive/escort behaviors for Bee squads.
 *
 * Pipeline position: Decide → Act → Move. Melee listens to BeeCombatSquads decisions
 * (shared targets, anchors), executes close-combat actions, and moves via squad-aware
 * pathing helpers.
 *
 * Inputs: creep.memory (state, wait timers, squadId, stickTargetId, etc.), BeeCombatSquads
 * sharedTarget/getAnchor, BeeToolbox medic waiting heuristic, Game flags. Outputs:
 * melee attacks, structure demolition, escort positioning, and healing actions (when
 * body includes HEAL) along with Memory updates for squad logging.
 *
 * Collaborations: BeeCombatSquads.js coordinates movement/targets; SquadFlagManager.js
 * supplies anchors; role.CombatArcher.js and role.CombatMedic.js depend on melee to hold
 * front lines, soak damage, and open paths (door bash). This role ensures medics have
 * cover by interposing and kiting threats away.
 */

var BeeToolbox = require('BeeToolbox');
var BeeCombatSquads  = require('BeeCombatSquads');
var CoreConfig = require('core.config');

/**
 * _isInvaderCreep
 *
 * @param {Creep} c Candidate hostile.
 * @return {boolean} True when owned by Invader NPC.
 */
function _isInvaderCreep(c) {
  if (BeeToolbox && BeeToolbox.isNpcHostileCreep) return BeeToolbox.isNpcHostileCreep(c);
  return !!(c && c.owner && c.owner.username === 'Invader');
}

/**
 * _isInvaderStruct
 *
 * @param {Structure} s Candidate structure.
 * @return {boolean} True when owned by Invader NPC.
 */
function _isInvaderStruct(s) {
  if (BeeToolbox && BeeToolbox.isNpcHostileStruct) return BeeToolbox.isNpcHostileStruct(s);
  return !!(s && s.owner && s.owner.username === 'Invader');
}

/**
 * _isInvaderTarget
 *
 * @param {RoomObject} t Potential attack target.
 * @return {boolean} True when target is Invader creep/structure or core.
 */
function _isInvaderTarget(t){
  if (!t) return false;
  if (BeeToolbox && BeeToolbox.isNpcTarget) return BeeToolbox.isNpcTarget(t);
  if (t.owner && t.owner.username) return t.owner.username === 'Invader';
  if (t.structureType === STRUCTURE_INVADER_CORE) return true;
  return false;
}

function _isValidHostileTarget(obj) {
  if (!obj || !obj.hits || obj.hits <= 0) return false;
  var ownerName = obj.owner && obj.owner.username ? obj.owner.username : '';

  if (BeeToolbox && BeeToolbox.isNpcHostileOwner && BeeToolbox.isNpcHostileOwner(ownerName)) {
    return true;
  }

  if (BeeToolbox && BeeToolbox.isAlly && BeeToolbox.isAlly(ownerName)) {
    return false;
  }

  var me = _myUsername();
  if (me && ownerName && ownerName === me) {
    return false;
  }

  if (!ownerName) {
    return true;
  }

  if (BeeToolbox && BeeToolbox.isFriendlyObject && BeeToolbox.isFriendlyObject(obj)) {
    return false;
  }

  if (CoreConfig && CoreConfig.ALLOW_PVP === false) {
    return false;
  }

  return true;
}

function _isAllyTarget(t){
  if (!t || !t.owner || !t.owner.username) return false;
  if (BeeToolbox && BeeToolbox.isFriendlyObject) return BeeToolbox.isFriendlyObject(t);
  if (BeeToolbox && BeeToolbox.isFriendlyUsername) return BeeToolbox.isFriendlyUsername(t.owner.username);
  return t.owner.username === _myUsername();
}

function _canMeleeEngage(creep, target){
  if (!creep || !target) return false;
  if (_isAllyTarget(target)) return false;
  if (BeeToolbox && BeeToolbox.canEngageTarget) return BeeToolbox.canEngageTarget(creep, target);
  if (_isInvaderTarget(target)) return true;
  if (target.owner && target.owner.username) {
    return target.owner.username !== _myUsername();
  }
  return true;
}

function _safeAttack(creep, target){
  if (!creep || !target) return ERR_INVALID_TARGET;
  if (!_canMeleeEngage(creep, target)) return ERR_INVALID_TARGET;
  return creep.attack(target);
}

// ==========================
// Config
// ==========================
var CONFIG = {
  focusSticky: 15,
  fleeHpPct: 0.35,
  towerAvoidRadius: 20,
  maxRooms: 2,
  reusePath: 10,
  maxOps: 2000,
  waitForMedic: true,
  waitTimeout: 25,
  doorBash: true,
  edgePenalty: 8,

  // Debug
  DEBUG_SAY: true,
  DEBUG_DRAW: true,
  DEBUG_LOG: false,

  COLORS: {
    PATH:   "#7ac7ff",
    ATTACK: "#ffb74d",
    FLEE:   "#ff5c7a",
    BUDDY:  "#ffd54f",
    TOWER:  "#f0c040",
    TEXT:   "#f2f2f2",
    DANGER: "#ff9e80",
    COVER:  "#90caf9",
    TARGET: "#ffa726"
  },
  WIDTH: 0.13,
  OPAC:  0.45,
  FONT:  0.7
};

// ==========================
// Debug helpers
// ==========================
function _posOf(t){ return t && t.pos ? t.pos : t; }
function _roomOf(p){ return p && Game.rooms[p.roomName]; }

function debugSay(creep, msg){
  if (CONFIG.DEBUG_SAY && creep && creep.say) creep.say(msg, true);
}
function debugLine(from, to, color){
  if (!CONFIG.DEBUG_DRAW || !from || !to) return;
  var f=_posOf(from), t=_posOf(to); if(!f||!t||f.roomName!==t.roomName) return;
  var R=_roomOf(f); if(!R||!R.visual) return;
  R.visual.line(f, t, { color: color, width: CONFIG.WIDTH, opacity: CONFIG.OPAC });
}
function debugRing(target, color, text, radius){
  if (!CONFIG.DEBUG_DRAW || !target) return;
  var p=_posOf(target); if(!p) return;
  var R=_roomOf(p); if(!R||!R.visual) return;
  R.visual.circle(p, { radius: radius!=null?radius:0.6, fill:"transparent", stroke: color, opacity: CONFIG.OPAC, width: CONFIG.WIDTH });
  if (text) R.visual.text(text, p.x, p.y-0.8, { color: color, font: CONFIG.FONT, opacity: 0.95, align:"center" });
}

var _myNameTick = -1;
var _myNameCache = null;
/**
 * _myUsername — cached lookup of player username.
 *
 * @return {string|null} Username of the controlling player.
 */
function _myUsername(){
  if (Game.time === _myNameTick && _myNameCache !== null) return _myNameCache;
  _myNameTick = Game.time;
  _myNameCache = null;
  var k;
  for (k in Game.spawns){
    if (!Game.spawns.hasOwnProperty(k)) continue;
    var s = Game.spawns[k];
    if (s && s.owner && s.owner.username){
      _myNameCache = s.owner.username;
      return _myNameCache;
    }
  }
  for (k in Game.rooms){
    if (!Game.rooms.hasOwnProperty(k)) continue;
    var r = Game.rooms[k];
    if (r && r.controller && r.controller.my && r.controller.owner && r.controller.owner.username){
      _myNameCache = r.controller.owner.username;
      return _myNameCache;
    }
  }
  return _myNameCache;
}

/**
 * _roomIsForeign
 *
 * @param {Room} room Room to inspect.
 * @return {boolean} True when owned/reserved by non-Invader players (PvP zone).
 */
function _roomIsForeign(room){
  if (!room || !room.controller) return false;
  var ctrl = room.controller;
  if (ctrl.my) return false;
  if (ctrl.owner && ctrl.owner.username && ctrl.owner.username !== 'Invader') return true;
  if (ctrl.reservation && ctrl.reservation.username){
    var me = _myUsername();
    if (ctrl.reservation.username !== 'Invader' && (!me || ctrl.reservation.username !== me)) return true;
  }
  return false;
}

/**
 * _maybeSay — throttled say helper to avoid spamming HUD bubbles.
 *
 * @param {Creep} creep Actor creep.
 * @param {string} msg Message to display.
 */
function _maybeSay(creep, msg){
  if (!creep || !creep.say || !creep.memory) return;
  var last = creep.memory._mmSayAt || 0;
  if ((Game.time - last) >= 8){
    creep.say(msg, true);
    creep.memory._mmSayAt = Game.time;
  }
}

/**
 * _logSquadSample — writes periodic logs for debugging squad behavior.
 *
 * @param {Creep} creep Actor creep.
 * @param {string} squadId Squad identifier.
 * @param {RoomObject|null} target Current target.
 * @param {RoomPosition|null} anchor Current rally anchor.
 * @param {string} keySuffix Optional suffix to differentiate roles.
 */
function _logSquadSample(creep, squadId, target, anchor, keySuffix){
  if (!Memory || !Memory.squads) return;
  var S = Memory.squads[squadId];
  if (!S) return;
  var field = keySuffix ? ('logger_' + keySuffix) : 'logger';
  if (!S[field] || !Game.creeps[S[field]]) S[field] = creep.name;
  if (S[field] !== creep.name) return;
  if (Game.time % 25 !== 0) return;
  var anchorStr = 'none';
  if (anchor && anchor.x != null && anchor.y != null && anchor.roomName){
    anchorStr = anchor.x + ',' + anchor.y + '/' + anchor.roomName;
  }
  var targetId = (target && target.id) ? target.id : 'none';
  console.log('[SquadLog]', squadId, creep.name, (keySuffix || 'melee'), 'target', targetId, 'anchor', anchorStr);
}

/**
 * _fallbackStructureTarget — choose structures when no invader creeps remain.
 *
 * @param {Creep} creep Melee creep.
 * @param {string} myName Player username to avoid friendly fire.
 * @return {Structure|null} Invader structure to attack.
 */
function _fallbackStructureTarget(creep, myName){
  if (!creep || !creep.room) return null;
  var room = creep.room;
  var types = [STRUCTURE_INVADER_CORE, STRUCTURE_TOWER, STRUCTURE_SPAWN];
  var structures = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s){
    var j;
    if (!s || !s.hits || s.hits <= 0) return false;
    if (s.structureType === STRUCTURE_CONTROLLER) return false;
    if (s.owner && s.owner.username && myName && s.owner.username === myName) return false;
    if (BeeToolbox && BeeToolbox.isFriendlyObject && BeeToolbox.isFriendlyObject(s)) return false;
    if (!_canMeleeEngage(creep, s)) return false;
    for (j = 0; j < types.length; j++){
      if (s.structureType === types[j]) return true;
    }
    return _isInvaderStruct(s);
  }});
  if (structures && structures.length) {
    return creep.pos.findClosestByRange(structures) || structures[0];
  }
  var cores = room.find(FIND_STRUCTURES, { filter: function (s){
    return s && s.structureType === STRUCTURE_INVADER_CORE && s.hits > 0;
  }});
  if (cores && cores.length){
    return creep.pos.findClosestByRange(cores) || cores[0];
  }
  return null;
}

/**
 * moveSmart — wrapper around BeeCombatSquads pathing for consistent squad motion.
 *
 * @param {Creep} creep Moving melee creep.
 * @param {RoomObject|RoomPosition} dest Destination.
 * @param {number} range Desired stopping range.
 * @return {number} Movement result code.
 */
function moveSmart(creep, dest, range){
  var d = _posOf(dest) || dest;
  if (creep.pos.roomName === d.roomName && creep.pos.getRangeTo(d) > (range||1)){
    debugLine(creep.pos, d, CONFIG.COLORS.PATH);
  }
  if (BeeCombatSquads && typeof BeeCombatSquads.stepToward === 'function'){
    return BeeCombatSquads.stepToward(creep, d, range);
  }
  return creep.moveTo(d, { reusePath: CONFIG.reusePath, maxOps: CONFIG.maxOps });
}

// ==========================
// Core
// ==========================
var roleCombatMelee = {
  role: 'CombatMelee',

  /**
   * run — main loop for melee combatants.
   *
   * @param {Creep} creep Melee creep.
   * @return {void}
   * Preconditions: creep assigned to a squad (creep.memory.squadId).
   * Postconditions: creep.memory.state transitions between rally/advance/engage/retreat,
   *   stickTargetId maintained for short-lived focus fire, and healing performed when possible.
   * Side-effects: Moves creep, attacks targets/structures, may heal allies, logs squad data.
   */
  run: function (creep) {
    if (creep.spawning) return;

    var mem = creep.memory || {};
    if (!mem.state) mem.state = 'rally';
    if (!mem.waitUntil) mem.waitUntil = Game.time + (CONFIG.waitTimeout || 25);

    // Memory schema (comment only):
    // creep.memory = {
    //   state: 'rally'|'advance'|'engage'|'retreat',
    //   waitUntil: number,
    //   assignedAt: number,
    //   stickTargetId: string|undefined,
    //   stickTargetAt: number|undefined,
    //   targetRoom: string|undefined,
    //   _mmSayAt: number|undefined
    // }

    var assignedAt = mem.assignedAt;
    if (assignedAt == null) {
      mem.assignedAt = Game.time;
      assignedAt = Game.time;
    }
    var waitUntil = mem.waitUntil || 0;
    var waited = Game.time - assignedAt;
    var waitTimeout = CONFIG.waitTimeout || 25;
    var anchor = (BeeCombatSquads && BeeCombatSquads.getAnchor) ? BeeCombatSquads.getAnchor(creep) : null;
    var squadId = (BeeCombatSquads && BeeCombatSquads.getSquadId) ? BeeCombatSquads.getSquadId(creep) : ((mem.squadId) || 'Alpha');

    // [1] Optionally wait for medic support before advancing.
    var shouldWait = CONFIG.waitForMedic && BeeToolbox && BeeToolbox.shouldWaitForMedic &&
      BeeToolbox.shouldWaitForMedic(creep);
    var waiting = false;
    if (shouldWait && Game.time <= waitUntil && waited < waitTimeout) {
      var rf = Game.flags.Rally || Game.flags.MedicRally || null;
      if (!rf && anchor) rf = anchor;
      if (rf) moveSmart(creep, rf.pos || rf, 0);
      debugSay(creep, "⏳");
      _logSquadSample(creep, squadId, null, anchor, 'melee');
      if (CONFIG.DEBUG_LOG && Game.time % 5 === 0) {
        console.log('[CombatMelee] waiting for medic', creep.name, 'in', creep.pos.roomName, 'waited', waited, 'ticks');
      }
      waiting = true;
    }
    if (waiting) return;

    if (!shouldWait || Game.time > waitUntil || waited >= waitTimeout) {
      mem.assignedAt = Game.time;
    }

    if (Game.time >= waitUntil && mem.state === 'rally') {
      mem.state = 'advance';
    }

    // [2] Self-heal or patch allies when HEAL parts available.
    this._auxHeal(creep);

    // [3] Emergency retreat when low HP or inside invader tower radius.
    var lowHp = (creep.hits / Math.max(1, creep.hitsMax)) < CONFIG.fleeHpPct;
    if (lowHp || this._inTowerDanger(creep.pos)) {
      debugRing(creep.pos, CONFIG.COLORS.DANGER, "flee", 1.0);
      _logSquadSample(creep, squadId, null, anchor, 'melee');
      if (mem.state !== 'retreat') mem.state = 'retreat';
      this._flee(creep);
      var adjBad = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1, { filter: function (h) { return _canMeleeEngage(creep, h); } })[0];
      if (adjBad && creep.getActiveBodyparts(ATTACK) > 0) {
        debugLine(creep.pos, adjBad.pos, CONFIG.COLORS.ATTACK, "⚔");
        _safeAttack(creep, adjBad);
      }
      return;
    }

    // [4] Interpose for vulnerable squadmates (archers, medics, dismantlers).
    if (this._guardSquadmate(creep)) {
      var hugger = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1, { filter: function (h) { return _canMeleeEngage(creep, h); } })[0];
      if (hugger && creep.getActiveBodyparts(ATTACK) > 0) {
        debugLine(creep.pos, hugger.pos, CONFIG.COLORS.ATTACK, "⚔");
        _safeAttack(creep, hugger);
      }
      _logSquadSample(creep, squadId, hugger, anchor, 'melee');
      return;
    }

    // [5] Shared target acquisition with sticky focus fallback.
    var stored = null;
    if (mem.stickTargetId) {
      var cache = Game.getObjectById(mem.stickTargetId);
      if (cache && cache.pos && cache.pos.roomName) {
        var lastStick = mem.stickTargetAt || 0;
        if ((Game.time - lastStick) <= 5) {
          stored = cache;
        }
      }
      if (!stored) {
        delete mem.stickTargetId;
        delete mem.stickTargetAt;
      }
    }

    var target = stored;
    var myName = _myUsername();
    if (!target && BeeCombatSquads && BeeCombatSquads.sharedTarget) {
      target = BeeCombatSquads.sharedTarget(creep);
    }

    if (!target && creep.room) {
      var seen = creep.room.find(FIND_HOSTILE_CREEPS);
      var best = null;
      var bestRange = 999;
      for (var si = 0; si < seen.length; si++) {
        var hostile = seen[si];
        if (!_isValidHostileTarget(hostile)) continue;
        var range = creep.pos.getRangeTo(hostile);
        if (range < bestRange) {
          bestRange = range;
          best = hostile;
        }
      }
      if (best) {
        target = best;
        mem.stickTargetId = best.id;
        mem.stickTargetAt = Game.time;
      }
    }
    if (!target && creep.room && !_roomIsForeign(creep.room)) {
      if (!target) {
        target = _fallbackStructureTarget(creep, myName);
      }
    }

    if (!anchor && BeeCombatSquads && BeeCombatSquads.getAnchor) anchor = BeeCombatSquads.getAnchor(creep);
    if (target && target.owner && BeeToolbox && BeeToolbox.isAlly && BeeToolbox.isAlly(target.owner.username)) {
      target = null;
      if (mem) {
        delete mem.stickTargetId;
        delete mem.stickTargetAt;
      }
    }
    _logSquadSample(creep, squadId, target, anchor, 'melee');

    // [6] No target: regroup at anchor or drift target room.
    if (!target) {
      var waitExpired = Game.time > waitUntil;
      if (anchor) {
        debugRing(anchor, CONFIG.COLORS.BUDDY, "anchor", 0.8);
        _maybeSay(creep, waitExpired ? 'MM:adv' : 'MM:seek');
        moveSmart(creep, anchor, 1);
      } else if (mem.targetRoom) {
        var drift = new RoomPosition(25, 25, mem.targetRoom);
        _maybeSay(creep, waitExpired ? 'MM:adv' : 'MM:seek');
        moveSmart(creep, drift, 1);
      }
      if (waitExpired && mem.state !== 'advance') {
        mem.state = 'advance';
      }
      return;
    }

    if (mem.state === 'rally' && (Game.time >= waitUntil || !shouldWait)) {
      mem.state = 'advance';
    }

    _maybeSay(creep, 'MM:atk');

    if (CONFIG.DEBUG_DRAW) debugRing(target, CONFIG.COLORS.TARGET, "target", 0.7);

    // [7] Opportunistically retarget weak enemies within 1..2 range to finish them.
    if (Game.time % 3 === 0) {
      var weak = this._weakestIn1to2(creep);
      if (weak && (weak.hits / Math.max(1, weak.hitsMax)) < 0.5) {
        target = weak;
        if (CONFIG.DEBUG_DRAW) debugRing(target, CONFIG.COLORS.TARGET, "weak", 0.9);
      }
    }

    // [8] Engage target when adjacent; handle rampart cover and micro repositioning.
    if (creep.pos.isNearTo(target)) {
      if (mem.state !== 'engage') mem.state = 'engage';
      var coverList = target.pos.lookFor(LOOK_STRUCTURES);
      var cover = null;
      for (var ci = 0; ci < coverList.length; ci++) {
        var st = coverList[ci];
        if (st.structureType === STRUCTURE_RAMPART && _isInvaderStruct(st)) {
          cover = st; break;
        }
      }
      if (cover && creep.getActiveBodyparts(ATTACK) > 0) {
        debugLine(creep.pos, cover.pos, CONFIG.COLORS.COVER, "🛡");
        debugSay(creep, "🔨");
        _safeAttack(creep, cover);
        return;
      }

      if (target.structureType && target.structureType === STRUCTURE_INVADER_CORE) {
        debugSay(creep, "⚔ core!");
        debugLine(creep.pos, target.pos, CONFIG.COLORS.ATTACK, "⚔");
        if (creep.getActiveBodyparts(ATTACK) > 0) _safeAttack(creep, target);
        return;
      }

      if (creep.getActiveBodyparts(ATTACK) > 0) {
        debugLine(creep.pos, target.pos, CONFIG.COLORS.ATTACK, "⚔");
        _safeAttack(creep, target);
      }

      var better = this._bestAdjacentTile(creep, target);
      if (better && (better.x !== creep.pos.x || better.y !== creep.pos.y)) {
        var dir = creep.pos.getDirectionTo(better);
        creep.move(dir);
      }
      return;
    }

    // [9] Door-bash Invader ramparts/walls blocking path.
    if (CONFIG.doorBash) {
      var blocker = this._blockingDoor(creep, target);
      if (blocker && creep.pos.isNearTo(blocker)) {
        if (creep.getActiveBodyparts(ATTACK) > 0) {
          debugSay(creep, "🧱");
          debugLine(creep.pos, blocker.pos, CONFIG.COLORS.COVER, "bash");
          _safeAttack(creep, blocker);
        }
        return;
      }
    }

    // [10] Close distance politely using BeeCombatSquads movement.
    if (mem.state !== 'engage') mem.state = 'advance';
    moveSmart(creep, target.pos, 1);

    var adj = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1, { filter: function (h) { return _canMeleeEngage(creep, h); } })[0];
    if (adj && creep.getActiveBodyparts(ATTACK) > 0) {
      debugLine(creep.pos, adj.pos, CONFIG.COLORS.ATTACK, "⚔");
      _safeAttack(creep, adj);
    }
  },

  /**
   * _auxHeal — heals self or wounded squadmate when HEAL parts available.
   */
  _auxHeal: function (creep) {
    var healParts = creep.getActiveBodyparts(HEAL);
    if (!healParts) return;

    if (creep.hits < creep.hitsMax) {
      debugSay(creep, "💊");
      creep.heal(creep);
      return;
    }

    var sid = (creep.memory && creep.memory.squadId) || 'Alpha';
    var mates = _.filter(Game.creeps, function (c) {
      return c.my && c.id !== creep.id && c.memory && c.memory.squadId === sid && c.hits < c.hitsMax;
    });
    if (!mates.length) return;

    var target = _.min(mates, function (c) { return c.hits / Math.max(1, c.hitsMax); });
    if (creep.pos.isNearTo(target)) {
      debugLine(creep.pos, target.pos, CONFIG.COLORS.ATTACK, "heal");
      creep.heal(target);
    } else if (creep.pos.inRangeTo(target, 3)) {
      debugLine(creep.pos, target.pos, CONFIG.COLORS.ATTACK, "rheal");
      creep.rangedHeal(target);
    }
  },

  /**
   * _guardSquadmate — move to shield vulnerable allies from melee threats.
   */
  _guardSquadmate: function (creep) {
    var sid = (creep.memory && creep.memory.squadId) || 'Alpha';
    var threatened = _.filter(Game.creeps, function (ally) {
      if (!ally.my || !ally.memory || ally.memory.squadId !== sid) return false;
      var role = ally.memory.task || ally.memory.role || '';
      if (role !== 'CombatArcher' && role !== 'CombatMedic' && role !== 'Dismantler') return false;
      return ally.pos.findInRange(FIND_HOSTILE_CREEPS, 1, {
        filter: function (h){ return _canMeleeEngage(creep, h) && h.getActiveBodyparts(ATTACK) > 0; }
      }).length > 0;
    });

    if (!threatened.length) return false;
    var buddy = creep.pos.findClosestByRange(threatened);
    if (!buddy) return false;

    if (CONFIG.DEBUG_DRAW) debugRing(buddy, CONFIG.COLORS.BUDDY, "guard", 0.8);

    if (creep.pos.isNearTo(buddy)) {
      if (BeeCombatSquads.tryFriendlySwap && BeeCombatSquads.tryFriendlySwap(creep, buddy.pos)) {
        debugSay(creep, "↔");
        return true;
      }

      var bad = buddy.pos.findInRange(FIND_HOSTILE_CREEPS, 1, {filter: function (h){return _canMeleeEngage(creep, h) && h.getActiveBodyparts(ATTACK)>0;}})[0];
      if (bad) {
        var best = this._bestAdjacentTile(creep, bad);
        if (best && creep.pos.getRangeTo(best) === 1) {
          debugLine(creep.pos, best, CONFIG.COLORS.PATH, "cover");
          creep.move(creep.pos.getDirectionTo(best));
          return true;
        }
      }
    } else {
      debugLine(creep.pos, buddy.pos, CONFIG.COLORS.PATH, "guard");
      moveSmart(creep, buddy.pos, 1);
      return true;
    }
    return false;
  },

  /**
   * _inTowerDanger — detect invader tower coverage at a position.
   */
  _inTowerDanger: function (pos) {
    var room = Game.rooms[pos.roomName]; if (!room) return false;
    var towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s){
      return _isInvaderStruct(s) && s.structureType === STRUCTURE_TOWER;
    }});
    var danger = false;
    for (var i=0;i<towers.length;i++) {
      if (towers[i].pos.getRangeTo(pos) <= CONFIG.towerAvoidRadius) danger = true;
      if (CONFIG.DEBUG_DRAW) debugRing(towers[i], CONFIG.COLORS.TOWER, "InvTower", CONFIG.towerAvoidRadius);
    }
    return danger;
  },

  /**
   * _bestAdjacentTile — pick safest adjacent tile while sticking to target.
   */
  _bestAdjacentTile: function (creep, target) {
    var best = creep.pos, bestScore = 1e9, room = creep.room;
    var threats = room ? room.find(FIND_HOSTILE_CREEPS, {
      filter: function (h){
        return _canMeleeEngage(creep, h) && (h.getActiveBodyparts(ATTACK)>0 || h.getActiveBodyparts(RANGED_ATTACK)>0) && h.hits>0;
      }
    }) : [];

    for (var dx=-1; dx<=1; dx++) for (var dy=-1; dy<=1; dy++) {
      if (!dx && !dy) continue;
      var x=creep.pos.x+dx, y=creep.pos.y+dy;
      if (x<=0||x>=49||y<=0||y>=49) continue;
      var pos = new RoomPosition(x,y, creep.room.name);
      if (!pos.isNearTo(target)) continue;

      var look = pos.look();
      var impass=false, onRoad=false, i;
      for (i=0;i<look.length;i++){
        var o=look[i];
        if (o.type===LOOK_TERRAIN && o.terrain==='wall') { impass=true; break; }
        if (o.type===LOOK_CREEPS) { impass=true; break; }
        if (o.type===LOOK_STRUCTURES) {
          var st=o.structure.structureType;
          if (st===STRUCTURE_ROAD) onRoad=true;
          else if (st!==STRUCTURE_CONTAINER && (st!==STRUCTURE_RAMPART || !o.structure.my)) { impass=true; break; }
        }
      }
      if (impass) continue;

      var score=0;
      for (i=0;i<threats.length;i++) if (threats[i].pos.getRangeTo(pos)<=1) score+=20;
      if (this._inTowerDanger(pos)) score+=50;
      if (x<=1 || x>=48 || y<=1 || y>=48) score += CONFIG.edgePenalty;
      if (onRoad) score-=1;

      if (score<bestScore) { bestScore=score; best=pos; }
    }

    if (CONFIG.DEBUG_DRAW && (best.x !== creep.pos.x || best.y !== creep.pos.y)) {
      debugRing(best, CONFIG.COLORS.PATH, "best", 0.5);
    }
    return best;
  },

  /**
   * _blockingDoor — identify Invader ramparts/walls obstructing target.
   */
  _blockingDoor: function (creep, target) {
    var closeStructs = creep.pos.findInRange(FIND_STRUCTURES, 1, { filter: function (s) {
      if (s.structureType === STRUCTURE_WALL) return true;
      if (s.structureType === STRUCTURE_RAMPART && _isInvaderStruct(s)) return true;
      return false;
    }});
    if (!closeStructs.length) return null;
    var best = _.min(closeStructs, function (s){ return s.pos.getRangeTo(target); });
    if (!best) return null;
    var distNow = creep.pos.getRangeTo(target);
    var distThru = best.pos.getRangeTo(target);
    if (CONFIG.DEBUG_DRAW) debugRing(best, CONFIG.COLORS.COVER, "door", 0.6);
    return distThru < distNow ? best : null;
  },

  /**
   * _weakestIn1to2 — choose lowest effective HP invader within range 2.
   */
  _weakestIn1to2: function (creep) {
    var xs = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 2, { filter: function (h) { return _canMeleeEngage(creep, h); } });
    if (!xs.length) return null;
    return _.min(xs, function (c){ return c.hits / Math.max(1, c.hitsMax); });
  },

  /**
   * _flee — retreat toward rally or away from closest hostile.
   */
  _flee: function (creep) {
    var rally = Game.flags.MedicRally || Game.flags.Rally || (BeeCombatSquads && BeeCombatSquads.getAnchor && BeeCombatSquads.getAnchor(creep));
    if (rally) {
      debugLine(creep.pos, rally.pos || rally, CONFIG.COLORS.FLEE, "flee");
      moveSmart(creep, rally.pos || rally, 1);
    } else {
      var bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, { filter: function (h) { return _canMeleeEngage(creep, h); } });
      if (bad) {
        var dir = creep.pos.getDirectionTo(bad);
        var zero = (dir - 1 + 8) % 8;
        var back = ((zero + 4) % 8) + 1;
        debugSay(creep, "↩");
        creep.move(back);
      }
    }
  }
};

module.exports = roleCombatMelee;

/**
 * Collaboration Map:
 * - BeeCombatSquads.sharedTarget() feeds melee focus fire; archers/medics rely on melee to
 *   lock that target in place using stickTargetId.
 * - BeeCombatSquads.getAnchor() (backed by SquadFlagManager) provides rally points when
 *   no threats exist, allowing squads to regroup without drifting.
 * - role.CombatMedic.js expects melee to signal state transitions (state + _logSquadSample)
 *   to plan heals; melee simultaneously clears cover so archers maintain line-of-sight.
 * Edge cases noted:
 * - No vision in target room: fallbackStructureTarget and anchor drift keep melee busy.
 * - Enemy dies mid-tick: stickTarget cleared and new target selected next tick.
 * - Wounds healed before retreat: low HP check re-evaluates each tick.
 * - Path blocked by ramparts: _blockingDoor and moveSmart coordinate door bashing.
 * - Squad member death/desync: _guardSquadmate adapts to remaining allies; anchor fallback ensures regroup.
 */
