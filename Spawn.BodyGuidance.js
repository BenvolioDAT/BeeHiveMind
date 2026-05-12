'use strict';

// Owns: body guidance and body cap helpers.
// Does not own: queue policy or spawn execution.
// Called by: BeeSpawnManager.

function clampInt(n, min, max) {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function roleBodyGuidance(role, planner, canonicalRole) {
  var canonical = canonicalRole(role);
  if (!canonical || canonical === 'BaseHarvest') return 0;
  if (canonical === 'Scout') return { capIndex: 0, reason: 'SCOUT_FIXED' };
  var p = planner || {};
  var maturity = p.maturity || 'EARLY';
  var economyState = p.economyState || 'CRITICAL';
  var signals = p.signals || {};
  var recoveryBias = !!p.recoveryBias;
  var cap = 0;
  var reason = ['BASE'];

  if (economyState === 'CRITICAL') { cap = 3; reason.push('ECON_CRITICAL'); }
  else if (economyState === 'STRAINED') { cap = 2; reason.push('ECON_STRAINED'); }
  else if (economyState === 'HEALTHY') { cap = 1; reason.push('ECON_HEALTHY'); }
  else { cap = 0; reason.push('ECON_RICH'); }

  if (recoveryBias) { cap += 1; reason.push('RECOVERY_BIAS'); }

  if (canonical === 'Courier') {
    if ((signals.remoteCount || 0) >= 2 && economyState !== 'CRITICAL') {
      cap -= 1;
      reason.push('REMOTE_LOAD');
    }
    if ((signals.remoteCount || 0) === 0 && maturity === 'EARLY') {
      cap += 1;
      reason.push('EARLY_LOCAL_ONLY');
    }
  } else if (canonical === 'Builder') {
    if (signals.buildBacklogBucket === 'CRITICAL') { cap -= 1; reason.push('BUILD_CRITICAL'); }
    else if (signals.buildBacklogBucket === 'HIGH') { reason.push('BUILD_HIGH'); }
    else if (signals.buildBacklogBucket === 'LOW' || signals.buildBacklogBucket === 'NONE') {
      cap += 1;
      reason.push('BUILD_LIGHT');
    }
  } else if (canonical === 'Repair') {
    if (signals.repairBacklogBucket === 'CRITICAL') { cap -= 1; reason.push('REPAIR_CRITICAL'); }
    else if (signals.repairBacklogBucket === 'LOW' || signals.repairBacklogBucket === 'NONE') {
      cap += 1;
      reason.push('REPAIR_LIGHT');
    }
  } else if (canonical === 'Upgrader') {
    if (economyState === 'RICH' && maturity !== 'EARLY') {
      cap -= 1;
      reason.push('UPGRADE_RICH');
    }
    if (economyState === 'CRITICAL' || economyState === 'STRAINED') {
      cap += 1;
      reason.push('UPGRADE_CONSERVE');
    }
  } else if (canonical === 'Luna') {
    if ((signals.remoteCount || 0) >= 2 && (economyState === 'HEALTHY' || economyState === 'RICH')) {
      cap -= 1;
      reason.push('REMOTE_BREADTH');
    }
    if (economyState === 'CRITICAL' || economyState === 'STRAINED') {
      cap += 1;
      reason.push('REMOTE_CONSERVE');
    }
  } else if (canonical === 'Queen') {
    // Stage-4 light touch only: keep queen stable, only soften body in weak states.
    if (economyState === 'CRITICAL' || recoveryBias) {
      cap = Math.max(cap, 1);
      reason.push('QUEEN_RECOVERY_FRIENDLY');
    } else {
      cap = 0;
      reason.push('QUEEN_FULL');
    }
  }

  if (maturity === 'EARLY') { cap = Math.max(cap, 2); reason.push('MAT_EARLY_CAP'); }
  else if (maturity === 'MID') { cap = Math.max(cap, 1); reason.push('MAT_MID_CAP'); }

  cap = clampInt(cap, 0, 5);
  return { capIndex: cap, reason: reason.join('|') };
}

function bodyCapIndexForRole(role, planner, canonicalRole) {
  return roleBodyGuidance(role, planner, canonicalRole).capIndex;
}


module.exports = {
  roleBodyGuidance: roleBodyGuidance,
  bodyCapIndexForRole: bodyCapIndexForRole
};
