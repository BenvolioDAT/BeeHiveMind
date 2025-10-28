var CoreConfig = require('core.config');
var CoreSpawn = require('core.spawn');

var Traveler = null;
try {
  Traveler = require('Traveler');
} catch (error) {
  Traveler = null;
}

function beeExtend(target, source) {
  if (!target || !source) return target;
  for (var key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      target[key] = source[key];
    }
  }
  return target;
}

function beeTravel(creep, target, a3, a4, a5) {
  if (!creep || !target) return ERR_INVALID_TARGET;

  var destination = (target && target.pos) ? target.pos : target;
  var opts = {};

  if (a3 && typeof a3 === 'object') {
    opts = a3;
  } else {
    if (typeof a3 === 'number') opts.range = a3;
    if (a5 && typeof a5 === 'object') beeExtend(opts, a5);
  }

  var options = {
    range: (opts.range != null) ? opts.range : 1,
    ignoreCreeps: (opts.ignoreCreeps != null) ? opts.ignoreCreeps : true,
    useFindRoute: (opts.useFindRoute != null) ? opts.useFindRoute : true,
    stuckValue: (opts.stuckValue != null) ? opts.stuckValue : 2,
    repath: (opts.repath != null) ? opts.repath : 0.05,
    returnData: {}
  };

  beeExtend(options, opts);

  if (Traveler && typeof Traveler.travelTo === 'function') {
    try {
      return Traveler.travelTo(creep, destination, options);
    } catch (err) {
      // fall back to moveTo below
    }
  }

  var destPos = destination;
  if (destPos && destPos.pos) destPos = destPos.pos;
  if (!destPos || destPos.x == null || destPos.y == null || !destPos.roomName) {
    return ERR_INVALID_TARGET;
  }
  return creep.moveTo(destPos, { reusePath: 20, maxOps: 2000 });
}

/* =========================
   Tunables
========================= */
var UpgraderSettings = CoreConfig.settings['Task.Upgrader'];

var UPGRADER_SIGN_TEXT = UpgraderSettings.UPGRADER_SIGN_TEXT;
var UPGRADER_REFILL_DELAY = UpgraderSettings.UPGRADER_REFILL_DELAY;    // ticks to wait after upgrading before fetching energy
var MIN_PICKUP_AMOUNT = UpgraderSettings.MIN_PICKUP_AMOUNT;       // skip tiny dropped piles
var MAX_CONTAINER_RANGE = UpgraderSettings.MAX_CONTAINER_RANGE;
var MAX_LINK_RANGE = UpgraderSettings.MAX_LINK_RANGE;
var MAX_UPGRADE_RANGE = UpgraderSettings.MAX_UPGRADE_RANGE;        // <-- can upgrade up to range 3

/* =========================
   PIB (Predictive Intent Buffer)
========================= */
function pibSet(creep, type, targetId, nextTargetId) {
  creep.memory.pib = { t: type, id: targetId, next: nextTargetId, setAt: Game.time | 0 };
}

function pibClear(creep) {
  creep.memory.pib = null;
}

/**
 * Executes stored PIB intent if still valid.
 * Returns true if an action was performed.
 */
function pibAct(creep) {
  var pib = creep.memory.pib;
  if (!pib) return false;

  var tgt = Game.getObjectById(pib.id);
  if (!tgt) {
    pibClear(creep);
    return false;
  }

  if (creep.pos.getRangeTo(tgt) > 3) {
    beeTravel(creep, tgt);
    return false;
  }

  var rc;
  if (pib.t === 'withdraw') rc = creep.withdraw(tgt, RESOURCE_ENERGY);
  else if (pib.t === 'pickup') rc = creep.pickup(tgt);
  else if (pib.t === 'upgrade') rc = creep.upgradeController(tgt);
  else rc = ERR_INVALID_ARGS;

  if (rc === OK && pib.next) {
    var nxt = Game.getObjectById(pib.next);
    if (nxt) beeTravel(creep, nxt);
  }

  pibClear(creep);
  return rc === OK;
}

/* =========================
   Energy Source Selection
========================= */
function chooseEnergySource(creep, room) {
  var sources = [];
  var controller = room.controller;

  // Containers and links near controller
  var structs = room.find(FIND_STRUCTURES, {
    filter: function(s) {
      if (s.store && s.store[RESOURCE_ENERGY] > 0) {
        if (s.structureType === STRUCTURE_CONTAINER && controller &&
            s.pos.getRangeTo(controller) <= MAX_CONTAINER_RANGE)
          return true;
        if (s.structureType === STRUCTURE_LINK && controller &&
            s.pos.inRangeTo(controller, MAX_LINK_RANGE))
          return true;
      }
      return false;
    }
  });
  Array.prototype.push.apply(sources, structs);

  // Dropped energy piles
  var drops = room.find(FIND_DROPPED_RESOURCES, {
    filter: function(r) {
      return r.resourceType === RESOURCE_ENERGY && r.amount >= MIN_PICKUP_AMOUNT;
    }
  });
  Array.prototype.push.apply(sources, drops);

  // Generic containers with energy
  var containers = room.find(FIND_STRUCTURES, {
    filter: function(s) {
      return s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] > 0;
    }
  });
  Array.prototype.push.apply(sources, containers);

  // Storage fallback
  if (room.storage && room.storage.store[RESOURCE_ENERGY] > 0)
    sources.push(room.storage);

  if (sources.length === 0) return null;

  // Choose best by weighted score: high energy, short distance
  var best = null;
  var bestScore = -99999;
  for (var i = 0; i < sources.length; i++) {
    var s = sources[i];
    var amt = s.amount || (s.store ? s.store[RESOURCE_ENERGY] : 0) || 0;
    var range = creep.pos.getRangeTo(s);
    var score = amt - range * 10; // weight energy more, distance less
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

/* =========================
   Controller Sign Helper
========================= */
function updateControllerSign(creep, controller) {
  if (!controller) return;
  if (!controller.sign || controller.sign.text !== UPGRADER_SIGN_TEXT) {
    if (creep.pos.inRangeTo(controller, 1))
      creep.signController(controller, UPGRADER_SIGN_TEXT);
    else
      beeTravel(creep, controller);
  }
}

/* =========================
   TaskUpgrader Main Logic
========================= */
var TaskUpgrader = {

  run: function(creep) {
    if (!creep) return;

    var room = creep.room;
    var controller = room.controller;
    var store = creep.store;
    var lastUpgrade = creep.memory.lastUpgradeTick || 0;

    // Try any pending PIB action first
    if (pibAct(creep)) return;

    /* === STATE SWITCH === */
    if (creep.memory.upgrading && store[RESOURCE_ENERGY] === 0) {
      creep.memory.upgrading = false;
      creep.memory.lastUpgradeTick = Game.time;
    } else if (!creep.memory.upgrading && store.getFreeCapacity() === 0) {
      creep.memory.upgrading = true;
    }

    /* === STATE: UPGRADING === */
    if (creep.memory.upgrading) {
      if (controller) {
        // Skip wasteful upgrading when RCL8 and safe
        if (controller.level === 8 && controller.ticksToDowngrade > 180000)
          return;

        var d = creep.pos.getRangeTo(controller);

        // If too far, move in until within range 3
        if (d > MAX_UPGRADE_RANGE) {
          beeTravel(creep, controller);
          return;
        }

        // Within upgrade range, attempt action
        var rc = creep.upgradeController(controller);
        if (rc === ERR_NOT_IN_RANGE) {
          beeTravel(creep, controller);
          return;
        }

        // Cache predictive intent if at edge of range
        if (d === MAX_UPGRADE_RANGE)
          pibSet(creep, 'upgrade', controller.id, null);

        updateControllerSign(creep, controller);
      }
      return;
    }

    /* === STATE: FETCHING ENERGY === */
    if (Game.time - lastUpgrade < UPGRADER_REFILL_DELAY) {
      creep.say('⏳ recharge');
      return;
    }

    var src = chooseEnergySource(creep, room);
    if (!src) {
      // Nothing found, idle near controller
      if (controller) beeTravel(creep, controller);
      return;
    }

    var dist = creep.pos.getRangeTo(src);
    var isDrop = (src.amount != null);
    var nextTarget = controller ? controller.id : null;

    if (dist > 1) {
      if (dist === 2)
        pibSet(creep, isDrop ? 'pickup' : 'withdraw', src.id, nextTarget);
      beeTravel(creep, src);
      return;
    }

    var rc2 = isDrop ? creep.pickup(src) : creep.withdraw(src, RESOURCE_ENERGY);
    if (rc2 === ERR_NOT_IN_RANGE) {
      beeTravel(creep, src);
      return;
    }
    if (rc2 === OK && controller)
      beeTravel(creep, controller);
  }

};

module.exports = TaskUpgrader;

function upgraderBody(workCount, carryCount, moveCount) {
  var body = [];
  var i;
  for (i = 0; i < workCount; i++) body.push(WORK);
  for (i = 0; i < carryCount; i++) body.push(CARRY);
  for (i = 0; i < moveCount; i++) body.push(MOVE);
  return body;
}

var UPGRADER_BODY_TIERS = [
  upgraderBody(8, 8, 8),
  upgraderBody(8, 7, 7),
  upgraderBody(8, 6, 6),
  upgraderBody(8, 5, 5),
  upgraderBody(8, 4, 4),
  upgraderBody(7, 4, 4),
  upgraderBody(6, 4, 4),
  upgraderBody(5, 4, 4),
  upgraderBody(4, 4, 4),
  upgraderBody(4, 3, 4),
  upgraderBody(3, 2, 4),
  upgraderBody(3, 1, 4),
  upgraderBody(2, 1, 3),
  upgraderBody(1, 1, 2),
  upgraderBody(1, 1, 1)
];

module.exports.BODY_TIERS = UPGRADER_BODY_TIERS.map(function (tier) { return tier.slice(); });
module.exports.getSpawnBody = function (energy) {
  return CoreSpawn.pickLargestAffordable(UPGRADER_BODY_TIERS, energy);
};
module.exports.getSpawnSpec = function (room, ctx) {
  var context = ctx || {};
  var energy = context.availableEnergy;
  var body = module.exports.getSpawnBody(energy, room, context);
  return {
    body: body,
    namePrefix: 'upgrader',
    memory: { role: 'Worker_Bee', task: 'upgrader', home: room && room.name }
  };
};
