'use strict';

var Handoff = require('role.EnergyHandoff');
var VeinseekerConfig = require('role.Veinseeker.Config');



function shouldBlockRemoteHaulForMaintenance(req) {
  if (!req) return false;
  if (!req.maintenanceUntil || req.maintenanceUntil <= Game.time) return false;

  if (req.maintenanceReason === 'emergencyRemoteRepair') return true;

  if (req.maintenanceReason === 'containerRepair') {
    var criticalPct = (VeinseekerConfig && VeinseekerConfig.remoteContainerRepairCriticalPct) || 0.25;
    var hitsPct = (typeof req.containerHitsPct === 'number') ? req.containerHitsPct : 1;
    var amount = req.amount || 0;
    var capacity = req.capacity || 2000;
    var fillPct = (typeof req.fillPct === 'number') ? req.fillPct : (capacity > 0 ? (amount / capacity) : 0);
    var urgentEnergy = 1600;

    if (hitsPct <= criticalPct) return true;
    // Allow hauling when container is very full and not critically damaged,
    // so Truckers do not ignore remote income during normal Veinseeker upkeep repairs.
    if (amount >= urgentEnergy || fillPct >= 0.8) return false;
    return true;
  }

  return true;
}
module.exports = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,
  PATH_REUSE: 25,
  MIN_HAUL_REQUEST_ENERGY: 300,
  URGENT_HAUL_REQUEST_ENERGY: 1600,
  REQUEST_STALE_TICKS: 50,
  RESERVATION_TTL: 25,
  MAX_TRUCKERS_PER_HOME: 5,
  LOCAL_TRUCKER_BASE_QUOTA: 2,
  LOCAL_CONTAINER_PICKUP_AT: 1000,
  LOCAL_CONTAINER_URGENT_AT: 1600,
  LOCAL_CONTAINER_CRITICAL_AT: 1900,
  MAX_TOTAL_TRUCKERS_PER_HOME: 6,
  MAX_TRUCKERS_PER_REMOTE: 2,
  TOWER_REFILL_AT_OR_BELOW: 0.70,
  HANDOFF_ENABLED: true,
  HANDOFF_MIN_TRUCKER_ENERGY: 25,
  HANDOFF_MIN_RECEIVER_FREE: 25,
  HANDOFF_MAX_RANGE: 30,
  HANDOFF_MAX_FAILS: 3,
  HANDOFF_ASSIGN_TTL: Handoff.HANDOFF.HANDOFF_ASSIGN_TTL,
  HANDOFF_WAIT_TTL: Handoff.HANDOFF.HANDOFF_WAIT_TTL,
  DELIVERY_STORAGE_FIRST: true,
  HUB_CONTAINER_RANGE_FROM_SPAWN: 3,
  TRUCKER_STORAGE_FEEDER_ENABLED: true,
  TRUCKER_HUB_CONTAINER_FEEDER_ENABLED: true,
  IDLE_RANGE: 3,
  shouldBlockRemoteHaulForMaintenance: shouldBlockRemoteHaulForMaintenance
});
