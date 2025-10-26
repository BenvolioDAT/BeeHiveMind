'use strict';

// -----------------------------------------------------------------------------
// AllianceManager.js
// Maintains a simple static list of friendly Screeps usernames and exposes
// helpers that keep combat logic from targeting allies.
// -----------------------------------------------------------------------------

var FRIENDLY_USERNAMES = [
  'haha233jpg',
  'Court_of_Silver',
  'xianda1314',
  'Lumen',
  'ControlNet',
  'xel',
  'bg8kiw',
  'Kazkel',
];

// Cache for per-tick alliance log spam suppression.
var allianceLogCache = global.__allianceLogCache || {
  tick: -1,
  entries: Object.create(null)
};
if (global.__allianceLogCache !== allianceLogCache) {
  global.__allianceLogCache = allianceLogCache;
}

function normalizeUsername(username) {
  if (username === null || username === undefined) return '';
  return String(username).trim();
}

function sameUser(a, b) {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

function logAllianceMessage(message) {
  console.log('[ALLIANCE] ' + message);
}

function shouldLogOncePerTick(key) {
  var tick = Game.time | 0;
  if (allianceLogCache.tick !== tick) {
    allianceLogCache.tick = tick;
    allianceLogCache.entries = Object.create(null);
  }
  if (allianceLogCache.entries[key]) return false;
  allianceLogCache.entries[key] = true;
  return true;
}

var AllianceManager = {
  friendlyUsernames: FRIENDLY_USERNAMES,

  isAlly: function (username) {
    var name = normalizeUsername(username);
    if (!name) return false;
    for (var i = 0; i < FRIENDLY_USERNAMES.length; i++) {
      if (sameUser(FRIENDLY_USERNAMES[i], name)) {
        return true;
      }
    }
    return false;
  },

  noteFriendlyFireAvoid: function (creepName, username, context) {
    var user = normalizeUsername(username);
    if (!user) return;
    var key = user + '|' + (context || '');
    if (!shouldLogOncePerTick(key)) return;
    var msg = 'Prevented attack on ally ' + user;
    if (creepName) msg += ' by ' + creepName;
    if (context) msg += ' (' + context + ')';
    logAllianceMessage(msg);
  },

  log: function (message) {
    if (!message) return;
    logAllianceMessage(message);
  }
};

module.exports = AllianceManager;
