
var CoreConfig = require('core.config');
var LOG_LEVEL = CoreConfig.LOG_LEVEL;

// Persisted in the global scope to survive across ticks without touching Memory.
if (!global.__beeLoggerLevel) {
  global.__beeLoggerLevel = CoreConfig.settings.logging.defaultLevel;
}

function sanitizeLevel(level) {
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
  console.log(message);
}

function formatNamespace(ns) {
  return ns ? '[' + ns + '] ' : '';
}

function createLogger(namespace, defaultLevel) {
  var nsPrefix = formatNamespace(namespace);
  var minLevel = sanitizeLevel(defaultLevel == null ? LOG_LEVEL.BASIC : defaultLevel);

  function emit(level, args) {
    if (!shouldLog(level) || level < minLevel) return;
    var text = Array.prototype.join.call(args, ' ');
    console.log(nsPrefix + text);
  }

  return {
    debug: function () { emit(LOG_LEVEL.DEBUG, arguments); },
    info: function () { emit(LOG_LEVEL.BASIC, arguments); },
    warn: function () { emit(LOG_LEVEL.BASIC, arguments); },
    error: function () { emit(LOG_LEVEL.BASIC, arguments); },
    log: function (level) {
      var args = Array.prototype.slice.call(arguments, 1);
      emit(level, args);
    },
  };
}

module.exports = {
  LOG_LEVEL: LOG_LEVEL,
  setLogLevel: setLogLevel,
  getLogLevel: getLogLevel,
  shouldLog: shouldLog,
  log: log,
  createLogger: createLogger,
};
