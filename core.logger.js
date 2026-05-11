
const CoreConfig = require('core.config');
const LOG_LEVEL = CoreConfig.LOG_LEVEL;

// Persisted in the global scope to survive across ticks without touching Memory.
if (!global.__beeLoggerLevel) {
  global.__beeLoggerLevel = CoreConfig.settings.logging.defaultLevel;
}

function sanitizeLevel(level) {
  // Clamp any provided value into the known range so callers cannot set junk levels.
  if (typeof level !== 'number') return LOG_LEVEL.NONE;
  if (level < LOG_LEVEL.NONE) return LOG_LEVEL.NONE;
  if (level > LOG_LEVEL.DEBUG) return LOG_LEVEL.DEBUG;
  return level;
}

function setLogLevel(level) {
  global.__beeLoggerLevel = sanitizeLevel(level);
}

function getLogLevel() {
  return sanitizeLevel(global.__beeLoggerLevel);
}

function shouldLog(level) {
  return getLogLevel() >= sanitizeLevel(level);
}

function log(level, message) {
  if (!shouldLog(level)) return;
  try {
    console.log(message);
  } catch (e) {
    // never let logging failures break game logic
  }
}

function formatNamespace(ns) {
  return ns ? '[' + ns + '] ' : '';
}

function createLogger(namespace, defaultLevel) {
  const nsPrefix = formatNamespace(namespace);
  const minLevel = sanitizeLevel(defaultLevel == null ? LOG_LEVEL.BASIC : defaultLevel);
  // Every emitted message must clear both the global and per-logger thresholds.

  function emit(level, args) {
    if (!shouldLog(level) || level < minLevel) return;
    const text = Array.prototype.join.call(args, ' ');
    try {
      console.log(nsPrefix + text);
    } catch (e) {
      // never let logging failures break game logic
    }
  }

  function scopedKey(key) {
    return (namespace || 'global') + ':' + String(key || 'unknown');
  }

  return {
    debug: function () { emit(LOG_LEVEL.DEBUG, arguments); },
    info: function () { emit(LOG_LEVEL.BASIC, arguments); },
    warn: function () { emit(LOG_LEVEL.BASIC, arguments); },
    error: function () { emit(LOG_LEVEL.BASIC, arguments); },
    /**
     * Future catch-block helper:
     * logger.warnEvery('someKey', 50, 'message', err)
     * Emits at most once per interval ticks for a stable key.
     */
    warnEvery: function (key, interval) {
      const args = Array.prototype.slice.call(arguments, 2);
      throttled(LOG_LEVEL.BASIC, scopedKey(key), interval, args);
    },
    errorEvery: function (key, interval) {
      const args = Array.prototype.slice.call(arguments, 2);
      throttled(LOG_LEVEL.BASIC, scopedKey(key), interval, args);
    },
    throttled: function (level, key, interval) {
      const args = Array.prototype.slice.call(arguments, 3);
      throttled(level, scopedKey(key), interval, args);
    },
    log: function (level) {
      var args = Array.prototype.slice.call(arguments, 1);
      emit(level, args);
    },
  };
}

function ensureThrottleStore() {
  if (!global.__beeLoggerThrottle || typeof global.__beeLoggerThrottle !== 'object') {
    global.__beeLoggerThrottle = { map: Object.create(null), n: 0 };
  } else if (!global.__beeLoggerThrottle.map || typeof global.__beeLoggerThrottle.map !== 'object') {
    global.__beeLoggerThrottle.map = Object.create(null);
    global.__beeLoggerThrottle.n = 0;
  }
  return global.__beeLoggerThrottle;
}

function pruneThrottleStore(store, maxKeys) {
  if (!store || !store.map) return;
  if (store.n <= maxKeys) return;
  // Cheap O(n) prune: drop ~half oldest keys by last tick.
  const entries = [];
  for (const k in store.map) {
    entries.push({ key: k, t: store.map[k] || 0 });
  }
  entries.sort(function (a, b) { return a.t - b.t; });
  const removeCount = Math.ceil(entries.length / 2);
  for (let i = 0; i < removeCount; i++) {
    const key = entries[i].key;
    if (Object.prototype.hasOwnProperty.call(store.map, key)) {
      delete store.map[key];
      store.n--;
    }
  }
}

function throttled(level, key, interval, args) {
  const safeLevel = sanitizeLevel(level);
  if (!shouldLog(safeLevel)) return false;
  const cfg = (CoreConfig && CoreConfig.settings && CoreConfig.settings.logging) || {};
  const defaultInterval = (typeof cfg.throttleInterval === 'number' && cfg.throttleInterval > 0) ? cfg.throttleInterval : 25;
  const step = (typeof interval === 'number' && interval > 0) ? interval : defaultInterval;
  const safeKey = String(key || 'global');
  const tick = (typeof Game === 'object' && Game && typeof Game.time === 'number') ? Game.time : 0;

  const store = ensureThrottleStore();
  const prev = store.map[safeKey];
  if (typeof prev === 'number' && (tick - prev) < step) return false;

  if (!Object.prototype.hasOwnProperty.call(store.map, safeKey)) {
    store.n++;
  }
  store.map[safeKey] = tick;

  const maxKeys = (typeof cfg.throttleMaxKeys === 'number' && cfg.throttleMaxKeys > 0) ? cfg.throttleMaxKeys : 200;
  pruneThrottleStore(store, maxKeys);

  try {
    console.log(Array.prototype.join.call(args || [], ' '));
  } catch (e) {
    // never let logging failures break game logic
  }
  return true;
}

module.exports = {
  LOG_LEVEL: LOG_LEVEL,
  setLogLevel: setLogLevel,
  getLogLevel: getLogLevel,
  shouldLog: shouldLog,
  log: log,
  throttled: throttled,
  warnEvery: function (key, interval) {
    const args = Array.prototype.slice.call(arguments, 2);
    return throttled(LOG_LEVEL.BASIC, key, interval, args);
  },
  errorEvery: function (key, interval) {
    const args = Array.prototype.slice.call(arguments, 2);
    return throttled(LOG_LEVEL.BASIC, key, interval, args);
  },
  createLogger: createLogger,
};
