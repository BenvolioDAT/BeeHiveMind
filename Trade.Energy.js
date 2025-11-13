
const CFG = {
  KEEP_ENERGY_STORAGE: 600000,   // don't touch storage below this
  KEEP_ENERGY_TERMINAL: 50000,   // keep this buffer in the terminal
  MIN_PRICE: 0.15,               // nominal price floor (credits per unit)
  MIN_EFFECTIVE_CPE: 0.00,       // optional floor on *effective* credits/energy after fees
  MAX_PER_DEAL: 20000,           // don't over-swing any single order
  COOLDOWN_TICKS: 25,            // per-room spacing so we don't spam
  MIN_ORDER_AMOUNT: 2000,        // ignore crumbs
  SCAN_TOP_N: 20,                // examine top N by price
  MAX_DISTANCE: Infinity,        // optional hard cap (e.g. 18). Infinity = off.
  HISTORY_REFRESH: 5000          // how often to refresh 14d history (ticks)
};

// ---------- tiny globals (safe, reset each tick) ----------
const TradeState = {
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

  let orders = Game.market.getAllOrders(o =>
    o.type === ORDER_BUY &&
    o.resourceType === RESOURCE_ENERGY &&
    o.price >= CFG.MIN_PRICE &&
    o.amount >= CFG.MIN_ORDER_AMOUNT
  );

  // Consider top N by raw price (fast screen), refine by effective later
  orders.sort((a, b) => b.price - a.price);
  if (CFG.SCAN_TOP_N > 0 && orders.length > CFG.SCAN_TOP_N) {
    orders = orders.slice(0, CFG.SCAN_TOP_N);
  }
  TradeState.buyOrders = orders;
  return orders;
}

// credits per *net* energy (amount sent + energy fee)
function effectiveCreditsPerEnergy(order, fromRoom, amount) {
  const fee = Game.market.calcTransactionCost(amount, fromRoom, order.roomName);
  const net = amount + fee;
  return net > 0 ? (order.price * amount) / net : 0;
}

// shrink amount so terminal has enough to cover shipment + fee while keeping reserve
function fitAmountToTerminal(room, order, desired) {
  const term = room.terminal;
  if (!term) return 0;
  if (term.cooldown > 0) return; // nothing to do this tick

  const reserve = CFG.KEEP_ENERGY_TERMINAL;
  let spendable = (term.store[RESOURCE_ENERGY] || 0) - reserve;
  if (spendable <= 0) return 0;

  let amt = Math.max(0, Math.min(desired, spendable));
  if (amt === 0) return 0;

  // Nudge down in small chunks until amt + fee fits spendable
  const STEP = 500;
  for (let guard = 0; guard < 50 && amt > 0; guard++) {
    const fee = Game.market.calcTransactionCost(amt, room.name, order.roomName);
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
  const rec = _roomThrottle(room);
  if (room.terminal && room.terminal.cooldown > 0) return false;
  return (Game.time - rec.last) >= CFG.COOLDOWN_TICKS;
  
}
function markTraded(room) {
  const rec = _roomThrottle(room);
  rec.last = Game.time;
  TradeState.dealsThisTick++;
}

// Optional: lazy history to sanity-check price floors (14 days)
function getEnergyHistory() {
  if ((Game.time - TradeState.history.tick) < CFG.HISTORY_REFRESH) {
    return TradeState.history.byRes[RESOURCE_ENERGY];
  }
  const hist = Game.market.getHistory(RESOURCE_ENERGY) || [];
  TradeState.history.tick = Game.time;
  TradeState.history.byRes[RESOURCE_ENERGY] = hist;
  return hist;
}

// ---------- core ----------
const TradeEnergy = {
  run(room) {
    refreshTickGlobals();
    if (!roomMeetsBasics(room)) return;
    if (!canTradeThisTick(room)) return;
    if (!storageHasSurplus(room)) return;

    // With the boring validation out of the way, the rest of the function reads
    // as a linear recipe: find the best buyer, size the shipment, book it.
    var pick = pickBestEnergyOrder(room);
    if (!pick) return;

    var amount = planShipment(room, pick);
    if (amount <= 0) return;

    executeDeal(room, pick, amount);
  },

  runAll() {
    refreshTickGlobals();
    // const hist = getEnergyHistory(); // optional future logic

    for (const name in Game.rooms) {
      const room = Game.rooms[name];
      if (room && room.controller && room.controller.my && room.terminal) {
        this.run(room);
        if (TradeState.dealsThisTick >= 10) break;
      }
    }
  }
};

module.exports = TradeEnergy;

// -----------------------------
// Teaching helpers
// -----------------------------

function roomMeetsBasics(room) {
  // Teaching habit: front-load defensive checks so the main run() body can be
  // written as if everything is valid.
  if (!room || !room.controller || !room.controller.my) return false;
  if (!room.terminal || !room.storage) return false;
  if (TradeState.dealsThisTick >= 10) return false; // global hard-cap
  if (room.terminal.cooldown > 0) return false;
  return true;
}

function storageHasSurplus(room) {
  // Only sell energy when storage stays above the configured safety buffer so
  // upgraders/builders never starve from an overly aggressive trade loop.
  var store = room.storage.store[RESOURCE_ENERGY] || 0;
  return store >= CFG.KEEP_ENERGY_STORAGE;
}

function pickBestEnergyOrder(room) {
  var candidates = fetchEnergyBuyOrders();
  if (!candidates.length) return null;

  var ranked = [];
  for (var i = 0; i < candidates.length; i++) {
    var order = candidates[i];
    if (!order.roomName) continue;
    if (!withinMaxDistance(room, order)) continue;
    var cap = Math.min(order.amount, CFG.MAX_PER_DEAL);
    var test = Math.max(1000, Math.min(cap, 10000));
    var eff = effectiveCreditsPerEnergy(order, room.name, test);
    ranked.push({ order: order, eff: eff });
  }
  if (!ranked.length) return null;

  ranked.sort(function (a, b) { return b.eff - a.eff; });
  var best = ranked[0];
  if (best.eff < CFG.MIN_EFFECTIVE_CPE) return null;
  return best.order;
}

function withinMaxDistance(room, order) {
  if (!Number.isFinite(CFG.MAX_DISTANCE)) return true;
  var dist = Game.map.getRoomLinearDistance(room.name, order.roomName, true);
  return dist <= CFG.MAX_DISTANCE;
}

function planShipment(room, order) {
  var want = Math.min(order.amount, CFG.MAX_PER_DEAL);
  return fitAmountToTerminal(room, order, want);
}

function executeDeal(room, order, amount) {
  var termEnergy = room.terminal.store[RESOURCE_ENERGY] || 0;
  var res = Game.market.deal(order.id, amount, room.name);
  if (res === OK) {
    markTraded(room);
    var fee = Game.market.calcTransactionCost(amount, room.name, order.roomName);
    console.log(
      `[TradeEnergy] ${room.name}: Sold ${amount} energy @ ${order.price.toFixed(3)} to ${order.roomName} ` +
      `(fee ${fee}, eff ${effectiveCreditsPerEnergy(order, room.name, amount).toFixed(3)} cr/energy)`
    );
    return;
  }
  console.log(
    `[TradeEnergy] ${room.name}: deal failed (${res}). tCooldown=${room.terminal.cooldown} termE=${termEnergy} ` +
    `orderAmt=${order.amount} price=${order.price}`
  );
}
