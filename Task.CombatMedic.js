// Task.CombatMedic.js — PvE Medic with Debug_say & Debug_draw instrumentation (ES5-safe)

var BeeToolbox = require('BeeToolbox');
var TaskSquad  = require('Task.Squad');

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
function debugLine(from, to, color, label){
  if (!CONFIG.DEBUG_DRAW || !from || !to) return;
  var f=_posOf(from), t=_posOf(to); if(!f||!t||f.roomName!==t.roomName) return;
  var R=_roomOf(f); if(!R||!R.visual) return;
  R.visual.line(f, t, { color: color, width: CONFIG.WIDTH, opacity: CONFIG.OPAC });
  if (label){
    var mx=(f.x+t.x)/2, my=(f.y+t.y)/2;
    R.visual.text(label, mx, my-0.25, {
      color: color, opacity: 0.95, font: CONFIG.FONT, align:"center",
      backgroundColor:"#000", backgroundOpacity:0.25
    });
  }
}
function debugRing(target, color, text, radius){
  if (!CONFIG.DEBUG_DRAW || !target) return;
  var p=_posOf(target); if(!p) return;
  var R=_roomOf(p); if(!R||!R.visual) return;
  R.visual.circle(p, { radius: radius!=null?radius:0.6, fill:"transparent", stroke: color, opacity: CONFIG.OPAC, width: CONFIG.WIDTH });
  if (text) R.visual.text(text, p.x, p.y-0.8, { color: color, font: CONFIG.FONT, opacity: 0.95, align:"center" });
}
function hud(creep, text){
  if (!CONFIG.DEBUG_DRAW) return;
  var R=creep.room; if(!R||!R.visual) return;
  R.visual.text(text, creep.pos.x, creep.pos.y-1.2, {
    color: CONFIG.COLORS.TEXT, font: CONFIG.FONT, opacity: 0.95, align: "center",
    backgroundColor:"#000", backgroundOpacity:0.25
  });
}

// Movement wrapper (TaskSquad.stepToward > BeeTravel > moveTo) with line preview
function moveSmart(creep, dest, range){
  var d = _posOf(dest) || dest;
  if (creep.pos.roomName === d.roomName && creep.pos.getRangeTo(d) > (range||1)){
    debugLine(creep.pos, d, CONFIG.COLORS.PATH, "→");
  }
  if (TaskSquad && typeof TaskSquad.stepToward === 'function'){
    return TaskSquad.stepToward(creep, d, range);
  }
  try {
    if (BeeToolbox && typeof BeeToolbox.BeeTravel === 'function'){
      return BeeToolbox.BeeTravel(creep, d, { range: (range!=null?range:1), reusePath: CONFIG.reusePath });
    }
  } catch(e){}
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
      healedFlag.v = true;
    }
  } else if (creep.pos.inRangeTo(target, 3)){
    var ok2 = creep.rangedHeal(target);
    if (ok2 === OK){
      debugSay(creep, "💚");
      debugLine(creep.pos, target.pos, CONFIG.COLORS.RHEAL, "rheal");
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
    if (c.memory.followTarget === targetId) n++;
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

var TaskCombatMedic = {
  run: function (creep) {
    if (creep.spawning) return;

    // HUD
    hud(creep, "⛑ " + creep.hits + "/" + creep.hitsMax);

    var now = Game.time;
    var bodyHeal = creep.getActiveBodyparts(HEAL);
    var canHeal = bodyHeal > 0;
    var healedThisTick = { v: false }; // one heal cast per tick (heal OR rangedHeal)

    // ---------- 1) choose / refresh buddy ----------
    var buddy = Game.getObjectById(creep.memory.followTarget);
    var needNewBuddy = (!buddy || !buddy.my || buddy.hits <= 0);
    if (!needNewBuddy && creep.memory.assignedAt && (now - creep.memory.assignedAt) > CONFIG.stickiness) {
      needNewBuddy = true;
    }

    if (needNewBuddy) {
      delete creep.memory.followTarget;
      delete creep.memory.assignedAt;

      var squadId = creep.memory.squadId || 'Alpha';
      var candidates = _.filter(Game.creeps, function (a){
        if (!a || !a.my || !a.memory) return false;
        if ((a.memory.squadId || 'Alpha') !== squadId) return false;
        var t = a.memory.task || a.memory.role || '';
        return !!CombatRoles[t];
      });

      if (candidates.length) {
        var anyInjured = _.some(candidates, function(a){ return a.hits < a.hitsMax; });
        if (anyInjured) {
          var best = null, bestScore = 9999;
          for (var i=0;i<candidates.length;i++){
            var a = candidates[i];
            var score = (a.hits - estimateTowerDamage(a.room, a.pos)) / Math.max(1, a.hitsMax);
            if (score < bestScore) { bestScore = score; best = a; }
          }
          buddy = best;
        } else {
          // Prefer melee anchor if nobody hurt
          var i2; buddy = null;
          for (i2=0;i2<candidates.length;i2++){
            var t2 = candidates[i2].memory.task || candidates[i2].memory.role || '';
            if (t2 === 'CombatMelee'){ buddy = candidates[i2]; break; }
          }
          if (!buddy) buddy = candidates[0];
        }

        // Per-target medic cap
        if (buddy && CONFIG.maxMedicsPerTarget > 0) {
          var load = countMedicsFollowing(creep, buddy.id);
          if (load >= CONFIG.maxMedicsPerTarget) {
            var alt = null, bestLoad = 999, j;
            for (j=0;j<candidates.length;j++){
              var cand = candidates[j];
              var l = countMedicsFollowing(creep, cand.id);
              if (l < bestLoad) { bestLoad = l; alt = cand; }
            }
            if (alt) buddy = alt;
          }
        }

        if (buddy) {
          creep.memory.followTarget = buddy.id;
          creep.memory.assignedAt = now;
          if (CONFIG.DEBUG_DRAW) debugRing(buddy, CONFIG.COLORS.BUDDY, "buddy", 0.7);
          debugSay(creep, "👣");
        }
      }
    } else {
      if (CONFIG.DEBUG_DRAW) debugRing(buddy, CONFIG.COLORS.BUDDY, "buddy", 0.7);
    }

    // ---------- 2) no buddy? hover at anchor/rally and still heal ----------
    if (!buddy) {
      var anc = (TaskSquad && TaskSquad.getAnchor && TaskSquad.getAnchor(creep)) || Game.flags.MedicRally || Game.flags.Rally;
      if (anc) moveSmart(creep, (anc.pos || anc), 1);
      // opportunistic heal around rally point
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

      // heal while fleeing: buddy > anyone in 3 > self
      if (canHeal && !healedThisTick.v) {
        if (buddy.hits < buddy.hitsMax && creep.pos.inRangeTo(buddy, 3)) tryHeal(creep, buddy, healedThisTick);
        if (!healedThisTick.v) tryHeal(creep, lowestInRange(creep.pos, 3), healedThisTick);
        if (!healedThisTick.v && creep.hits < creep.hitsMax) tryHeal(creep, creep, healedThisTick);
      }
      return;
    }

    // ---------- 4) follow buddy with safe spacing ----------
    var wantRange = CONFIG.followRange;
    if (!creep.pos.inRangeTo(buddy, wantRange)) {
      moveSmart(creep, buddy.pos, wantRange);
      // heal while approaching
      if (canHeal && !healedThisTick.v) {
        if (buddy.hits < buddy.hitsMax) tryHeal(creep, buddy, healedThisTick);
        if (!healedThisTick.v) tryHeal(creep, lowestInRange(creep.pos, 3), healedThisTick);
      }
    } else {
      // avoid standing too close to enemy melee if possible
      var hm = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, {
        filter: function (h){ return _isInvaderCreep(h) && h.getActiveBodyparts(ATTACK)>0 && h.hits>0; }
      });
      if (hm && creep.pos.getRangeTo(hm) < CONFIG.avoidMeleeRange) {
        var dir = hm.pos.getDirectionTo(creep.pos); // step away
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
        tryHeal(creep, patient, healedThisTick); // rangedHeal during approach, heal if adjacent
      }
    } else {
      // ---------- 6) fallback: stick to buddy, heal buddy/nearby ----------
      if (!creep.pos.inRangeTo(buddy, wantRange)) moveSmart(creep, buddy.pos, wantRange);
      if (canHeal && !healedThisTick.v) {
        if (buddy.hits < buddy.hitsMax) tryHeal(creep, buddy, healedThisTick);
        if (!healedThisTick.v) tryHeal(creep, lowestInRange(creep.pos, 3), healedThisTick);
      }
    }

    // ---------- 7) last: self-heal if still unused ----------
    if (canHeal && !healedThisTick.v && creep.hits < creep.hitsMax) {
      tryHeal(creep, creep, healedThisTick);
    }

    // Decor: draw danger aura if near tower zone
    if (CONFIG.DEBUG_DRAW && inTowerDanger(creep.pos)){
      debugRing(creep.pos, CONFIG.COLORS.DANGER, "tower zone", 1.1);
    }
  }
};

module.exports = TaskCombatMedic;
