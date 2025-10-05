'use strict';

var BodyConfigs = require('bodyConfigs.combat.es5');

var RES_TTL = 1; // reservations reset every tick

function _mem() {
  if (!Memory.squadReservations) Memory.squadReservations = { tick: -1, booked: {} };
  var bucket = Memory.squadReservations;
  if (bucket.tick !== Game.time) {
    bucket.tick = Game.time;
    bucket.booked = {};
  }
  return bucket.booked;
}

function reserveRole(squadId, role) {
  var map = _mem();
  var key = squadId + '|' + role;
  if (map[key]) return false;
  map[key] = true;
  return true;
}

function chooseBody(role, energyAvailable, energyCapacity) {
  var tiers = BodyConfigs[role];
  if (!tiers || !tiers.length) return null;
  var best = null;
  for (var i = 0; i < tiers.length; i++) {
    var tier = tiers[i];
    if (tier.minEnergy <= energyAvailable) {
      best = tier;
      break;
    }
  }
  if (!best) best = tiers[tiers.length - 1];
  return best;
}

function desiredCounts(threatScore) {
  var out = { CombatMelee: 1, CombatMedic: 1, CombatArcher: 0, Dismantler: 0 };
  if (threatScore >= 12) out.CombatArcher = 1;
  if (threatScore >= 18) out.CombatArcher = 2;
  if (threatScore >= 20) out.Dismantler = 1;
  if (threatScore >= 26) out.Dismantler = 2;
  if (threatScore >= 30) out.CombatMedic = 2;
  if (threatScore >= 35) out.CombatMelee = 2;
  return out;
}

module.exports = {
  reserveRole: reserveRole,
  chooseBody: chooseBody,
  desiredCounts: desiredCounts,
};
