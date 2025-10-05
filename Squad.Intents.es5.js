'use strict';

/**
 * Flag intent table shared by squad controller + toolbox decoder.
 * Primary/secondary color pairs map to semantic intents so role logic
 * can react consistently without hardcoding flag names.
 */

var lookup = {};
var byIntent = {};

function _bind(intent, primary, secondary) {
  var key = primary + ':' + secondary;
  lookup[key] = intent;
  byIntent[intent] = { primary: primary, secondary: secondary };
}

// Intent palette
_bind('RALLY', COLOR_WHITE, COLOR_BLUE);
_bind('ASSAULT', COLOR_RED, COLOR_RED);
_bind('BREACH', COLOR_RED, COLOR_YELLOW);
_bind('KITE', COLOR_BLUE, COLOR_RED);
_bind('RETREAT', COLOR_GREY, COLOR_RED);

module.exports = {
  lookup: lookup,
  byIntent: byIntent,
  bind: _bind,
  getIntentForFlag: function (flag) {
    if (!flag) return null;
    return lookup[flag.color + ':' + flag.secondaryColor] || null;
  },
  getColorsForIntent: function (intent) {
    return byIntent[intent] || null;
  }
};
