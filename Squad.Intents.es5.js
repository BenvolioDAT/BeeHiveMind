'use strict';

/**
 * Squad.Intents.es5.js
 * --------------------------------------------------
 * Translates flag colors/names into squad intents.
 * Intents drive squad-wide behavior without complex
 * cascades of if/else. This module is ES5-safe.
 */

var FLAG_RULES = [
  // Fortress breach (red / white)
  {
    intent: 'BREACH',
    color: COLOR_RED,
    secondaryColor: COLOR_WHITE,
    namePrefix: 'Breach',
    description: 'Assault ramparts/walls and dismantle entry window.'
  },
  {
    intent: 'ASSAULT',
    color: COLOR_RED,
    secondaryColor: COLOR_RED,
    namePrefix: 'Assault',
    description: 'Direct attack on hostile creeps and high-value structures.'
  },
  {
    intent: 'RALLY',
    color: COLOR_WHITE,
    secondaryColor: COLOR_BLUE,
    namePrefix: 'Rally',
    description: 'Gather squad and hold position until reinforced.'
  },
  {
    intent: 'RETREAT',
    color: COLOR_BLUE,
    secondaryColor: COLOR_RED,
    namePrefix: 'Retreat',
    description: 'Fall back to safe room; do not engage.'
  },
  {
    intent: 'KITE',
    color: COLOR_GREEN,
    secondaryColor: COLOR_GREEN,
    namePrefix: 'Kite',
    description: 'Maintain ranged spacing while applying pressure.'
  },
  {
    intent: 'HOLD',
    color: COLOR_WHITE,
    secondaryColor: COLOR_WHITE,
    namePrefix: 'Hold',
    description: 'Anchor and defend without overextending.'
  }
];

var DEFAULT_INTENT = 'RALLY';

function _matchByColor(flag) {
  if (!flag) return null;
  for (var i = 0; i < FLAG_RULES.length; i++) {
    var rule = FLAG_RULES[i];
    if (flag.color === rule.color && flag.secondaryColor === rule.secondaryColor) {
      return rule;
    }
  }
  return null;
}

function _matchByName(flag) {
  if (!flag || !flag.name) return null;
  var name = flag.name;
  for (var i = 0; i < FLAG_RULES.length; i++) {
    var rule = FLAG_RULES[i];
    if (rule.namePrefix && name.indexOf(rule.namePrefix) === 0) {
      return rule;
    }
  }
  return null;
}

function resolve(flag) {
  var rule = _matchByColor(flag) || _matchByName(flag);
  if (!rule) {
    return { intent: DEFAULT_INTENT, rule: null };
  }
  return { intent: rule.intent, rule: rule };
}

function describeIntent(intent) {
  var i;
  for (i = 0; i < FLAG_RULES.length; i++) {
    if (FLAG_RULES[i].intent === intent) return FLAG_RULES[i].description;
  }
  return '';
}

module.exports = {
  DEFAULT_INTENT: DEFAULT_INTENT,
  FLAG_RULES: FLAG_RULES,
  resolve: resolve,
  describeIntent: describeIntent,
};
