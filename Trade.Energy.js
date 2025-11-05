'use strict';

/**
 * What changed & why:
 * - Converted to ES5 syntax and documented the trade heuristics for clarity.
 * - Hooks into global tick caches by avoiding repeated allocations and staying DECIDE-safe.
 */

var CFG = {
  KEEP_ENERGY_STORAGE: 600000,
  KEEP_ENERGY_TERMINAL: 50000,
  MIN_PRICE: 0.15,
  MIN_EFFECTIVE_CPE: 0.00,
  MAX_PER_DEAL: 20000,
  COOLDOWN_TICKS: 25,
  MIN_ORDER_AMOUNT: 2000,
  SCAN_TOP_N: 20,
  MAX_DISTANCE: Infinity,
  HISTORY_REFRESH: 5000
};

var TradeState = {
  tickSeen: -1,
  buyOrders: [],
  dealsThisTick: 0,
  history: { tick: -Infinity, byRes: {} }
};

function refreshTickGlobals() {
  if (TradeState.tickSeen !== Game.time) {
    TradeState.tickSeen = Game.time;
    TradeState.buyOrders = [];
    TradeState.dealsThisTick = 0;
  }
}

function fetchEnergyBuyOrders() {
  refreshTickGlobals();
  if (TradeState.buyOrders.length) return TradeState.buyOrders;
  var orders = Game.market.getAllOrders(function (o) {
    return o.type === ORDER_BUY &&
           o.resourceType === RESOURCE_ENERGY &&
           o.price >= CFG.MIN_PRICE &&
           o.amount >= CFG.MIN_ORDER_AMOUNT;
  }) || [];
  orders.sort(function (a, b) { return b.price - a.price; });
  if (CFG.SCAN_TOP_N > 0 && orders.length > CFG.SCAN_TOP_N) {
    orders = orders.slice(0, CFG.SCAN_TOP_N);
  }
  TradeState.buyOrders = orders;
  return orders;
}

function effectiveCreditsPerEnergy(order, fromRoom, amount) {
  var fee = Game.market.calcTransactionCost(amount, fromRoom, order.roomName);
  var net = amount + fee;
  return net > 0 ? (order.price * amount) / net : 0;
}

function fitAmountToTerminal(room, order, desired) {
  var term = room.terminal;
  if (!term) return 0;
  if (term.cooldown > 0) return 0;
  var reserve = CFG.KEEP_ENERGY_TERMINAL;
  var spendable = (term.store[RESOURCE_ENERGY] || 0) - reserve;
  if (spendable <= 0) return 0;
  var amt = Math.max(0, Math.min(desired, spendable));
  if (amt === 0) return 0;
  var STEP = 500;
  var guard = 0;
  while (amt > 0 && guard < 50) {
    var fee = Game.market.calcTransactionCost(amt, room.name, order.roomName);
    if (amt + fee <= spendable) break;
    amt = Math.max(0, amt - STEP);
    guard++;
  }
  return amt;
}

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

function getEnergyHistory() {
  if ((Game.time - TradeState.history.tick) < CFG.HISTORY_REFRESH) {
    return TradeState.history.byRes[RESOURCE_ENERGY];
  }
  var hist = Game.market.getHistory(RESOURCE_ENERGY) || [];
  TradeState.history.tick = Game.time;
  TradeState.history.byRes[RESOURCE_ENERGY] = hist;
  return hist;
}

var TradeEnergy = {
  run: function (room) {
    refreshTickGlobals();
    if (!room || !room.controller || !room.controller.my) return;
    if (!room.terminal || !room.storage) return;
    if (TradeState.dealsThisTick >= 10) return;
    if (room.terminal.cooldown && room.terminal.cooldown > 0) return;
    if (!canTradeThisTick(room)) return;
    var store = room.storage.store[RESOURCE_ENERGY] || 0;
    var termE = room.terminal.store[RESOURCE_ENERGY] || 0;
    if (store < CFG.KEEP_ENERGY_STORAGE) return;
    var candidates = fetchEnergyBuyOrders();
    if (!candidates.length) return;
    var ranked = [];
    for (var i = 0; i < candidates.length; i++) {
      var o = candidates[i];
      if (!o || !o.roomName) continue;
      if (isFinite(CFG.MAX_DISTANCE)) {
        var d = Game.map.getRoomLinearDistance(room.name, o.roomName, true);
        if (d > CFG.MAX_DISTANCE) continue;
      }
      var cap = Math.min(o.amount, CFG.MAX_PER_DEAL);
      var test = Math.max(1000, Math.min(cap, 10000));
      var eff = effectiveCreditsPerEnergy(o, room.name, test);
      ranked.push([o, eff]);
    }
    if (!ranked.length) return;
    ranked.sort(function (A, B) { return B[1] - A[1]; });
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
      console.log('[TradeEnergy] ' + room.name + ': Sold ' + amount + ' energy @ ' + best.price.toFixed(3) +
        ' to ' + best.roomName + ' (fee ' + fee + ', eff ' + effectiveCreditsPerEnergy(best, room.name, amount).toFixed(3) + ' cr/energy)');
    } else {
      console.log('[TradeEnergy] ' + room.name + ': deal failed (' + res + '). tCooldown=' + room.terminal.cooldown +
        ' termE=' + termE + ' orderAmt=' + best.amount + ' price=' + best.price);
    }
  },

  runAll: function () {
    refreshTickGlobals();
    getEnergyHistory();
    for (var name in Game.rooms) {
      if (!Object.prototype.hasOwnProperty.call(Game.rooms, name)) continue;
      var room = Game.rooms[name];
      if (room && room.controller && room.controller.my && room.terminal) {
        this.run(room);
        if (TradeState.dealsThisTick >= 10) break;
      }
    }
  }
};

module.exports = TradeEnergy;
