'use strict';

/**
 * What changed & why:
 * - Rewired towers to consume BeeSelectors repair reservations so creeps and towers draw from one prioritized queue.
 * - Preserved attack/heal behaviors while reducing per-tick scans; all targeting comes from the shared snapshot helpers.
 * - Keeps lightweight visuals and debug toggles without relying on Memory-side repair queues.
 */

var BeeSelectors = require('BeeSelectors');

var CFG = Object.freeze({
  DEBUG_DRAW: true,
  DEBUG_SAY: true,
  ATTACK_MIN: 10,
  HEAL_MIN: 150,
  REPAIR_MIN: 400,
  DRAW: {
    ATK: '#ff6e6e',
    HEAL: '#6ee7ff',
    REP: '#6effa1',
    IDLE: '#bfbfbf'
  }
});

function tsay(tower, msg) {
  if (!CFG.DEBUG_SAY || !tower) return;
  var pos = tower.pos;
  tower.room.visual.text(msg, pos.x, pos.y - 0.9, { color: '#ddd', font: 0.8, align: 'center' });
}

function draw(room, a, b, color) {
  if (!CFG.DEBUG_DRAW || !room || !a || !b) return;
  room.visual.line((a.pos || a), (b.pos || b), { color: color, opacity: 0.6, width: 0.08 });
}

function mark(room, target, color, label) {
  if (!CFG.DEBUG_DRAW || !room || !target) return;
  var pos = target.pos || target;
  room.visual.circle(pos, { radius: 0.5, stroke: color, fill: 'transparent', opacity: 0.5 });
  if (label) {
    room.visual.text(label, pos.x, pos.y - 0.6, { color: color, font: 0.7, align: 'center' });
  }
}

function handleAttack(tower) {
  if ((tower.store[RESOURCE_ENERGY] | 0) < CFG.ATTACK_MIN) return false;
  var hostile = tower.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
  if (!hostile) return false;
  var rc = tower.attack(hostile);
  if (rc === OK) {
    tsay(tower, 'ATK');
    draw(tower.room, tower, hostile, CFG.DRAW.ATK);
    mark(tower.room, hostile, CFG.DRAW.ATK, 'ATK');
    return true;
  }
  return false;
}

function handleHeal(tower) {
  if ((tower.store[RESOURCE_ENERGY] | 0) < CFG.HEAL_MIN) return false;
  var ally = tower.pos.findClosestByRange(FIND_MY_CREEPS, {
    filter: function (c) { return c.hits < c.hitsMax; }
  });
  if (!ally) return false;
  var rc = tower.heal(ally);
  if (rc === OK) {
    tsay(tower, 'HEAL');
    draw(tower.room, tower, ally, CFG.DRAW.HEAL);
    mark(tower.room, ally, CFG.DRAW.HEAL, 'HEAL');
    return true;
  }
  return false;
}

function handleRepair(tower) {
  if ((tower.store[RESOURCE_ENERGY] | 0) < CFG.REPAIR_MIN) return false;
  var entry = BeeSelectors.reserveRepairTarget(tower.room, 'tower:' + tower.id);
  if (!entry || !entry.target) return false;
  var target = entry.target;
  var rc = tower.repair(target);
  if (rc === OK) {
    tsay(tower, 'REP');
    draw(tower.room, tower, target, CFG.DRAW.REP);
    mark(tower.room, target, CFG.DRAW.REP, 'REP');
  }
  return rc === OK;
}

module.exports = {
  run: function () {
    var spawnNames = Object.keys(Game.spawns);
    if (!spawnNames.length) return;
    var spawn = Game.spawns[spawnNames[0]];
    if (!spawn) return;
    var room = spawn.room;
    var towers = room.find(FIND_MY_STRUCTURES, {
      filter: function (s) { return s.structureType === STRUCTURE_TOWER; }
    });
    if (!towers || !towers.length) return;
    for (var i = 0; i < towers.length; i++) {
      var tower = towers[i];
      if (!tower) continue;
      if (handleAttack(tower)) continue;
      if (handleHeal(tower)) continue;
      handleRepair(tower);
    }
  }
};
