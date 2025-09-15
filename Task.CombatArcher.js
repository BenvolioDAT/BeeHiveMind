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
