'use strict';

// Owns: feedback smoothing, action sampling, and Luna ROI helper math.
// Does not own: quotas or spawn queue policy.
// Called by: BeeSpawnManager.

function emaUpdate(previousValue, sampleValue, alpha) {
  // EMA (exponential moving average) keeps recent samples weighted more heavily.
  if (typeof previousValue !== 'number') return sampleValue;
  return (previousValue * (1 - alpha)) + (sampleValue * alpha);
}

function ensureFeedbackState(debug, feedbackWindowTicks, feedbackAlpha) {
  if (!debug.feedback) {
    debug.feedback = {
      windowTicks: feedbackWindowTicks,
      alpha: feedbackAlpha,
      lastSignals: null,
      roles: {
        Courier: { emaOutput: 0, emaAction: 0, emaCount: 0, emaPerCreep: 0, status: 'INIT', chronic: 0, bias: 0, signalQuality: 'LOW_SAMPLE', signalSource: 'PROXY_ONLY' },
        Builder: { emaOutput: 0, emaAction: 0, emaCount: 0, emaPerCreep: 0, status: 'INIT', chronic: 0, bias: 0, signalQuality: 'LOW_SAMPLE', signalSource: 'PROXY_ONLY' },
        Repair: { emaOutput: 0, emaAction: 0, emaCount: 0, emaPerCreep: 0, status: 'INIT', chronic: 0, bias: 0, signalQuality: 'LOW_SAMPLE', signalSource: 'PROXY_ONLY' },
        Luna: { emaOutput: 0, emaAction: 0, emaCount: 0, emaPerCreep: 0, status: 'INIT', chronic: 0, bias: 0, signalQuality: 'LOW_SAMPLE', signalSource: 'PROXY_ONLY' },
        Upgrader: { emaOutput: 0, emaAction: 0, emaCount: 0, emaPerCreep: 0, status: 'INIT', chronic: 0, bias: 0, signalQuality: 'LOW_SAMPLE', signalSource: 'PROXY_ONLY' }
      },
      chronic: {},
      adjustments: {},
      tuningHints: [],
      lunaROI: null
    };
  }
  return debug.feedback;
}

function collectRoleActionCounts(C, room, canonicalRole) {
  var empty = { Courier: 0, Builder: 0, Repair: 0, Luna: 0, Upgrader: 0, samples: 0, available: false };
  if (!room || typeof room.getEventLog !== 'function') return empty;
  var events = room.getEventLog();
  if (!events || !events.length) return empty;
  var byId = Object.create(null);
  if (C && C.creeps && C.creeps.length) {
    for (var i = 0; i < C.creeps.length; i++) {
      var cr = C.creeps[i];
      if (!cr || !cr.id || !cr.memory) continue;
      var canonical = canonicalRole(cr.memory.role || cr.memory.task);
      if (!canonical) continue;
      byId[cr.id] = canonical;
    }
  }
  var out = { Courier: 0, Builder: 0, Repair: 0, Luna: 0, Upgrader: 0, samples: 0, available: true };
  for (var e = 0; e < events.length; e++) {
    var ev = events[e];
    if (!ev || !ev.objectId) continue;
    var role = byId[ev.objectId];
    if (!role) continue;
    out.samples += 1;
    if (ev.event === EVENT_TRANSFER && role === 'Courier') {
      var amount = ev.data && typeof ev.data.amount === 'number' ? ev.data.amount : 0;
      out.Courier += amount > 0 ? Math.max(1, Math.floor(amount / 100)) : 1;
    } else if (ev.event === EVENT_BUILD && role === 'Builder') out.Builder += 1;
    else if (ev.event === EVENT_REPAIR && role === 'Repair') out.Repair += 1;
    else if (ev.event === EVENT_UPGRADE_CONTROLLER && role === 'Upgrader') out.Upgrader += 1;
    else if ((ev.event === EVENT_HARVEST || ev.event === EVENT_TRANSFER) && role === 'Luna') out.Luna += 1;
  }
  return out;
}

function computeLunaRemoteROI(room, lunaSignal, economy, lunaFeedback) {
  var remotes = lunaSignal && typeof lunaSignal.remoteCount === 'number' ? lunaSignal.remoteCount : 0;
  var sources = lunaSignal && typeof lunaSignal.totalSources === 'number' ? lunaSignal.totalSources : 0;
  if (remotes <= 0) return { score: 0, bucket: 'DISABLED', reasons: ['NO_REMOTES'], hostileRatio: 0, sourcesPerRemote: 0 };
  var hostileLocked = 0;
  var remoteNames = (global.__BHM && global.__BHM.remotesByHome && room && global.__BHM.remotesByHome[room.name]) ? global.__BHM.remotesByHome[room.name] : [];
  var roomsMem = Memory.rooms || {};
  for (var i = 0; i < remoteNames.length; i++) {
    var mem = roomsMem[remoteNames[i]] || {};
    if (mem.hostile) hostileLocked += 1;
    if (mem._invaderLock && mem._invaderLock.locked) hostileLocked += 1;
  }
  if (hostileLocked > remotes) hostileLocked = remotes;
  var hostileRatio = remotes > 0 ? (hostileLocked / remotes) : 0;
  var sourcesPerRemote = remotes > 0 ? (sources / remotes) : 0;
  var score = 0.55;
  var reasons = [];
  score += Math.min(0.20, sourcesPerRemote * 0.08);
  if (sourcesPerRemote >= 1.5) reasons.push('GOOD_SOURCE_DENSITY');
  score -= Math.min(0.30, hostileRatio * 0.45);
  if (hostileRatio > 0.35) reasons.push('HOSTILE_PRESSURE');
  if (economy === 'CRITICAL') { score -= 0.15; reasons.push('ECON_CRITICAL'); }
  else if (economy === 'STRAINED') { score -= 0.08; reasons.push('ECON_STRAINED'); }
  if (lunaFeedback && lunaFeedback.emaPerCreep < 0.20) { score -= 0.08; reasons.push('LOW_LUNA_FEEDBACK'); }
  if (lunaFeedback && lunaFeedback.emaPerCreep > 0.60) { score += 0.05; reasons.push('STRONG_LUNA_FEEDBACK'); }
  score = Math.max(0, Math.min(1, score));
  var bucket = 'FAIR';
  if (score < 0.35) bucket = 'POOR'; else if (score > 0.70) bucket = 'GOOD';
  return { score: score, bucket: bucket, reasons: reasons, hostileRatio: hostileRatio, sourcesPerRemote: sourcesPerRemote };
}

module.exports = { emaUpdate: emaUpdate, ensureFeedbackState: ensureFeedbackState, collectRoleActionCounts: collectRoleActionCounts, computeLunaRemoteROI: computeLunaRemoteROI };
