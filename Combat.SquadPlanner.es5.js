'use strict';
 
var BodyConfigs = require('bodyConfigs.combat.es5');
var BeeToolbox; try { BeeToolbox = require('BeeToolbox'); } catch (err) { BeeToolbox = null; }

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
  var key = squadId + '|' + role;
  if (BeeToolbox && BeeToolbox.ensureUniqueReservation) {
    return BeeToolbox.ensureUniqueReservation('squadRole:' + key, RES_TTL);
  }
  var map = _mem();
  if (map[key]) return false;
  map[key] = Game.time;
  return true;
}

function chooseBody(role, energyAvailable, energyCapacity) {
  if (BeeToolbox && BeeToolbox.buildBodyByBudget) {
    return BeeToolbox.buildBodyByBudget(role, energyAvailable, BodyConfigs[role]);
  }
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

function desiredCounts(threatScore, opts) {
  opts = opts || {};
  var energyCap = opts.energyCapacity || 0;
  var threatType = opts.threatType || (threatScore >= 18 ? 'fortress' : 'npc');
  var isFortress = threatType === 'fortress';
  var out = { CombatMelee: 1, CombatMedic: 1, CombatArcher: 0, Dismantler: 0 };

  if (isFortress) {
    if (energyCap >= 1100 || threatScore >= 14) out.CombatArcher = 1;
    if (energyCap >= 1600 || threatScore >= 18) out.CombatArcher = 2;
    if (energyCap >= 1800 || threatScore >= 22) out.CombatMedic = 2;
    if (energyCap >= 2000 || threatScore >= 24) out.Dismantler = 1;
    if (energyCap >= 2600 || threatScore >= 30) out.Dismantler = 2;
    if (threatScore >= 32 || energyCap >= 2400) out.CombatMelee = 2;
  } else {
    if (threatScore >= 8) out.CombatArcher = 1;
    if (threatScore >= 16 && energyCap >= 1300) out.CombatArcher = 2;
    if (threatScore >= 18 && energyCap >= 1200) out.CombatMedic = 2;
    if (threatScore >= 20 && energyCap >= 1600) out.Dismantler = 1;
  }

  if (energyCap < 800) {
    out.CombatArcher = Math.min(out.CombatArcher, 1);
    out.Dismantler = 0;
    out.CombatMedic = 1;
  }

  return out;
}

module.exports = {
  reserveRole: reserveRole,
  chooseBody: chooseBody,
  desiredCounts: desiredCounts,
};
