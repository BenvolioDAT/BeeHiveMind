'use strict';

// Owns: stability/recovery debug state and spawn history band usage.
// Does not own: spawn policy decisions.
// Called by: BeeSpawnManager.

function ensureStabilityState(debug) {
  if (!debug.stability) {
    // Recovery mode tracks prolonged shortages; starvation tracks per-role unmet floors.
    debug.stability = {
      recovery: { active: false, enteredAt: null, clearSince: null, reason: 'INIT' },
      starvation: {
        BaseHarvest: { since: null, duration: 0, unmet: false, lastTick: null },
        Courier: { since: null, duration: 0, unmet: false, lastTick: null },
        Queen: { since: null, duration: 0, unmet: false, lastTick: null },
        Builder: { since: null, duration: 0, unmet: false, lastTick: null },
        Repair: { since: null, duration: 0, unmet: false, lastTick: null }
      }
    };
  }
  if (!Array.isArray(debug.spawnHistory)) debug.spawnHistory = [];
  return debug.stability;
}

function pruneSpawnHistory(debug, historyWindow) {
  if (!debug || !Array.isArray(debug.spawnHistory)) return;
  var cutoff = Game.time - historyWindow;
  var kept = [];
  for (var i = 0; i < debug.spawnHistory.length; i++) {
    var rec = debug.spawnHistory[i];
    if (!rec || typeof rec.t !== 'number') continue;
    if (rec.t < cutoff) continue;
    kept.push(rec);
  }
  debug.spawnHistory = kept;
}

function pushSpawnHistory(debug, role, band, source, reason, historyWindow) {
  if (!debug) return;
  if (!Array.isArray(debug.spawnHistory)) debug.spawnHistory = [];
  debug.spawnHistory.push({ t: Game.time, role: role || 'Unknown', band: band || 'SITUATIONAL', source: source || 'queue', reason: reason || null });
  pruneSpawnHistory(debug, historyWindow);
}

function computeBandUsage(debug, historyWindow) {
  pruneSpawnHistory(debug, historyWindow);
  var counts = { SURVIVAL: 0, ECONOMY: 0, GROWTH: 0, SUPPORT: 0, SITUATIONAL: 0, COMBAT: 0 };
  var total = 0;
  if (!debug || !Array.isArray(debug.spawnHistory)) return { total: 0, counts: counts, shares: { SURVIVAL: 0, ECONOMY: 0, GROWTH: 0, SUPPORT: 0, SITUATIONAL: 0, COMBAT: 0 } };
  for (var i = 0; i < debug.spawnHistory.length; i++) {
    var rec = debug.spawnHistory[i];
    if (!rec || !rec.band || !Object.prototype.hasOwnProperty.call(counts, rec.band)) continue;
    counts[rec.band] += 1; total += 1;
  }
  // Band budget shows recent spawn share by strategic band.
  var shares = {};
  var keys = Object.keys(counts);
  for (var j = 0; j < keys.length; j++) shares[keys[j]] = total > 0 ? (counts[keys[j]] / total) : 0;
  return { total: total, counts: counts, shares: shares };
}

module.exports = { ensureStabilityState: ensureStabilityState, pruneSpawnHistory: pruneSpawnHistory, pushSpawnHistory: pushSpawnHistory, computeBandUsage: computeBandUsage };
