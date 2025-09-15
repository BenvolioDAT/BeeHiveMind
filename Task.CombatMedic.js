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
