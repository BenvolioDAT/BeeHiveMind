'use strict';

var CoreConfig = require('core.config');

function getConfig() {
  var settings = CoreConfig && CoreConfig.settings;
  return settings && settings.cpuBudget ? settings.cpuBudget : {};
}

function enabled() {
  return getConfig().enabled !== false;
}

function getBucket() {
  try {
    return (Game && Game.cpu && typeof Game.cpu.bucket === 'number') ? Game.cpu.bucket : null;
  } catch (err) {
    return null;
  }
}

function getUsed() {
  try {
    return (Game && Game.cpu && typeof Game.cpu.getUsed === 'function') ? Game.cpu.getUsed() : 0;
  } catch (err) {
    return 0;
  }
}

function getCpuLimit() {
  try {
    var cpu = Game && Game.cpu;
    if (!cpu) return 0;
    var limit = Number(cpu.limit || 0);
    if (limit > 0) return limit;
    return Number(cpu.tickLimit || 0);
  } catch (err) {
    return 0;
  }
}

function getTickLimit() {
  try {
    return Number(Game && Game.cpu && (Game.cpu.tickLimit || Game.cpu.limit || 0)) || 0;
  } catch (err) {
    return 0;
  }
}

function belowLowBucket() {
  var bucket = getBucket();
  var cfg = getConfig();
  var threshold = Number(cfg.lowBucketThreshold || 0);
  return bucket !== null && threshold > 0 && bucket < threshold;
}

function belowCriticalBucket() {
  var bucket = getBucket();
  var cfg = getConfig();
  var threshold = Number(cfg.criticalBucketThreshold || 0);
  return bucket !== null && threshold > 0 && bucket < threshold;
}

function hasBucket(minBucket) {
  if (!enabled()) return true;
  var min = Number(minBucket || 0);
  if (min <= 0) return true;
  var bucket = getBucket();
  if (bucket === null) return true;
  return bucket >= min;
}

function hasCpuHeadroom(maxCpuUsed, reserveCpu) {
  if (!enabled()) return true;
  var used = getUsed();
  var maxUsed = Number(maxCpuUsed || 0);
  if (maxUsed > 0 && used >= maxUsed) return false;
  var tickLimit = getTickLimit();
  var reserve = Number(reserveCpu != null ? reserveCpu : getConfig().tickLimitReserve);
  if (tickLimit > 0 && reserve > 0 && used >= Math.max(0, tickLimit - reserve)) return false;
  return true;
}

function canSpend(opts) {
  opts = opts || {};
  if (!enabled()) return true;
  if (!hasBucket(opts.minBucket)) return false;
  return hasCpuHeadroom(opts.maxCpuUsed, opts.reserveCpu);
}

function stableOffset(key, modulo) {
  var mod = Math.max(1, Number(modulo) || 1);
  if (mod <= 1) return 0;
  var str = String(key || '');
  var hash = 0;
  for (var i = 0; i < str.length; i++) hash = (hash + str.charCodeAt(i)) % mod;
  return hash;
}

function isTickForKey(key, interval) {
  var every = Math.max(1, Number(interval) || 1);
  if (every <= 1) return true;
  return ((Game.time + stableOffset(key, every)) % every) === 0;
}

function intervalByBucket(baseInterval, lowBucketInterval, lowBucketMin) {
  var base = Math.max(1, Number(baseInterval) || 1);
  var low = Math.max(base, Number(lowBucketInterval) || base);
  var min = Number(lowBucketMin || getConfig().lowBucketThreshold || 0);
  var bucket = getBucket();
  if (bucket !== null && min > 0 && bucket < min) return low;
  return base;
}

module.exports = {
  getBucket: getBucket,
  getUsed: getUsed,
  getCpuLimit: getCpuLimit,
  getTickLimit: getTickLimit,
  belowLowBucket: belowLowBucket,
  belowCriticalBucket: belowCriticalBucket,
  hasBucket: hasBucket,
  hasCpuHeadroom: hasCpuHeadroom,
  canSpend: canSpend,
  stableOffset: stableOffset,
  isTickForKey: isTickForKey,
  intervalByBucket: intervalByBucket
};
