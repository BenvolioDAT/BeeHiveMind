// role.CombatMelee.js 🐝 — Smarter up-close fighter
var BeeToolbox = require('BeeToolbox');

const CONFIG = {
  focusSticky: 15,        // ticks to stick to a chosen target
  fleeHpPct: 0.35,        // pull back if under 35% HP
  towerAvoidRadius: 20,   // distance treated as "tower danger"
  maxRooms: 2,            // don’t chase across the world
  reusePath: 10,
  maxOps: 2000,
  waitForMedic: false,    // set true to hover near medic if available
  doorBash: true,         // attack blocking ramparts/walls if they gate the target
  edgePenalty: 8,         // discourage standing on exits (0/49 tiles)
};

const CombatMelee = {
  run(creep) {
    if (creep.spawning) return;

    // 0) optional: don't sprint ahead of your gauze buddy
    if (CONFIG.waitForMedic && BeeToolbox && BeeToolbox.shouldWaitForMedic && BeeToolbox.shouldWaitForMedic(creep)) {
      creep.say('⏳💉');
      const rally = Game.flags.Rally || Game.flags.MedicRally;
      if (rally) this._moveSmart(creep, rally.pos, 0);
      return;
    }

    // 1) emergency: bail if low HP or deep in tower range
    const lowHp = (creep.hits / creep.hitsMax) < CONFIG.fleeHpPct;
    if (lowHp || this._inTowerDanger(creep.pos)) {
      this._flee(creep);
      // swing if something’s adjacent while falling back
      const adjHostile = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1)[0];
      if (adjHostile) creep.attack(adjHostile);
      creep.say('🛡️↩️');
      return;
    }

    // 2) get/keep a focus target
    let target = this._getFocus(creep);
    if (!target) {
      target = this._pickTarget(creep);
      if (target) this._setFocus(creep, target);
    } else if (!this._isGoodTarget(target)) {
      this._clearFocus(creep);
      target = this._pickTarget(creep);
      if (target) this._setFocus(creep, target);
    }

    // 3) nothing to hit? rally
    if (!target) {
      const rallyFlag = Game.flags['Rally'] || Game.flags['MedicRally'];
      if (rallyFlag) this._moveSmart(creep, rallyFlag.pos, 0);
      creep.say('🏳️');
      return;
    }

    // 4) if already adjacent: attack + micro-step to safer adjacent tile (if needed)
    if (creep.pos.isNearTo(target)) {
      creep.attack(target);

      // micro: if our tile is spicy, shuffle to a safer neighbor around the same target
      const best = this._bestAdjacentTile(creep, target);
      if (best && (best.x !== creep.pos.x || best.y !== creep.pos.y)) {
        creep.move(creep.pos.getDirectionTo(best));
      }
      return;
    }

    // 5) approach: if a rampart/wall is the door, smash it; else path to 1 range
    if (CONFIG.doorBash) {
      const blocker = this._blockingDoor(creep, target);
      if (blocker && creep.pos.isNearTo(blocker)) {
        creep.attack(blocker);
        creep.say('🚪🔨');
        return;
      }
    }

    // normal close-in with safety-aware path costs
    this._moveSmart(creep, target.pos, 1);

    // opportunistic hit if someone steps into melee during approach
    const adj = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1)[0];
    if (adj) creep.attack(adj);

    // 6) refresh stickiness or swap if a super-weak enemy is right here
    if (Game.time % 3 === 0) {
      const weak = this._weakestIn1to2(creep);
      if (weak && (!target || weak.id !== target.id) && (weak.hits / weak.hitsMax) < 0.5) {
        this._setFocus(creep, weak);
      }
    }
  },

  // ---------- Targeting ----------
  _pickTarget(creep) {
    const room = creep.room;
    if (!room) return null;

    const hostiles = room.find(FIND_HOSTILE_CREEPS);
    if (hostiles.length) {
      const scored = _.map(hostiles, h => {
        // don’t chase ghosts behind far ramparts if we can help it
        const dist = creep.pos.getRangeTo(h);
        const healer = h.getActiveBodyparts(HEAL) > 0 ? -400 : 0;
        const ranged = h.getActiveBodyparts(RANGED_ATTACK) > 0 ? -250 : 0;
        const melee  = h.getActiveBodyparts(ATTACK) > 0 ? -120 : 0;
        const tough  = h.getActiveBodyparts(TOUGH) > 0 ? +30  : 0;   // tanks later
        const hurt   = (1 - h.hits / h.hitsMax) * -150;              // wounded first
        const tower  = this._inTowerDanger(h.pos) ? +80 : 0;         // risky targets later
        const s = healer + ranged + melee + tough + hurt + tower + dist;
        return { h, s };
      });
      const best = _.min(scored, 's');
      return best && best.h || null;
    }

    // fallback to structures: towers/spawns first
    const prio = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_TOWER || s.structureType === STRUCTURE_SPAWN
    });
    if (prio.length) return creep.pos.findClosestByRange(prio);

    const others = room.find(FIND_HOSTILE_STRUCTURES);
    return others.length ? creep.pos.findClosestByRange(others) : null;
  },

  _isGoodTarget(t) {
    return t && t.hits !== undefined && t.hits > 0 && t.pos;
  },
  _setFocus(creep, t) {
    creep.memory.focusId = t.id;
    creep.memory.focusAt = Game.time;
  },
  _clearFocus(creep) { delete creep.memory.focusId; delete creep.memory.focusAt; },
  _getFocus(creep) {
    const id = creep.memory.focusId;
    const at = creep.memory.focusAt || 0;
    if (!id) return null;
    if (Game.time - at > CONFIG.focusSticky) return null;
    const obj = Game.getObjectById(id);
    return this._isGoodTarget(obj) ? obj : null;
  },

  // ---------- Movement & Micro ----------
  _moveSmart(creep, targetPos, range) {
    if (!targetPos) return;
    creep.moveTo(targetPos, {
      range,
      reusePath: CONFIG.reusePath,
      maxRooms: CONFIG.maxRooms,
      maxOps: CONFIG.maxOps,
      plainCost: 2,
      swampCost: 6,
      costCallback: (roomName, matrix) => {
        const room = Game.rooms[roomName];
        if (!room) return matrix;
        // prefer roads
        room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_ROAD })
            .forEach(r => matrix.set(r.pos.x, r.pos.y, 1));
        // avoid enemy towers
        const towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER });
        for (const t of towers) {
          const r = CONFIG.towerAvoidRadius;
          for (let dx = -r; dx <= r; dx++) {
            for (let dy = -r; dy <= r; dy++) {
              const x = t.pos.x + dx, y = t.pos.y + dy;
              if (x < 0 || x > 49 || y < 0 || y > 49) continue;
              matrix.set(x, y, Math.max(matrix.get(x, y), 255));
            }
          }
        }
        // let your BeeToolbox add extra weights (ramparts, blocked lanes, etc.)
        if (BeeToolbox && BeeToolbox.roomCallback) {
          const m2 = BeeToolbox.roomCallback(roomName);
          if (m2) {
            // merge in lower costs (favor stricter blocks)
            for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) {
              const v = m2.get(x, y);
              if (v) matrix.set(x, y, Math.max(matrix.get(x, y), v));
            }
          }
        }
        return matrix;
      }
    });
  },

  _bestAdjacentTile(creep, target) {
    // score 8 neighbors around us if they remain adjacent to the target
    let best = creep.pos, bestScore = Infinity;
    const room = creep.room;
    const threats = this._hostileMeleeNear(room, 2);

    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      const x = creep.pos.x + dx, y = creep.pos.y + dy;
      if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;  // hard avoid edges
      const pos = new RoomPosition(x, y, creep.room.name);
      if (!pos.isNearTo(target)) continue;                    // must stay in melee
      // impassable?
      const look = pos.look();
      if (look.some(o => o.type === LOOK_TERRAIN && o.terrain === 'wall')) continue;
      if (look.some(o => o.type === LOOK_STRUCTURES && o.structure.structureType !== STRUCTURE_ROAD && o.structure.structureType !== STRUCTURE_CONTAINER && (o.structure.structureType !== STRUCTURE_RAMPART || !o.structure.my))) continue;

      // score: fewer adjacent enemy melee, avoid towers, avoid exit rim, prefer roads
      let score = 0;
      const meleeNear = threats.filter(h => h.pos.getRangeTo(pos) <= 1).length;
      score += meleeNear * 20;
      if (this._inTowerDanger(pos)) score += 50;
      if (x === 0 || x === 49 || y === 0 || y === 49) score += CONFIG.edgePenalty;
      // road bonus
      if (look.some(o => o.type === LOOK_STRUCTURES && o.structure.structureType === STRUCTURE_ROAD)) score -= 1;

      if (score < bestScore) { bestScore = score; best = pos; }
    }
    return best;
  },

  _flee(creep) {
    const rally = Game.flags.MedicRally || Game.flags.Rally;
    if (rally) {
      this._moveSmart(creep, rally.pos, 1);
    } else {
      // generic backward step away from closest hostile
      const bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
      if (bad) creep.move((creep.pos.getDirectionTo(bad) + 4) % 8);
    }
  },

  // ---------- Doors & Blockers ----------
  _blockingDoor(creep, target) {
    // If path to target is blocked by enemy rampart/wall at range 1, return that structure.
    // We’ll only bash if we are already next to it (cheap check).
    const closeStructs = creep.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: s => (s.structureType === STRUCTURE_RAMPART && !s.my) || s.structureType === STRUCTURE_WALL
    });
    if (!closeStructs.length) return null;

    // Only count as a "door" if stepping onto/through it would reduce the distance to target meaningfully
    const best = _.min(closeStructs, s => s.pos.getRangeTo(target));
    if (!best) return null;

    const distNow = creep.pos.getRangeTo(target);
    const distIfThrough = best.pos.getRangeTo(target);
    if (distIfThrough < distNow) return best;
    return null;
  },

  // ---------- Utils ----------
  _inTowerDanger(pos) {
    const room = Game.rooms[pos.roomName];
    if (!room) return false;
    const towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER });
    return towers.some(t => t.pos.getRangeTo(pos) <= CONFIG.towerAvoidRadius);
  },

  _hostileMeleeNear(room, r) {
    if (!room) return [];
    return room.find(FIND_HOSTILE_CREEPS, { filter: h => h.getActiveBodyparts(ATTACK) > 0 && h.hits > 0 });
  },

  _weakestIn1to2(creep) {
    const xs = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 2);
    if (!xs.length) return null;
    return _.min(xs, c => c.hits / c.hitsMax);
  }
};

module.exports = CombatMelee;



// role.CombatMedic.js 🐝 — Smarter dedicated healer
var BeeToolbox = require('BeeToolbox');

const CONFIG = {
  followRange: 1,            // stand next to the buddy if safe
  triageRange: 3,            // look this far for other injured allies
  criticalPct: 0.6,          // below 60% HP = critical triage
  fleePct: 0.35,             // if medic HP below this, enter flee mode
  stickiness: 25,            // ticks to "stick" to a target before reconsidering
  reusePath: 10,
  maxRooms: 2,               // don't wander across the continent chasing one guy
  towerAvoidRadius: 20,      // keep distance from known hostile towers
  maxMedicsPerTarget: 1      // 1 = exclusive pairing; bump if you expect heavy focus fire
};

const CombatRoles = new Set(['CombatMelee', 'CombatArcher', 'Dismantler']);

const TaskCombatMedic = {
  run(creep) {
    if (creep.spawning) return;

    // ---- 0) quick helpers we reuse -----------------------------------------
    const now = Game.time;
    const bodyHeal = creep.getActiveBodyparts(HEAL);
    const canStrongHeal = bodyHeal > 0;

    function isPassable(pos) {
      if (!pos || pos.x <= 0 || pos.x >= 49 || pos.y <= 0 || pos.y >= 49) return false;
      const terrain = pos.lookFor(LOOK_TERRAIN)[0];
      if (terrain === 'wall') return false;
      const structs = pos.lookFor(LOOK_STRUCTURES);
      return !structs.some(s => s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART && !s.my);
    }

    function inTowerDanger(pos) {
      const room = pos.roomName && Game.rooms[pos.roomName];
      if (!room) return false;
      const towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER });
      if (!towers.length) return false;
      return towers.some(t => t.pos.getRangeTo(pos) <= CONFIG.towerAvoidRadius);
    }

    function moveSmart(targetPos, range) {
      if (!targetPos) return ERR_NO_PATH;
      return creep.moveTo(targetPos, {
        range: range,
        reusePath: CONFIG.reusePath,
        maxRooms: CONFIG.maxRooms,
        plainCost: 2,
        swampCost: 6, // we still avoid swamps, but aren't allergic
        costCallback: (roomName, matrix) => {
          const room = Game.rooms[roomName];
          if (!room) return matrix;
          // prefer roads
          room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_ROAD })
              .forEach(r => matrix.set(r.pos.x, r.pos.y, 1));
          // avoid towers’ near area
          const towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER });
          for (const t of towers) {
            const r = CONFIG.towerAvoidRadius;
            for (let dx = -r; dx <= r; dx++) {
              for (let dy = -r; dy <= r; dy++) {
                const x = t.pos.x + dx, y = t.pos.y + dy;
                if (x < 0 || x > 49 || y < 0 || y > 49) continue;
                if (matrix.get(x, y) < 0xFF) matrix.set(x, y, 255); // super expensive
              }
            }
          }
          return matrix;
        }
      });
    }

    function nearEdge(p) {
      return p.x === 0 || p.x === 49 || p.y === 0 || p.y === 49;
    }

    function lowestInRange(origin, range) {
      const allies = origin.findInRange(FIND_MY_CREEPS, range, {
        filter: a => a.hits < a.hitsMax
      });
      if (!allies.length) return null;
      return _.min(allies, a => a.hits / a.hitsMax);
    }

    function findCombatBuddy() {
      // Prefer a previously assigned target if valid
      let tgt = Game.getObjectById(creep.memory.followTarget);
      if (tgt && tgt.memory && CombatRoles.has(tgt.memory.task) && tgt.hits > 0) return tgt;

      // Otherwise pick a combat role without a medic (or under the cap)
      let candidate = _.find(Game.creeps, (ally) => {
        if (!ally.memory || !CombatRoles.has(ally.memory.task) || ally.hits <= 0) return false;
        const count = countMedicsOn(ally.id);
        return count < CONFIG.maxMedicsPerTarget;
      });

      if (candidate) {
        creep.memory.followTarget = candidate.id;
        creep.memory.assignedAt = now;
        candidate.memory.medicId = creep.id; // legacy tag (still fine)
      }
      return candidate || null;
    }

    function countMedicsOn(targetId) {
      let n = 0;
      for (const name in Game.creeps) {
        const c = Game.creeps[name];
        if (c.memory && c.memory.task === 'CombatMedic' && c.memory.followTarget === targetId) n++;
      }
      return n;
    }

    // ---- 1) Self-heal if damaged (always do this first) ---------------------
    if (creep.hits < creep.hitsMax && canStrongHeal) {
      creep.heal(creep);
      creep.say('⚕️me');
      // still run logic (don’t early return); we can move while healing self
    }

    // ---- 2) pick/validate buddy --------------------------------------------
    let buddy = findCombatBuddy();
    if (!buddy) {
      // no buddy: go rally
      const f = Game.flags['MedicRally'];
      if (f) moveSmart(f.pos, 0);
      return;
    }

    // If the buddy is in another room or on an exit, rush but avoid edge-stuck
    if (creep.pos.roomName !== buddy.pos.roomName || nearEdge(buddy.pos)) {
      moveSmart(buddy.pos, 1);
      // opportunistic ranged heal while traveling
      const triageTravel = lowestInRange(creep.pos, 3);
      if (triageTravel && triageTravel.id !== buddy.id) creep.rangedHeal(triageTravel);
      creep.say('🚑→');
      return;
    }

    // ---- 3) danger check -> flee mode ---------------------------------------
    const underHp = (creep.hits / creep.hitsMax) < CONFIG.fleePct;
    const hostilesNear = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3, {
      filter: h => h.getActiveBodyparts(ATTACK) > 0 || h.getActiveBodyparts(RANGED_ATTACK) > 0
    });
    const needToFlee = underHp || (hostilesNear.length && inTowerDanger(creep.pos));

    if (needToFlee) {
      // Flee away from nearest threat but bias toward staying near the buddy
      const closestBad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
      if (closestBad) {
        const flee = PathFinder.search(creep.pos, [{ pos: closestBad.pos, range: 4 }], { flee: true });
        if (!flee.incomplete && flee.path.length) {
          creep.move(creep.pos.getDirectionTo(flee.path[0]));
        } else {
          // fallback: step away from the hostile direction
          const dir = creep.pos.getDirectionTo(closestBad);
          creep.move((dir + 4) % 8); // opposite-ish
        }
      } else {
        moveSmart(buddy.pos, 3); // no visible bad guys: kite near buddy
      }
      // keep healing while fleeing
      const triageFlee = lowestInRange(creep.pos, 3);
      if (triageFlee) {
        if (creep.pos.isNearTo(triageFlee)) creep.heal(triageFlee);
        else creep.rangedHeal(triageFlee);
      } else if (creep.pos.inRangeTo(buddy, 3)) {
        creep.rangedHeal(buddy);
      }
      creep.say('🏃‍♂️💉');
      return;
    }

    // ---- 4) triage: heal the most injured ally in 3 tiles -------------------
    const critical = lowestInRange(creep.pos, CONFIG.triageRange);
    if (critical && (critical.hits / critical.hitsMax) <= CONFIG.criticalPct && critical.id !== buddy.id) {
      // move towards and heal critical ally; keep buddy in mind
      if (creep.pos.isNearTo(critical)) {
        creep.heal(critical);
      } else {
        moveSmart(critical.pos, 1);
        if (creep.pos.inRangeTo(critical, 3)) creep.rangedHeal(critical);
      }
      creep.say('🚑➡️');
      // don’t return; after we act we can also drift back toward buddy
    }

    // ---- 5) stay glued to buddy; pick safest adjacent tile ------------------
    // prefer being adjacent but not inside a hostile cluster or on an exit
    const desiredRange = CONFIG.followRange;
    if (!creep.pos.inRangeTo(buddy, desiredRange)) {
      moveSmart(buddy.pos, desiredRange);
    }

    // opportunistic heal: buddy > others, melee > ranged
    if (creep.pos.isNearTo(buddy)) {
      if (buddy.hits < buddy.hitsMax) creep.heal(buddy);
      else {
        const other = lowestInRange(creep.pos, 1);
        if (other) creep.heal(other);
      }
    } else if (creep.pos.inRangeTo(buddy, 3)) {
      if (buddy.hits < buddy.hitsMax) creep.rangedHeal(buddy);
      else {
        const other3 = lowestInRange(creep.pos, 3);
        if (other3) creep.rangedHeal(other3);
      }
    }

    // ---- 6) housekeeping: drop stale assignment if buddy is gone/healthy ----
    if (buddy.hits === 0 || !buddy.exists) {
      delete creep.memory.followTarget;
      delete creep.memory.assignedAt;
    } else if (creep.memory.assignedAt && (now - creep.memory.assignedAt) > CONFIG.stickiness) {
      // Consider switching if there’s a much more injured ally in triage range
      const inj = lowestInRange(creep.pos, CONFIG.triageRange);
      if (inj && (inj.hits / inj.hitsMax) < 0.5 && inj.id !== buddy.id) {
        delete creep.memory.followTarget;
        delete creep.memory.assignedAt;
      } else {
        // refresh timer to remain sticky
        creep.memory.assignedAt = now;
      }
    }
  },

  // still supports your original check (and we use it internally)
  isTargetAssigned(targetId) {
    return Object.values(Game.creeps).some(ally => {
      return ally.memory.task === 'CombatMedic' && ally.memory.followTarget === targetId;
    });
  }
};

module.exports = TaskCombatMedic;





// role.CombatArcher.js 🐝 — Smarter kiting archer
var BeeToolbox = require('BeeToolbox');

const CONFIG = {
  desiredRange: 2,        // ideal standoff distance
  kiteIfAtOrBelow: 2,     // if target ≤ this range, back off
  fleeHpPct: 0.40,        // archer flees if HP under 40%
  focusSticky: 15,        // ticks to stick to a chosen target before reconsidering
  maxRooms: 2,            // don't chase across the world
  reusePath: 10,
  maxOps: 2000,
  towerAvoidRadius: 20,   // treat tiles near enemy towers as lava
  waitForMedic: false,    // set true to dawdle until a medic is near
};

const TaskCombatArcher = {
  run(creep) {
    if (creep.spawning) return;

    // (0) Optional: don't run ahead of your band-aid buddy
    if (CONFIG.waitForMedic && BeeToolbox && BeeToolbox.shouldWaitForMedic && BeeToolbox.shouldWaitForMedic(creep)) {
      creep.say('⏳💉');
      const rally = Game.flags.Rally || Game.flags.MedicRally;
      if (rally) this._moveSmart(creep, rally.pos, 0);
      return;
    }

    // (1) emergency checks: low HP or too many teeth nearby? Flee first.
    const threats = this._threats(creep.room);
    const lowHp = (creep.hits / creep.hitsMax) < CONFIG.fleeHpPct;
    const brawlersClose = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 2, {
      filter: h => h.getActiveBodyparts(ATTACK) > 0
    }).length > 0;

    if (lowHp || brawlersClose || this._inTowerDanger(creep.pos)) {
      this._flee(creep, threats, 3);
      this._combatAction(creep, null); // still try to splash while fleeing
      creep.say('🏃‍♂️🏹');
      return;
    }

    // (2) pick/maintain a focus target
    let target = this._getFocus(creep);
    if (!target) {
      target = this._pickTarget(creep) || (BeeToolbox && BeeToolbox.findAttackTarget ? BeeToolbox.findAttackTarget(creep) : null);
      if (target) this._setFocus(creep, target);
    } else if (!this._isGoodTarget(target)) {
      this._clearFocus(creep);
      target = this._pickTarget(creep);
      if (target) this._setFocus(creep, target);
    }

    // (3) if nothing to shoot, rally up
    if (!target) {
      const rally = Game.flags.Rally || Game.flags.MedicRally;
      if (rally) this._moveSmart(creep, rally.pos, 0);
      creep.say('🏳️');
      return;
    }

    // (4) fight: shoot first, then move
    const range = creep.pos.getRangeTo(target);
    const many = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3).length;

    // Prefer mass attack when it beats single target (simple but effective rule)
    if (many >= 3 || creep.pos.findInRange(FIND_HOSTILE_CREEPS, 2).length >= 2) {
      if (range <= 3) creep.rangedMassAttack();
    } else if (range <= 3) {
      creep.rangedAttack(target);
    }

    // (5) positioning: kite or close to ideal range, avoiding towers/edges
    if (range <= CONFIG.kiteIfAtOrBelow) {
      this._flee(creep, threats.concat([target]), 3);
      creep.say('↩️🏹');
    } else if (range > CONFIG.desiredRange) {
      this._moveSmart(creep, target.pos, CONFIG.desiredRange);
      creep.say('→→');
    } else {
      // hold or strafe slightly toward safer tiles (optional tiny nudge)
      this._strafeIfBad(creep, threats);
    }

    // (6) refresh sticky focus window; allow switching if something is way weaker nearby
    if (Game.time % 3 === 0) {
      const weaker = this._weakestIn3(creep);
      if (weaker && (weaker.hits / weaker.hitsMax) < 0.5 && (!target || weaker.id !== target.id)) {
        this._setFocus(creep, weaker);
      }
    }
  },

  // ---------------- helpers ----------------
  _isGoodTarget(t) {
    return t && t.hits > 0 && t.pos && t.pos.roomName;
  },
  _setFocus(creep, t) {
    creep.memory.focusId = t.id;
    creep.memory.focusAt = Game.time;
  },
  _clearFocus(creep) {
    delete creep.memory.focusId;
    delete creep.memory.focusAt;
  },
  _getFocus(creep) {
    const id = creep.memory.focusId;
    const at = creep.memory.focusAt || 0;
    if (!id) return null;
    if (Game.time - at > CONFIG.focusSticky) return null;
    const obj = Game.getObjectById(id);
    return this._isGoodTarget(obj) ? obj : null;
  },

  _pickTarget(creep) {
    const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
    if (!hostiles.length) {
      // shoot hostile structures if any (towers/spawns first)
      const prio = creep.room.find(FIND_HOSTILE_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_TOWER || s.structureType === STRUCTURE_SPAWN
      });
      if (prio.length) return creep.pos.findClosestByRange(prio);
      return null;
    }

    // score targets: lower = better
    const scored = _.map(hostiles, h => {
      const dist = creep.pos.getRangeTo(h);
      const healer = h.getActiveBodyparts(HEAL) > 0 ? -300 : 0;
      const ranged = h.getActiveBodyparts(RANGED_ATTACK) > 0 ? -200 : 0;
      const melee  = h.getActiveBodyparts(ATTACK) > 0 ? -120 : 0;
      const tough  = h.getActiveBodyparts(TOUGH) > 0 ? +10 : 0; // de-prioritize tanks a smidge
      const hurt   = (1 - h.hits / h.hitsMax) * -120;          // more hurt = lower score
      const score  = healer + ranged + melee + tough + hurt + dist; // distance breaks ties
      return { h, score };
    });

    const best = _.min(scored, 'score');
    return (best && best.h) || null;
  },

  _weakestIn3(creep) {
    const xs = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3);
    if (!xs.length) return null;
    return _.min(xs, c => c.hits / c.hitsMax);
  },

  _threats(room) {
    if (!room) return [];
    const creeps = room.find(FIND_HOSTILE_CREEPS, {
      filter: h => h.getActiveBodyparts(ATTACK) > 0 || h.getActiveBodyparts(RANGED_ATTACK) > 0
    });
    const towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER });
    return creeps.concat(towers);
  },

  _inTowerDanger(pos) {
    const room = Game.rooms[pos.roomName];
    if (!room) return false;
    const towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER });
    return towers.some(t => t.pos.getRangeTo(pos) <= CONFIG.towerAvoidRadius);
  },

  _flee(creep, fromThings, safeRange) {
    const goals = (fromThings || []).map(t => ({ pos: t.pos, range: safeRange }));
    const res = PathFinder.search(
      creep.pos,
      goals,
      {
        flee: true,
        maxOps: CONFIG.maxOps,
        roomCallback: (roomName) => (BeeToolbox && BeeToolbox.roomCallback) ? BeeToolbox.roomCallback(roomName) : this._basicMatrix(roomName)
      }
    );
    if (res && res.path && res.path.length) {
      const step = res.path[0];
      if (step) creep.move(creep.pos.getDirectionTo(step));
    } else {
      // fallback tiny nudge away from nearest hostile
      const bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
      if (bad) creep.move((creep.pos.getDirectionTo(bad) + 4) % 8);
    }
  },

  _moveSmart(creep, targetPos, range) {
    if (!targetPos) return;
    creep.moveTo(targetPos, {
      range: range,
      reusePath: CONFIG.reusePath,
      maxRooms: CONFIG.maxRooms,
      maxOps: CONFIG.maxOps,
      plainCost: 2,
      swampCost: 6,
      costCallback: (roomName, matrix) => {
        const room = Game.rooms[roomName];
        if (!room) return matrix;
        // prefer roads
        room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_ROAD })
            .forEach(r => matrix.set(r.pos.x, r.pos.y, 1));
        // avoid enemy towers
        const towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER });
        for (const t of towers) {
          const r = CONFIG.towerAvoidRadius;
          for (let dx = -r; dx <= r; dx++) {
            for (let dy = -r; dy <= r; dy++) {
              const x = t.pos.x + dx, y = t.pos.y + dy;
              if (x < 0 || x > 49 || y < 0 || y > 49) continue;
              matrix.set(x, y, Math.max(matrix.get(x, y), 255));
            }
          }
        }
        return matrix;
      }
    });
  },

  _basicMatrix(roomName) {
    const room = Game.rooms[roomName];
    if (!room) return false;
    const costs = new PathFinder.CostMatrix();
    room.find(FIND_STRUCTURES).forEach(s => {
      if (s.structureType === STRUCTURE_ROAD) costs.set(s.pos.x, s.pos.y, 1);
      else if (s.structureType !== STRUCTURE_CONTAINER && (s.structureType !== STRUCTURE_RAMPART || !s.my)) {
        costs.set(s.pos.x, s.pos.y, 0xFF);
      }
    });
    return costs;
  },

  _strafeIfBad(creep, threats) {
    // if standing in tower danger or adjacent to melee, try a small lateral move
    const danger = this._inTowerDanger(creep.pos) ||
                   creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1, { filter: h => h.getActiveBodyparts(ATTACK) }).length > 0;
    if (!danger) return;
    this._flee(creep, threats, 2);
  },

  _combatAction(creep/*, targetMayBeNull*/) {
    // "free" opportunistic attack while repositioning
    const many = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3).length;
    if (many >= 3) creep.rangedMassAttack();
    else {
      const closest = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
      if (closest && creep.pos.inRangeTo(closest, 3)) creep.rangedAttack(closest);
    }
  }
};

module.exports = TaskCombatArcher;








