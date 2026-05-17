'use strict';

var CoreConfig = require('core.config');
var Logger = require('core.logger');

var LOG_LEVEL = CoreConfig.LOG_LEVEL;
var profilerLog = Logger.createLogger('CpuProfiler', LOG_LEVEL.BASIC);

function getConfig() {
  var settings = CoreConfig && CoreConfig.settings;
  var cfg = settings && settings.cpuProfiler;
  return cfg || { enabled: false, reportEvery: 100, minSectionCpuToReport: 0.05 };
}

function ensureStore() {
  if (!global.__CPU_PROFILER__) {
    global.__CPU_PROFILER__ = {
      sections: Object.create(null),
      starts: Object.create(null),
      lastReportTick: 0,
      initializedAt: Game && Game.time
    };
  }
  return global.__CPU_PROFILER__;
}

function isEnabled() {
  return !!(getConfig().enabled);
}

function readCpu() {
  try {
    if (!Game || !Game.cpu || typeof Game.cpu.getUsed !== 'function') return 0;
    return Game.cpu.getUsed();
  } catch (err) {
    return 0;
  }
}

function ensureSection(store, sectionName) {
  var name = String(sectionName || 'unknown');
  var section = store.sections[name];
  if (!section) {
    section = {
      count: 0,
      total: 0,
      average: 0,
      max: 0,
      last: 0
    };
    store.sections[name] = section;
  }
  return section;
}

function record(sectionName, usedCpu) {
  if (!isEnabled()) return;
  if (!(usedCpu >= 0)) return;

  try {
    var store = ensureStore();
    var section = ensureSection(store, sectionName);
    section.count += 1;
    section.total += usedCpu;
    section.last = usedCpu;
    if (usedCpu > section.max) section.max = usedCpu;
    section.average = section.total / section.count;
  } catch (err) {
    // Never throw from profiler-only code.
  }
}

function start(sectionName) {
  if (!isEnabled()) return;
  try {
    var store = ensureStore();
    store.starts[String(sectionName || 'unknown')] = readCpu();
  } catch (err) {
    // Never throw.
  }
}

function end(sectionName) {
  if (!isEnabled()) return 0;
  try {
    var store = ensureStore();
    var name = String(sectionName || 'unknown');
    var startCpu = store.starts[name];
    if (!(startCpu >= 0)) return 0;

    var used = readCpu() - startCpu;
    if (!(used >= 0)) used = 0;
    delete store.starts[name];
    record(name, used);
    return used;
  } catch (err) {
    return 0;
  }
}

function measure(sectionName, fn) {
  if (typeof fn !== 'function') return;
  if (!isEnabled()) {
    return fn();
  }

  start(sectionName);
  try {
    return fn();
  } finally {
    end(sectionName);
  }
}

function reportMaybe() {
  if (!isEnabled()) return;

  try {
    var cfg = getConfig();
    var every = Math.max(1, Number(cfg.reportEvery) || 100);
    if (!Game || typeof Game.time !== 'number') return;
    if (Game.time % every !== 0) return;

    var store = ensureStore();
    if (store.lastReportTick === Game.time) return;
    store.lastReportTick = Game.time;

    var minCpu = Math.max(0, Number(cfg.minSectionCpuToReport) || 0);
    var names = Object.keys(store.sections);
    var lines = [];

    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var section = store.sections[name];
      if (!section || section.count <= 0) continue;
      if (section.average < minCpu) continue;
      lines.push(
        name +
        ':avg=' + section.average.toFixed(3) +
        ',max=' + section.max.toFixed(3) +
        ',last=' + section.last.toFixed(3) +
        ',count=' + section.count
      );
    }

    if (lines.length === 0) return;
    lines.sort();
    profilerLog.info('[CPU] t=' + Game.time + ' ' + lines.join(' | '));
  } catch (err) {
    // Never throw.
  }
}

module.exports = {
  start: start,
  end: end,
  measure: measure,
  reportMaybe: reportMaybe,
  record: record,
  isEnabled: isEnabled
};
