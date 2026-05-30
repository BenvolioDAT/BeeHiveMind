'use strict';

// Documentation map for this file:
// Owns Memory.rooms[roomName].spawnQueue plus quota diagnostics such as
// lastRoleQuotas, lastTruckerQuota, lastRepairQuota, lastQueenQuota, and
// lastRemoteVision. BeeHiveMind calls manageSpawns(C) once per tick, after role
// logic has had a chance to update haul/status Memory. SourceEnergy.Manager
// provides Veinseeker source reservations and audits; spawn.logic chooses bodies and
// performs spawn.spawnCreep; Combat.Squads supplies combat pressure. Avoid
// changing queue priority, quota math, or the order of Veinseeker reserve/enqueue/
// unreserve calls without checking the SourceEnergy.Manager ownership model.

// BUG FIX (2025-01): Add validation for upgrade-replacement bodies to prevent
// same-body or no-meaningful-upgrade replacements from being queued.
// See: shouldQueueVeinseekerUpgradeReplacement() and copyVeinseekerSourceStatus().

// -------