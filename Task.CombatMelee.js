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
