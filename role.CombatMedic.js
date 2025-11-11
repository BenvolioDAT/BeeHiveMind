/**
 * role.CombatMedic.js — PvE healer supporting Bee combat squads with triage and kiting.
 *
 * Pipeline position: Decide → Act → Move. Medic decides which ally to heal, executes
 * heal/rangedHeal actions, then repositions relative to its buddy while respecting
 * threat envelopes.
 *
 * Inputs: creep.memory (buddyId, followTarget, stickiness timers), TaskSquad anchors,
 * BeeToolbox medic wait heuristics, Game flags, hostiles in room. Outputs: heal intents,
 * follow movement orders, and Memory breadcrumbs (e.g., _medSay_* throttles).
 *
 * Collaborations: BeeCombatSquads.js provides anchors and shared target focus; melee and
 * archers rely on the medic to maintain follow distance, while the medic expects melee to
 * interpose (see role.CombatMelee.js). SquadFlagManager.js ensures anchors exist when no
 * buddy is found so medics can rally safely.
 */

var BeeToolbox = require('BeeToolbox');
var TaskSquad  = require('BeeCombatSquads');

// PvE-only acceptance: react ONLY to Invader creeps/structures
function _isInvaderCreep(c) { return !!(c && c.owner && c.owner.username === 'Invader'); }
function _isInvaderStruct(s) { return !!(s && s.owner && s.owner.username === 'Invader'); }

// ==========================
// Config
// ==========================
var CONFIG = {
  // Follow & triage
  followRange: 1,          // how close to stay to buddy
  triageRange: 4,          // scan radius for patients
  criticalPct: 0.75,       // "critical" if below this fraction

  // Safety
  fleePct: 0.35,
  avoidMeleeRange: 2,      // avoid standing within 2 of enemy melee
  towerAvoidRadius: 20,    // treat invader towers as dangerous in this radius

  // Squad balancing
  stickiness: 25,          // ticks before re-evaluating buddy
  maxMedicsPerTarget: 1,   // enforce per-buddy medic cap

  // Movement
  reusePath: 5,
  maxRooms: 2,

  // Debug
  DEBUG_SAY: true,
  DEBUG_DRAW: true,
  DEBUG_LOG: false,

  COLORS: {
    PATH:   "#7ac7ff",
    HEAL:   "#9cff8c",
    RHEAL:  "#b0ffb0",
    FLEE:   "#ff5c7a",
    BUDDY:  "#ffd54f",
    TOWER:  "#f0c040",
    TEXT:   "#f2f2f2",
    DANGER: "#ff9e80"
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

function _maybeSay(creep, key, msg){
  if (!creep || !creep.say || !creep.memory) return;
  var field = key ? ('_medSay_' + key) : '_medSay';
  var last = creep.memory[field] || 0;
  if ((Game.time - last) >= 8){
    creep.say(msg, true);
    creep.memory[field] = Game.time;
  }
}

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
  console.log('[SquadLog]', squadId, creep.name, (keySuffix || 'medic'), 'target', targetId, 'anchor', anchorStr);
}

/**
 * _chooseBuddyFromPool — prioritize buddies based on health ratio and distance.
 */
function _chooseBuddyFromPool(creep, pool, respectCap){
  if (!creep || !pool || !pool.length) return null;
  var best = null;
  var bestScore = null;
  var enforce = respectCap ? (CONFIG.maxMedicsPerTarget | 0) : 0;
  var i;
  for (i = 0; i < pool.length; i++){
    var cand = pool[i];
    if (!cand || !cand.pos) continue;
    if (enforce > 0){
      var load = countMedicsFollowing(creep, cand.id);
      if (load >= enforce) continue;
    }
    var ratio = cand.hits / Math.max(1, cand.hitsMax);
    var score = (ratio * 100) + creep.pos.getRangeTo(cand);
    if (best === null || score < bestScore){
      best = cand;
      bestScore = score;
    }
  }
  if (!best && enforce > 0){
    var fallback = null;
    var bestLoad = null;
    for (i = 0; i < pool.length; i++){
      var cand2 = pool[i];
      if (!cand2) continue;
      var load2 = countMedicsFollowing(creep, cand2.id);
      if (bestLoad === null || load2 < bestLoad){
        bestLoad = load2;
        fallback = cand2;
      }
    }
    if (fallback) best = fallback;
  }
  if (!best && pool.length){
    best = creep.pos.findClosestByRange(pool) || pool[0];
  }
  return best;
}

/**
 * _selectBuddy — choose best ally to follow within squad.
 */
function _selectBuddy(creep, squadId){
  var room = creep.room;
  if (!room) return null;
  var sameSquad = room.find(FIND_MY_CREEPS, { filter: function (a){
    if (!a || !a.memory || a.id === creep.id) return false;
    var role = a.memory.role || a.memory.task || '';
    if (!CombatRoles[role]) return false;
    if (squadId && a.memory.squadId && a.memory.squadId !== squadId) return false;
    return true;
  }});
  var priorities = ['CombatMelee', 'CombatArcher', 'Dismantler'];
  var idx;
  for (idx = 0; idx < priorities.length; idx++){
    var roleName = priorities[idx];
    var pool = [];
    var i;
    for (i = 0; i < sameSquad.length; i++){
      var cand = sameSquad[i];
      var r = cand.memory.role || cand.memory.task || '';
      if (r === roleName) pool.push(cand);
    }
    if (!pool.length) continue;
    var injured = [];
    for (i = 0; i < pool.length; i++){
      if (pool[i].hits < pool[i].hitsMax) injured.push(pool[i]);
    }
    var pick = _chooseBuddyFromPool(creep, injured.length ? injured : pool, true);
    if (pick) return pick;
  }
  var damaged = room.find(FIND_MY_CREEPS, { filter: function (a){
    return a && a.id !== creep.id && a.hits < a.hitsMax;
  }});
  if (damaged && damaged.length){
    var any = _chooseBuddyFromPool(creep, damaged, false);
    if (any) return any;
  }
  var meleePool = [];
  var j;
  for (j = 0; j < sameSquad.length; j++){
    var cand2 = sameSquad[j];
    var role2 = cand2.memory.role || cand2.memory.task || '';
    if (role2 === 'CombatMelee') meleePool.push(cand2);
  }
  if (meleePool.length){
    return _chooseBuddyFromPool(creep, meleePool, true);
  }
  return null;
}

// Movement wrapper (TaskSquad.stepToward > BeeTravel > moveTo) with line preview
function moveSmart(creep, dest, range){
  var d = _posOf(dest) || dest;
  if (creep.pos.roomName === d.roomName && creep.pos.getRangeTo(d) > (range||1)){
    debugLine(creep.pos, d, CONFIG.COLORS.PATH);
  }
  if (TaskSquad && typeof TaskSquad.stepToward === 'function'){
    return TaskSquad.stepToward(creep, d, range);
  }
  return creep.moveTo(d, { reusePath: CONFIG.reusePath, maxOps: 2000 });
}

// ==========================
// Core helpers
// ==========================
function lowestInRange(origin, range) {
  var allies = origin.findInRange(FIND_MY_CREEPS, range, { filter: function (a){ return a.hits < a.hitsMax; } });
  if (!allies.length) return null;
  return _.min(allies, function (a){ return a.hits / Math.max(1, a.hitsMax); });
}

function tryHeal(creep, target, healedFlag){
  if (healedFlag.v) return;
  if (!target) return;
  if (target.hits >= target.hitsMax) return;

  if (creep.pos.isNearTo(target)){
    var ok = creep.heal(target);
    if (ok === OK){
      debugSay(creep, "❤️");
      debugLine(creep.pos, target.pos, CONFIG.COLORS.HEAL, "heal");
      _maybeSay(creep, 'heal', 'MED:heal');
      healedFlag.v = true;
    }
  } else if (creep.pos.inRangeTo(target, 3)){
    var ok2 = creep.rangedHeal(target);
    if (ok2 === OK){
      debugSay(creep, "💚");
      debugLine(creep.pos, target.pos, CONFIG.COLORS.RHEAL, "rheal");
      _maybeSay(creep, 'heal', 'MED:heal');
      healedFlag.v = true;
    }
  }
}

function countMedicsFollowing(creep, targetId) {
  var sid = creep.memory.squadId || 'Alpha';
  var n = 0, name;
  for (name in Game.creeps) {
    var c = Game.creeps[name];
    if (!c || !c.my || !c.memory) continue;
    if ((c.memory.squadId || 'Alpha') !== sid) continue;
    var tag = (c.memory.task || c.memory.role);
    if (tag !== 'CombatMedic') continue;
    var buddyId = c.memory.buddyId || c.memory.followTarget;
    if (buddyId === targetId) n++;
  }
  return n;
}

function estimateTowerDamage(room, pos) {
  if (!room || !pos) return 0;
  var towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s){ return _isInvaderStruct(s) && s.structureType === STRUCTURE_TOWER; } });
  var total = 0;
  for (var i=0;i<towers.length;i++) {
    var d = towers[i].pos.getRangeTo(pos);
    if (CONFIG.DEBUG_DRAW) debugRing(towers[i], CONFIG.COLORS.TOWER, "InvTower", CONFIG.towerAvoidRadius);
    if (typeof TOWER_OPTIMAL_RANGE !== 'undefined' && typeof TOWER_POWER_ATTACK !== 'undefined' && typeof TOWER_FALLOFF_RANGE !== 'undefined' && typeof TOWER_FALLOFF !== 'undefined'){
      if (d <= TOWER_OPTIMAL_RANGE) total += TOWER_POWER_ATTACK;
      else {
        var capped = Math.min(d, TOWER_FALLOFF_RANGE);
        var frac = (capped - TOWER_OPTIMAL_RANGE) / Math.max(1, (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE));
        var fall = TOWER_POWER_ATTACK * (1 - (TOWER_FALLOFF * frac));
        total += Math.max(0, Math.floor(fall));
      }
    }
  }
  return total;
}

function inTowerDanger(pos){
  var room = Game.rooms[pos.roomName]; if (!room) return false;
  var towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s){ return _isInvaderStruct(s) && s.structureType===STRUCTURE_TOWER; } });
  for (var i=0;i<towers.length;i++){
    if (towers[i].pos.getRangeTo(pos) <= CONFIG.towerAvoidRadius){
      return true;
    }
  }
  return false;
}

// ==========================
// Public API
// ==========================
var CombatRoles = { CombatMelee:1, CombatArcher:1, Dismantler:1 };

var roleCombatMedic = {
  role: 'CombatMedic',

  /**
   * run — per-tick logic for medics.
   *
   * @param {Creep} creep Medic creep.
   * @return {void}
   * Preconditions: creep has HEAL parts for meaningful work (gracefully handles zero).
   * Postconditions: creep.memory.buddyId updated, follow distance maintained, heals cast
   *   on highest-priority targets, and flee behavior triggered when threatened.
   * Side-effects: Moves via TaskSquad, calls PathFinder search for flee, updates Memory
   *   fields (buddyId, buddyAt, followTarget, noBuddyTicks, _medSay_*).
   */
  run: function (creep) {
    if (creep.spawning) return;

    var mem = creep.memory || {};
    if (mem.followTarget && !mem.buddyId) {
      mem.buddyId = mem.followTarget;
    }

    var now = Game.time;
    var bodyHeal = creep.getActiveBodyparts(HEAL);
    var canHeal = bodyHeal > 0;
    var healedThisTick = { v: false }; // one heal cast per tick (heal OR rangedHeal)
    var anchor = (TaskSquad && TaskSquad.getAnchor) ? TaskSquad.getAnchor(creep) : null;
    var squadId = (TaskSquad && TaskSquad.getSquadId) ? TaskSquad.getSquadId(creep) : ((mem && mem.squadId) || 'Alpha');
    var followMin = Math.max(1, CONFIG.followRange || 1);
    var followMax = Math.max(followMin, 2);

    if (canHeal && !healedThisTick.v) {
      var selfRatio = creep.hits / Math.max(1, creep.hitsMax);
      if (selfRatio < 0.7) {
        tryHeal(creep, creep, healedThisTick);
      }
    }

    // ---------- 1) choose / refresh buddy ----------
    var buddyId = mem.buddyId || mem.followTarget;
    var buddy = buddyId ? Game.getObjectById(buddyId) : null;
    var buddyAt = mem.buddyAt || 0;
    var needNewBuddy = (!buddy || !buddy.my || buddy.hits <= 0);
    if (!needNewBuddy && buddyAt && (now - buddyAt) > CONFIG.stickiness) {
      needNewBuddy = true;
    }

    if (needNewBuddy) {
      delete mem.buddyId;
      delete mem.buddyAt;
      delete mem.followTarget;
      delete mem.assignedAt;
      var picked = _selectBuddy(creep, squadId);
      if (picked) {
        buddy = picked;
        mem.buddyId = buddy.id;
        mem.buddyAt = now;
        mem.followTarget = buddy.id;
        delete mem.assignedAt;
        if (CONFIG.DEBUG_DRAW) debugRing(buddy, CONFIG.COLORS.BUDDY, "buddy", 0.7);
        debugSay(creep, "👣");
        _maybeSay(creep, 'stick', 'MED:stick');
      }
    } else if (buddy) {
      mem.buddyId = buddy.id;
      if (CONFIG.DEBUG_DRAW) debugRing(buddy, CONFIG.COLORS.BUDDY, "buddy", 0.7);
    }

    if (buddy) {
      mem.noBuddyTicks = 0;
    } else {
      var nb = (mem.noBuddyTicks || 0) + 1;
      mem.noBuddyTicks = nb;
      if (CONFIG.DEBUG_LOG && nb % 20 === 0) {
        console.log('[CombatMedic] no buddy for', nb, 'ticks in', creep.pos.roomName, '(', creep.name, ')');
      }
    }

    if (!anchor && TaskSquad && TaskSquad.getAnchor) anchor = TaskSquad.getAnchor(creep);
    _logSquadSample(creep, squadId, buddy, anchor, 'medic');

    if (canHeal && buddy && !healedThisTick.v && buddy.hits < buddy.hitsMax) {
      tryHeal(creep, buddy, healedThisTick);
    }

    // ---------- 2) no buddy? hover at anchor/rally and still heal ----------
    if (!buddy) {
      var anc = anchor || Game.flags.MedicRally || Game.flags.Rally;
      if (anc) {
        _maybeSay(creep, 'seek', 'MED:seek');
        moveSmart(creep, (anc.pos || anc), followMin);
      }
      var invaders = creep.room ? creep.room.find(FIND_HOSTILE_CREEPS, { filter: _isInvaderCreep }) : null;
      if (invaders && invaders.length) {
        var injured = lowestInRange(creep.pos, CONFIG.triageRange);
        if (!injured && anc) {
          injured = lowestInRange((anc.pos || anc), CONFIG.triageRange);
        }
        if (injured) {
          moveSmart(creep, injured.pos, followMin);
          if (canHeal && !healedThisTick.v) tryHeal(creep, injured, healedThisTick);
        }
      }
      if (canHeal && !healedThisTick.v) tryHeal(creep, lowestInRange(creep.pos, CONFIG.triageRange), healedThisTick);
      return;
    }

    // ---------- 3) flee logic (keep heals going) ----------
    var underHp = (creep.hits / Math.max(1, creep.hitsMax)) < CONFIG.fleePct;
    var hostilesNear = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3, { filter: function (h){
      return _isInvaderCreep(h) && (h.getActiveBodyparts(ATTACK)>0 || h.getActiveBodyparts(RANGED_ATTACK)>0);
    }});
    var needToFlee = underHp || (hostilesNear.length && inTowerDanger(creep.pos));

    if (needToFlee) {
      debugSay(creep, "🏃‍♂️");
      var bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, { filter: _isInvaderCreep });
      if (bad) {
        var flee = PathFinder.search(creep.pos, [{ pos: bad.pos, range: 4 }], { flee: true });
        if (!flee.incomplete && flee.path.length) {
          var step = flee.path[0];
          if (step){
            debugLine(creep.pos, step, CONFIG.COLORS.FLEE, "flee");
            creep.move(creep.pos.getDirectionTo(step));
          }
        }
      } else {
        moveSmart(creep, buddy.pos, 3);
      }

      if (canHeal && !healedThisTick.v) {
        if (buddy.hits < buddy.hitsMax && creep.pos.inRangeTo(buddy, 3)) tryHeal(creep, buddy, healedThisTick);
        if (!healedThisTick.v) tryHeal(creep, lowestInRange(creep.pos, 3), healedThisTick);
        if (!healedThisTick.v && creep.hits < creep.hitsMax) tryHeal(creep, creep, healedThisTick);
      }
      return;
    }

    // ---------- 4) follow buddy with safe spacing ----------
    var wantRange = followMin;
    if (!creep.pos.inRangeTo(buddy, followMax)) {
      moveSmart(creep, buddy.pos, wantRange);
      if (canHeal && !healedThisTick.v) {
        if (buddy.hits < buddy.hitsMax) tryHeal(creep, buddy, healedThisTick);
        if (!healedThisTick.v) tryHeal(creep, lowestInRange(creep.pos, 3), healedThisTick);
      }
    } else {
      var hm = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, {
        filter: function (h){ return _isInvaderCreep(h) && h.getActiveBodyparts(ATTACK)>0 && h.hits>0; }
      });
      if (hm && creep.pos.getRangeTo(hm) < CONFIG.avoidMeleeRange) {
        var dir = hm.pos.getDirectionTo(creep.pos);
        debugSay(creep, "↩");
        creep.move(dir);
      }
    }

    // ---------- 5) damage-aware triage ----------
    var triageSet = creep.pos.findInRange(FIND_MY_CREEPS, CONFIG.triageRange, {
      filter: function(a){ return a.hits < a.hitsMax; }
    });

    if (triageSet && triageSet.length) {
      var room2 = creep.room;
      var best = null, bestKey = 9999, i3;
      for (i3=0;i3<triageSet.length;i3++){
        var a2 = triageSet[i3];
        var exp = a2.hits - estimateTowerDamage(room2, a2.pos);
        var key = exp / Math.max(1, a2.hitsMax);
        if (key < bestKey){ bestKey = key; best = a2; }
      }
      var patient = best;

      if (patient) {
        if (CONFIG.DEBUG_DRAW) {
          debugRing(patient, CONFIG.COLORS.HEAL, "patient", 0.7);
          debugLine(creep.pos, patient.pos, CONFIG.COLORS.HEAL, "triage");
        }
        var desiredRange = creep.pos.inRangeTo(patient, 1) ? 1 : (creep.pos.inRangeTo(patient, 3) ? 3 : 1);
        moveSmart(creep, patient.pos, desiredRange === 1 ? 1 : 2);
        tryHeal(creep, patient, healedThisTick);
      }
    } else {
      if (!creep.pos.inRangeTo(buddy, followMax)) moveSmart(creep, buddy.pos, wantRange);
      if (canHeal && !healedThisTick.v) {
        if (buddy.hits < buddy.hitsMax) tryHeal(creep, buddy, healedThisTick);
        if (!healedThisTick.v) tryHeal(creep, lowestInRange(creep.pos, 3), healedThisTick);
      }
    }

    // ---------- 7) last: self-heal if still unused ----------
    if (canHeal && !healedThisTick.v && creep.hits < creep.hitsMax) {
      tryHeal(creep, creep, healedThisTick);
    }

    if (CONFIG.DEBUG_DRAW && inTowerDanger(creep.pos)){
      debugRing(creep.pos, CONFIG.COLORS.DANGER, "tower zone", 1.1);
    }
  }
};

module.exports = roleCombatMedic;

/**
 * Collaboration Map:
 * - BeeCombatSquads.getAnchor() (fed by SquadFlagManager) supplies rally points when medics
 *   are between buddies, preventing aimless wandering.
 * - Relies on role.CombatMelee.js to hold formation so medics can maintain followRange;
 *   medics reciprocate by prioritizing melee/archers based on CombatRoles.
 * - Expects BeeCombatSquads.sharedTarget() to keep front line predictable, enabling medics
 *   to pre-position via follow distance.
 * Edge cases noted:
 * - No buddy available: medic circles anchor and heals any nearby ally.
 * - Enemy dies mid-tick: buddy refresh logic selects new target once stickiness expires.
 * - Wounds healed before action: tryHeal exits early if patient already full.
 * - Path blocked by towers/ramparts: moveSmart leverages TaskSquad reservations.
 * - Flag moved while traveling: anchor refresh each tick prevents desync.
 */
