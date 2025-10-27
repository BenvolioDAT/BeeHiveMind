// Trade.Energy.v2.1.js
// Purpose: Sell excess ENERGY via the Market from a room's Terminal.
// Tone: novice-friendly (verbose comments, clear steps).

var CoreConfig = require('core.config');

var tradeSettings = (CoreConfig && CoreConfig.settings && CoreConfig.settings.Trade && CoreConfig.settings.Trade.energy) || {};

var CFG = {
  KEEP_ENERGY_STORAGE: (typeof tradeSettings.keepStorage === 'number') ? tradeSettings.keepStorage : 600000,
  KEEP_ENERGY_TERMINAL: (typeof tradeSettings.keepTerminal === 'number') ? tradeSettings.keepTerminal : 50000,
  MIN_PRICE: (typeof tradeSettings.minPrice === 'number') ? tradeSettings.minPrice : 0.15,
  MIN_EFFECTIVE_CPE: (typeof tradeSettings.minEffectiveCpe === 'number') ? tradeSettings.minEffectiveCpe : 0.0,
  MAX_PER_DEAL: (typeof tradeSettings.maxPerDeal === 'number') ? tradeSettings.maxPerDeal : 20000,
  COOLDOWN_TICKS: (typeof tradeSettings.cooldownTicks === 'number') ? tradeSettings.cooldownTicks : 25,
  MIN_ORDER_AMOUNT: (typeof tradeSettings.minOrderAmount === 'number') ? tradeSettings.minOrderAmount : 2000,
  SCAN_TOP_N: (typeof tradeSettings.scanTopN === 'number') ? tradeSettings.scanTopN : 20,
  MAX_DISTANCE: (typeof tradeSettings.maxDistance === 'number') ? tradeSettings.maxDistance : Infinity,
  HISTORY_REFRESH: (typeof tradeSettings.historyRefresh === 'number') ? tradeSettings.historyRefresh : 5000
};

function isValidRoomName(name) {
  if (typeof name !== 'string') return false;
  return /^[WE]\d+[NS]\d+$/.test(name);
}

function safeLinearDistance(a, b, allowInexact) {
  if (!isValidRoomName(a) || !isValidRoomName(b)) {
    return 9999;
  }
  if (!Game || !Game.map || typeof Game.map.getRoomLinearDistance !== 'function') {
    return 9999;
  }
  return Game.map.getRoomLinearDistance(a, b, allowInexact);
}

// ---------- tiny globals (safe, reset each tick) ----------
var TradeState = {
  tickSeen: -1,
  buyOrders: [],
  dealsThisTick: 0,    // API hard-caps at 10 deals/tick
  history: { tick: -Infinity, byRes: {} }
};

// ---------- helpers ----------
function refreshTickGlobals() {
  if (TradeState.tickSeen !== Game.time) {
    TradeState.tickSeen = Game.time;
    TradeState.buyOrders = [];
    TradeState.dealsThisTick = 0;
  }
}

// server-side filter is cheaper than client-side mass filtering
function fetchEnergyBuyOrders() {
  refreshTickGlobals();
  if (TradeState.buyOrders.length) return TradeState.buyOrders;

  var orders = Game.market.getAllOrders(function (o) {
    return (
      o.type === ORDER_BUY &&
      o.resourceType === RESOURCE_ENERGY &&
      o.price >= CFG.MIN_PRICE &&
      o.amount >= CFG.MIN_ORDER_AMOUNT
    );
  });

  // Consider top N by raw price (fast screen), refine by effective later
  orders.sort(function (a, b) {
    return b.price - a.price;
  });
  if (CFG.SCAN_TOP_N > 0 && orders.length > CFG.SCAN_TOP_N) {
    orders = orders.slice(0, CFG.SCAN_TOP_N);
  }
  TradeState.buyOrders = orders;
  return orders;
}

// credits per *net* energy (amount sent + energy fee)
function effectiveCreditsPerEnergy(order, fromRoom, amount) {
  var fee = Game.market.calcTransactionCost(amount, fromRoom, order.roomName);
  var net = amount + fee;
  return net > 0 ? (order.price * amount) / net : 0;
}

// shrink amount so terminal has enough to cover shipment + fee while keeping reserve
function fitAmountToTerminal(room, order, desired) {
  var term = room.terminal;
  if (!term) return 0;
  if (term.cooldown > 0) return; // nothing to do this tick

  var reserve = CFG.KEEP_ENERGY_TERMINAL;
  var spendable = (term.store[RESOURCE_ENERGY] || 0) - reserve;
  if (spendable <= 0) return 0;

  var amt = Math.max(0, Math.min(desired, spendable));
  if (amt === 0) return 0;

  // Nudge down in small chunks until amt + fee fits spendable
  var STEP = 500;
  for (var guard = 0; guard < 50 && amt > 0; guard++) {
    var fee = Game.market.calcTransactionCost(amt, room.name, order.roomName);
    if (amt + fee <= spendable) break;
    amt = Math.max(0, amt - STEP);
  }
  return amt;
}

// per-room cooldown memory
function _roomThrottle(room) {
  if (!Memory.trade) Memory.trade = {};
  if (!Memory.trade.rooms) Memory.trade.rooms = {};
  if (!Memory.trade.rooms[room.name]) Memory.trade.rooms[room.name] = { last: 0 };
  return Memory.trade.rooms[room.name];
}
function canTradeThisTick(room) {
  var rec = _roomThrottle(room);
  if (room.terminal && room.terminal.cooldown > 0) return false;
  return (Game.time - rec.last) >= CFG.COOLDOWN_TICKS;

}
function markTraded(room) {
  var rec = _roomThrottle(room);
  rec.last = Game.time;
  TradeState.dealsThisTick++;
}

// Optional: lazy history to sanity-check price floors (14 days)
function getEnergyHistory() {
  if ((Game.time - TradeState.history.tick) < CFG.HISTORY_REFRESH) {
    return TradeState.history.byRes[RESOURCE_ENERGY];
  }
  var hist = Game.market.getHistory(RESOURCE_ENERGY) || [];
  TradeState.history.tick = Game.time;
  TradeState.history.byRes[RESOURCE_ENERGY] = hist;
  return hist;
}

// ---------- core ----------
var TradeEnergy = {
  run: function (room) {
    refreshTickGlobals();
    if (!room || !room.controller || !room.controller.my) return;
    if (!room.terminal || !room.storage) return;

    // global hard-cap: API allows only 10 deals/player/tick
    if (TradeState.dealsThisTick >= 10) return;

    // skip if terminal is cooling down (deals also apply cooldown)
    if (room.terminal.cooldown && room.terminal.cooldown > 0) return;

    if (!canTradeThisTick(room)) return;

    var store = room.storage.store[RESOURCE_ENERGY] || 0;
    var termE = room.terminal.store[RESOURCE_ENERGY] || 0;
    if (store < CFG.KEEP_ENERGY_STORAGE) return; // no true surplus

    var candidates = fetchEnergyBuyOrders();
    if (!candidates.length) return;

    // pick best by *effective* credits/energy using a small test amount
    var ranked = [];
    for (var idx = 0; idx < candidates.length; idx++) {
      var o = candidates[idx];
      if (!o.roomName) continue;

      if (isFinite(CFG.MAX_DISTANCE)) {
        var d = safeLinearDistance(room.name, o.roomName, true);
        if (d > CFG.MAX_DISTANCE) continue;
      }

      var cap = Math.min(o.amount, CFG.MAX_PER_DEAL);
      var test = Math.max(1000, Math.min(cap, 10000));
      var eff = effectiveCreditsPerEnergy(o, room.name, test);
      ranked.push([o, eff]);
    }
    if (!ranked.length) return;

    ranked.sort(function (A, B) {
      return B[1] - A[1];
    });
    var best = ranked[0][0];
    var bestEff = ranked[0][1];

    if (bestEff < CFG.MIN_EFFECTIVE_CPE) return;

    var want = Math.min(best.amount, CFG.MAX_PER_DEAL);
    var amount = fitAmountToTerminal(room, best, want);
    if (amount <= 0) return;

    var res = Game.market.deal(best.id, amount, room.name);
    if (res === OK) {
      markTraded(room);
      var fee = Game.market.calcTransactionCost(amount, room.name, best.roomName);
      console.log(
        '[TradeEnergy] ' + room.name + ': Sold ' + amount + ' energy @ ' + best.price.toFixed(3) + ' to ' + best.roomName +
        ' (fee ' + fee + ', eff ' + effectiveCreditsPerEnergy(best, room.name, amount).toFixed(3) + ' cr/energy)'
      );
    } else {
      console.log(
        '[TradeEnergy] ' + room.name + ': deal failed (' + res + '). tCooldown=' + room.terminal.cooldown + ' termE=' + termE +
        ' orderAmt=' + best.amount + ' price=' + best.price
      );
    }
  },

  runAll: function () {
    refreshTickGlobals();
    // var hist = getEnergyHistory(); // optional future logic

    for (var name in Game.rooms) {
      if (!Game.rooms.hasOwnProperty(name)) continue;
      var room = Game.rooms[name];
      if (room && room.controller && room.controller.my && room.terminal) {
        this.run(room);
        if (TradeState.dealsThisTick >= 10) break;
      }
    }
  }
};

module.exports = TradeEnergy;
