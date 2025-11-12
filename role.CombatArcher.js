/**
 * role.CombatArcher.js — PvE ranged damage dealer coordinating inside Bee combat squads.
 *
 * Pipeline position: Decide → Act → Move. The archer reads squad intent/anchors from
 * BeeCombatSquads (Decide), chooses firing tactics (Act), then repositions via
 * TaskSquad.stepToward or BeeToolbox movement (Move).
 *
 * Inputs: creep memory (squadId, state, waitUntil, archer subobject), TaskSquad shared
 * targets/anchors, BeeToolbox medic wait heuristics, Game flags. Outputs: ranged attack
 * actions, movement intents, and diagnostic breadcrumbs in creep.memory.archer.
 *
 * Collaborations: BeeCombatSquads.js supplies sharedTarget(), stepToward(), and anchors;
 * SquadFlagManager.js ensures those anchors point to relevant threats; role.CombatMelee.js
 * and role.CombatMedic.js rely on archers maintaining spacing so medics can heal safely.
 */

var BeeToolbox = require('BeeToolbox');
var TaskSquad  = require('BeeCombatSquads');

// ---- PvE-only acceptance: react ONLY to Invader creeps/structures ----
/**
 * _isInvaderCreep
 *
 * @param {Creep} c Candidate hostile creep.
 * @return {boolean} True when owned by Invader NPC.
 */
function _isInvaderCreep(c) {
  // [1] Enforce PvE charter by checking owner username.
  if (BeeToolbox && BeeToolbox.isNpcHostileCreep) return BeeToolbox.isNpcHostileCreep(c);
  return !!(c && c.owner && c.owner.username === 'Invader');
}

/**
 * _isInvaderStruct
 *
 * @param {Structure} s Candidate hostile structure.
 * @return {boolean} True when owned by Invader NPC.
 */
function _isInvaderStruct(s) {
  // [1] Mirror PvE check for structures.
  if (BeeToolbox && BeeToolbox.isNpcHostileStruct) return BeeToolbox.isNpcHostileStruct(s);
  return !!(s && s.owner && s.owner.username === 'Invader');
}

function _isFriendlyTarget(t){
  if (!t || !t.owner || !t.owner.username) return false;
  if (BeeToolbox && BeeToolbox.isFriendlyObject) return BeeToolbox.isFriendlyObject(t);
  if (BeeToolbox && BeeToolbox.isFriendlyUsername) return BeeToolbox.isFriendlyUsername(t.owner.username);
  return false;
}

function _canShootTarget(creep, target){
  if (!creep || !target) return false;
  if (_isFriendlyTarget(target)) return false;
  if (BeeToolbox && BeeToolbox.canEngageTarget) return BeeToolbox.canEngageTarget(creep, target);
  if (_isInvaderCreep(target) || _isInvaderStruct(target)) return true;
  if (target.owner && target.owner.username) {
    if (BeeToolbox && BeeToolbox.isFriendlyUsername) {
      return !BeeToolbox.isFriendlyUsername(target.owner.username);
    }
  }
  return true;
}

function _safeRangedAttack(creep, target){
  if (!creep || !target) return ERR_INVALID_TARGET;
  if (target.owner && target.owner.username && BeeToolbox && BeeToolbox.isAlly && BeeToolbox.isAlly(target.owner.username)) {
    return ERR_INVALID_TARGET;
  }
  if (!_canShootTarget(creep, target)) return ERR_INVALID_TARGET;
  return creep.rangedAttack(target);
}

// ==========================
// Config
// ==========================
var CONFIG = {
  // Ranged stance logic
  desiredRange: 2,          // target standoff
  kiteIfAtOrBelow: 2,       // kite if target is <= this range
  approachSlack: 1,         // only advance if range > desiredRange + this
  holdBand: 1,              // ok to hold when in [desiredRange, desiredRange+holdBand]

  // Motion hygiene
  shuffleCooldown: 2,       // ticks to rest after moving (anti-jitter)
  waitForMedic: true,       // delay engagement until medic nearby (if BeeToolbox.shouldWaitForMedic)
  waitTimeout: 25,

  // Safety
  fleeHpPct: 0.40,          // flee when HP below this fraction
  towerAvoidRadius: 20,     // treat invader towers as dangerous inside this radius
  maxRooms: 2,              // (reserved) cross-room leash if you wire it up
  reusePath: 10,            // path reuse hints
  maxOps: 2000,             // PathFinder ops for flee

  // Debug
  DEBUG_SAY: true,
  DEBUG_DRAW: true,
  DEBUG_LOG: false,

  COLORS: {
    PATH:   "#7ac7ff",
    SHOOT:  "#ffa07a",
    FLEE:   "#ff5c7a",
    HOLD:   "#9cff8c",
    TOWER:  "#f0c040",
    TARGET: "#ffd54f",
    TEXT:   "#f2f2f2"
  },
  WIDTH: 0.13,
  OPAC:  0.45,
  FONT:  0.7
};

// ==========================
// Mini debug helpers
// ==========================
/**
 * _posOf
 *
 * @param {*} t RoomObject or RoomPosition-like.
 * @return {RoomPosition|null} Normalized position.
 */
function _posOf(t){
  // [1] Accept both RoomObjects and raw positions.
  return t && t.pos ? t.pos : t;
}

/**
 * _roomOf
 *
 * @param {RoomPosition} p Position with roomName.
 * @return {Room|null} Room object if visible.
 */
function _roomOf(p){
  // [1] Guard against missing vision (returns undefined to caller).
  return p && Game.rooms[p.roomName];
}

/**
 * debugSay
 *
 * @param {Creep} creep Actor creep.
 * @param {string} msg Speech bubble text.
 * @return {void}
 */
function debugSay(creep, msg){
  // [1] Emit say bubble when debugging enabled to visualize decisions.
  if (CONFIG.DEBUG_SAY && creep && creep.say) creep.say(msg, true);
}

/**
 * debugLine
 *
 * @param {RoomPosition|RoomObject} from Start point.
 * @param {RoomPosition|RoomObject} to End point.
 * @param {string} color Hex color string.
 * @return {void}
 */
function debugLine(from, to, color){
  // [1] Only draw when debug enabled and both points share a visible room.
  if (!CONFIG.DEBUG_DRAW || !from || !to) return;
  var f=_posOf(from), t=_posOf(to); if(!f||!t||f.roomName!==t.roomName) return;
  var R=_roomOf(f); if(!R||!R.visual) return;
  R.visual.line(f, t, { color: color, width: CONFIG.WIDTH, opacity: CONFIG.OPAC });
}

/**
 * debugRing
 *
 * @param {RoomObject|RoomPosition} target Center of ring.
 * @param {string} color Stroke color.
 * @param {string|null} text Optional label.
 * @param {number} radius Circle radius.
 * @return {void}
 */
function debugRing(target, color, text, radius){
  // [1] Render rings only when visuals enabled and room visible.
  if (!CONFIG.DEBUG_DRAW || !target) return;
  var p=_posOf(target); if(!p) return;
  var R=_roomOf(p); if(!R||!R.visual) return;
  R.visual.circle(p, { radius: radius!=null?radius:0.6, fill:"transparent", stroke: color, opacity: CONFIG.OPAC, width: CONFIG.WIDTH });
  if (text) R.visual.text(text, p.x, p.y-0.8, { color: color, font: CONFIG.FONT, opacity: 0.95, align:"center" });
}

/**
 * moveSmart
 *
 * @param {Creep} creep Moving creep.
 * @param {RoomObject|RoomPosition} dest Destination.
 * @param {number} range Desired stopping distance.
 * @return {number} Screeps OK/ERR_* code from movement helper.
 * Preconditions: TaskSquad stepToward or BeeToolbox.BeeTravel may be available.
 * Postconditions: Movement intent issued; debug path drawn when relevant.
 */
function moveSmart(creep, dest, range){
  // [1] Draw guidance line when moving within visible room.
  var d = _posOf(dest) || dest;
  if (creep.pos.roomName === d.roomName && creep.pos.getRangeTo(d) > (range||1)){
    debugLine(creep.pos, d, CONFIG.COLORS.PATH);
  }

  // [2] Prefer TaskSquad stepToward for reservation-aware movement.
  if (TaskSquad && typeof TaskSquad.stepToward === 'function'){
    return TaskSquad.stepToward(creep, d, range);
  }

  // [3] Fall back to BeeToolbox.BeeTravel (Traveler wrapper) if present.
  try {
    if (BeeToolbox && typeof BeeToolbox.BeeTravel === 'function'){
      return BeeToolbox.BeeTravel(creep, d, { range: (range!=null?range:1), reusePath: CONFIG.reusePath });
    }
  } catch(e){}

  // [4] Last resort: native moveTo with configured reuse.
  return creep.moveTo(d, { reusePath: CONFIG.reusePath, maxOps: 2000 });
}

// ==========================
// Core helpers
// ==========================
/**
 * inHoldBand
 *
 * @param {number} range Current distance to target.
 * @return {boolean} True when within acceptable standoff band.
 */
function inHoldBand(range){
  // [1] Accept only ranges between desiredRange and desiredRange+holdBand.
  if (range < CONFIG.desiredRange) return false;
  if (range > (CONFIG.desiredRange + CONFIG.holdBand)) return false;
  return true;
}

/**
 * threatsInRoom
 *
 * @param {Room} room Room to scan.
 * @return {Array<RoomObject>} Array of invader creeps and towers.
 */
function threatsInRoom(room){
  // [1] Without vision there are no actionable threats.
  if (!room) return [];

  // [2] Collect combat-capable invader creeps.
  var creeps = room.find(FIND_HOSTILE_CREEPS, { filter: function (h){
    return _canShootTarget({ room: room }, h) && (h.getActiveBodyparts(ATTACK)>0 || h.getActiveBodyparts(RANGED_ATTACK)>0);
  }});

  // [3] Add invader towers which project area denial.
  var towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s){
    return _isInvaderStruct(s) && s.structureType===STRUCTURE_TOWER;
  }});
  return creeps.concat(towers);
}

/**
 * inTowerDanger
 *
 * @param {RoomPosition} pos Position to evaluate.
 * @return {boolean} True when within CONFIG.towerAvoidRadius of invader tower.
 */
function inTowerDanger(pos){
  // [1] Without room vision cannot evaluate danger; assume safe.
  var room = Game.rooms[pos.roomName]; if (!room) return false;

  // [2] Look for invader towers and highlight the danger radius when debugging.
  var towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s){ return _isInvaderStruct(s) && s.structureType===STRUCTURE_TOWER; } });
  for (var i=0;i<towers.length;i++){
    if (towers[i].pos.getRangeTo(pos) <= CONFIG.towerAvoidRadius){
      if (CONFIG.DEBUG_DRAW) debugRing(towers[i], CONFIG.COLORS.TOWER, "InvTower", CONFIG.towerAvoidRadius);
      return true;
    }
  }
  return false;
}

/**
 * fleeFrom
 *
 * @param {Creep} creep Archer executing emergency retreat.
 * @param {Array<RoomObject>} fromThings Threats to flee from.
 * @param {number} safeRange Range to maintain.
 * @return {void}
 * Preconditions: PathFinder available.
 * Postconditions: Issues move/friendly swap to escape; may attempt reverse fallback.
 * Side-effects: Uses TaskSquad.tryFriendlySwap if available to avoid blocking allies.
 */
function fleeFrom(creep, fromThings, safeRange){
  // [1] Translate threats into PathFinder goals describing avoidance radius.
  var goals = (fromThings || []).map(function (t){ return { pos: t.pos, range: safeRange }; });

  // [2] Compute flee path using roomCallback to respect terrain and friendly ramparts.
  var res = PathFinder.search(creep.pos, goals, {
    flee: true,
    maxOps: CONFIG.maxOps,
    roomCallback: function (roomName) {
      if (BeeToolbox && BeeToolbox.roomCallback) return BeeToolbox.roomCallback(roomName);
      var room = Game.rooms[roomName]; if (!room) return false;
      var costs = new PathFinder.CostMatrix();
      room.find(FIND_STRUCTURES).forEach(function (s){
        if (s.structureType===STRUCTURE_ROAD) costs.set(s.pos.x,s.pos.y,1);
        else if (s.structureType!==STRUCTURE_CONTAINER && (s.structureType!==STRUCTURE_RAMPART || !s.my)) costs.set(s.pos.x,s.pos.y,0xFF);
      });
      return costs;
    }
  });

  // [3] Follow the first step of the flee path, optionally swapping with allies for smooth retreat.
  if (res && res.path && res.path.length){
    var step = res.path[0];
    if (step){
      var np = new RoomPosition(step.x, step.y, creep.pos.roomName);
      debugLine(creep.pos, np, CONFIG.COLORS.FLEE, "flee");
      if (!TaskSquad.tryFriendlySwap || !TaskSquad.tryFriendlySwap(creep, np)){
        creep.move(creep.pos.getDirectionTo(step));
      }
      return;
    }
  }

  // [4] Emergency backup plan when PathFinder fails: step directly opposite closest invader.
  var bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, { filter: function (h) { return _canShootTarget(creep, h); } });
  if (bad){
    var dir = creep.pos.getDirectionTo(bad);
    var zero = (dir - 1 + 8) % 8;
    var back = ((zero + 4) % 8) + 1;
    creep.move(back);
  }
}

// ==========================
// Shooter policies
// ==========================
/**
 * shootPrimary
 *
 * @param {Creep} creep Archer performing attack.
 * @param {Creep|Structure} target Shared squad target.
 * @return {void}
 * Preconditions: target exists and is within vision.
 * Postconditions: Performs rangedMassAttack when surrounded or rangedAttack otherwise.
 * Side-effects: Writes debug visuals.
 */
function shootPrimary(creep, target){
  // [1] Evaluate cluster density to decide between mass attack and single target shot.
  var in3 = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3, { filter: function (h) { return _canShootTarget(creep, h); } });
  if (in3.length >= 3){
    debugSay(creep, "💥 mass");
    creep.rangedMassAttack();
    return;
  }

  // [2] Prefer direct rangedAttack when target within standard range.
  var range = creep.pos.getRangeTo(target);
  if (range <= 3){
    if (!_canShootTarget(creep, target)) return;
    debugLine(creep.pos, target.pos, CONFIG.COLORS.SHOOT, "ranged");
    _safeRangedAttack(creep, target);
    return;
  }

  // [3] Otherwise opportunistically snap-shot closer hostiles.
  shootOpportunistic(creep);
}

/**
 * shootOpportunistic
 *
 * @param {Creep} creep Archer performing quick shot.
 * @return {void}
 */
function shootOpportunistic(creep){
  // [1] Acquire closest invader within 3 tiles and fire if available.
  var closer = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, { filter: function (h) { return _canShootTarget(creep, h); } });
  if (closer && creep.pos.inRangeTo(closer, 3)){
    if (!_canShootTarget(creep, closer)) return;
    debugLine(creep.pos, closer.pos, CONFIG.COLORS.SHOOT, "snap");
    _safeRangedAttack(creep, closer);
  }
}

// ==========================
// Main role
// ==========================
var roleCombatArcher = {
  role: 'CombatArcher',

  /**
   * run — main per-tick behavior for combat archers.
   *
   * @param {Creep} creep Archer creep assigned to a squad.
   * @return {void}
   * Preconditions:
   *  - creep.memory.squadId is set (BeeCombatSquads membership).
   *  - TaskSquad.sharedTarget/getAnchor available (fails gracefully otherwise).
   * Postconditions:
   *  - creep.memory.state transitions among 'rally'|'advance'|'engage'.
   *  - creep.memory.archer stores target tracking data (tX/tY/tR/lastSeen/movedAt).
   * Side-effects:
   *  - Issues rangedAttack/rangedMassAttack commands.
   *  - Moves via TaskSquad or BeeToolbox helpers and may call PathFinder.flee.
   * Edge cases handled: lack of anchor/target, medic delays, tower danger, low HP retreats.
   */
  run: function(creep){
    // [1] Ignore spawn-incomplete creeps; nothing to do yet.
    if (creep.spawning) return;

    // [2] Initialize key memory fields once for deterministic behavior.
    var mem = creep.memory || {};
    if (!mem.state) mem.state = 'rally';
    if (!mem.waitUntil) mem.waitUntil = Game.time + (CONFIG.waitTimeout || 25);

    // Memory schema (comment only):
    // creep.memory = {
    //   state: 'rally'|'advance'|'engage',
    //   waitUntil: number,           // tick until which medic wait applies
    //   assignedAt: number,          // timestamp of latest wait cycle start
    //   targetRoom: string|undefined // optional cross-room drift target
    //   archer: { tX,tY,tR,lastSeen,movedAt } // target tracking breadcrumbs
    // }

    var assignedAt = mem.assignedAt;
    if (assignedAt == null) {
      mem.assignedAt = Game.time;
      assignedAt = Game.time;
    }
    var waited = Game.time - assignedAt;
    var waitTimeout = CONFIG.waitTimeout || 25;
    var waitUntil = mem.waitUntil || 0;
    var anchor = (TaskSquad && TaskSquad.getAnchor) ? TaskSquad.getAnchor(creep) : null;

    // [3] Optionally hold position until medic support arrives (BeeToolbox heuristic).
    var shouldWait = CONFIG.waitForMedic && BeeToolbox && BeeToolbox.shouldWaitForMedic &&
      BeeToolbox.shouldWaitForMedic(creep);
    if (shouldWait && Game.time <= waitUntil && waited < waitTimeout){
      var rf = Game.flags.Rally || Game.flags.MedicRally || anchor;
      if (rf){
        debugSay(creep, "⛺ wait");
        moveSmart(creep, (rf.pos || rf), 0);
      }
      if (CONFIG.DEBUG_LOG && Game.time % 5 === 0){
        console.log('[CombatArcher] waiting for medic', creep.name, 'in', creep.pos.roomName, 'waited', waited, 'ticks');
      }
      return;
    }
    if (!shouldWait || Game.time > waitUntil || waited >= waitTimeout){
      mem.assignedAt = Game.time;
      assignedAt = Game.time;
    }

    // [4] After wait window expires, transition from rally to advance.
    if (Game.time >= waitUntil && mem.state === 'rally') {
      mem.state = 'advance';
    }

    // [5] Acquire shared squad target; fallback to opportunistic harassment when none.
    var target = TaskSquad && TaskSquad.sharedTarget ? TaskSquad.sharedTarget(creep) : null;
    if (target && !_canShootTarget(creep, target)) {
      target = null;
    }
    var waitExpired = Game.time > waitUntil;
    var rallyPos = anchor || (Game.flags.Rally && Game.flags.Rally.pos) || null;
    if (!target){
      var visibleHostiles = creep.room ? creep.room.find(FIND_HOSTILE_CREEPS, { filter: function (h) { return _canShootTarget(creep, h); } }) : [];
      shootOpportunistic(creep);
      if (visibleHostiles && visibleHostiles.length) {
        if (waitExpired) {
          if (mem.state !== 'advance') mem.state = 'advance';
          var chase = creep.pos.findClosestByRange(visibleHostiles);
          if (chase) moveSmart(creep, chase.pos, CONFIG.desiredRange);
        }
      } else {
        if (waitExpired) {
          if (mem.state !== 'advance') mem.state = 'advance';
          var drift = rallyPos;
          if (!drift && mem.targetRoom) {
            drift = new RoomPosition(25, 25, mem.targetRoom);
          }
          if (drift) moveSmart(creep, drift, 1);
        } else if (rallyPos) {
          moveSmart(creep, rallyPos, 0);
        }
      }
      return;
    }

    // [6] Visualize engagement envelope for debugging.
    if (CONFIG.DEBUG_DRAW){
      debugRing(target, CONFIG.COLORS.TARGET, "target", 0.7);
      debugRing(target, CONFIG.COLORS.HOLD, null, CONFIG.desiredRange);
      debugRing(target, CONFIG.COLORS.HOLD, null, CONFIG.desiredRange + CONFIG.holdBand);
    }

    // [7] Track target motion to avoid unnecessary repositioning when enemy stationary.
    var archerMem = creep.memory; if (!archerMem.archer) archerMem.archer = {};
    var A = archerMem.archer;
    var tpos = target.pos;
    var tMoved = !(A.tX === tpos.x && A.tY === tpos.y && A.tR === tpos.roomName);
    A.tX = tpos.x; A.tY = tpos.y; A.tR = tpos.roomName; A.lastSeen = Game.time;

    // [8] Safety gates: retreat when low HP, melee adjacent, or inside tower kill zone.
    var lowHp = (creep.hits / Math.max(1, creep.hitsMax)) < CONFIG.fleeHpPct;
    var dangerAdj = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1, { filter: function (h){
      return _canShootTarget(creep, h) && (h.getActiveBodyparts(ATTACK)>0 || h.getActiveBodyparts(RANGED_ATTACK)>0);
    }}).length > 0;
    var towerBad = inTowerDanger(creep.pos);

    if (lowHp || dangerAdj || towerBad){
      debugSay(creep, "🏃 flee");
      fleeFrom(creep, threatsInRoom(creep.room).concat([target]), 3);
      shootOpportunistic(creep);
      A.movedAt = Game.time;
      return;
    }

    // [9] Act before moving to avoid wasting attack windows.
    shootPrimary(creep, target);

    var range = creep.pos.getRangeTo(target);

    // [10] Update high-level state machine for visibility in Memory (helps medic syncing).
    if (range <= 3) {
      if (mem.state !== 'engage') mem.state = 'engage';
    } else if (mem.state === 'engage') {
      mem.state = 'advance';
    } else if (mem.state === 'rally' && waitExpired) {
      mem.state = 'advance';
    }

    // [11] Respect shuffle cooldown to avoid oscillation when kiting.
    if (typeof A.movedAt === 'number' && (Game.time - A.movedAt) < CONFIG.shuffleCooldown){
      debugSay(creep, "⏸");
      return;
    }

    // [12] Maintain standoff band: hold when stable, otherwise adjust distance.
    if (!tMoved && inHoldBand(range)){
      debugSay(creep, "🪨 hold");
      return;
    }

    var hostilesIn3 = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3, { filter: function (h) { return _canShootTarget(creep, h); } });
    if (hostilesIn3 && hostilesIn3.length && inHoldBand(range)){
      debugSay(creep, "🎯 hold");
      return;
    }

    // [13] Execute hysteresis movement for smooth kiting.
    var moved = false;
    if (range <= CONFIG.kiteIfAtOrBelow){
      debugSay(creep, "↩ kite");
      fleeFrom(creep, [target], 3);
      moved = true;
    } else if (range > (CONFIG.desiredRange + CONFIG.approachSlack)){
      debugSay(creep, "↪ push");
      moveSmart(creep, target.pos, CONFIG.desiredRange);
      moved = true;
    } else {
      // [13.1] Intentionally pause to prevent orbiting when within band.
      debugSay(creep, "🤫 stay");
    }

    if (moved) A.movedAt = Game.time;
  }
};

module.exports = roleCombatArcher;

/**
 * Collaboration Map:
 * - Relies on BeeCombatSquads.sharedTarget() being evaluated before movement so archers
 *   and melees focus fire the same enemy.
 * - Uses BeeCombatSquads.getAnchor() seeded by SquadFlagManager to determine rally points
 *   when no target is available, ensuring synchronized regroup.
 * - Assumes role.CombatMedic.js monitors creep.memory.state and archerMem.archer.lastSeen
 *   to prioritize heals; archer reciprocally kites to keep medic safe.
 * Edge cases noted:
 * - No vision in target room: sharedTarget returns null, causing rally drift instead of blind push.
 * - Enemy dies mid-tick: mem.archer target tracking updates next tick and movement holds.
 * - Wounds healed before action: state machine still recalibrates via waitExpired logic.
 * - Path blocked by ally: TaskSquad stepToward/tryFriendlySwap handles swaps, else BeeTravel fallback.
 * - Flag moved mid-travel: anchor recomputed each tick from BeeCombatSquads.
 */
