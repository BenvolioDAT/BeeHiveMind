'use strict';

function getReservationBucket() {
  if (!global.__BHM) global.__BHM = {};
  if (!global.__BHM.queenReservations || global.__BHM.queenReservations.tick !== Game.time) {
    global.__BHM.queenReservations = { tick: Game.time, map: {} };
  }
  return global.__BHM.queenReservations.map;
}

function reserveFill(targetId, amount) {
  if (!targetId || amount <= 0) return;
  var map = getReservationBucket();
  map[targetId] = (map[targetId] || 0) + amount;
}

function getReserved(targetId) {
  if (!targetId) return 0;
  var map = getReservationBucket();
  return map[targetId] || 0;
}

module.exports = { getReservationBucket: getReservationBucket, reserveFill: reserveFill, getReserved: getReserved };
