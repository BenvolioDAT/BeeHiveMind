
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
    if (!room || !room.controller || !room.controller.my) return;
    if (!room.terminal || !room.storage) return;

    // global hard-cap: API allows only 10 deals/player/tick
    if (TradeState.dealsThisTick >= 10) return;

    // skip if terminal is cooling down (deals also apply cooldown)
    if (room.terminal.cooldown && room.terminal.cooldown > 0) return;

    if (!canTradeThisTick(room)) return;

    const store = room.storage.store[RESOURCE_ENERGY] || 0;
    const termE = room.terminal.store[RESOURCE_ENERGY] || 0;
    if (store < CFG.KEEP_ENERGY_STORAGE) return; // no true surplus

    const candidates = fetchEnergyBuyOrders();
    if (!candidates.length) return;

    // pick best by *effective* credits/energy using a small test amount
    const ranked = [];
    for (const o of candidates) {
      if (!o.roomName) continue;

      if (Number.isFinite(CFG.MAX_DISTANCE)) {
        const d = Game.map.getRoomLinearDistance(room.name, o.roomName, true);
        if (d > CFG.MAX_DISTANCE) continue;
      }

      const cap = Math.min(o.amount, CFG.MAX_PER_DEAL);
      const test = Math.max(1000, Math.min(cap, 10000));
      const eff = effectiveCreditsPerEnergy(o, room.name, test);
      ranked.push([o, eff]);
    }
    if (!ranked.length) return;

    ranked.sort((A, B) => B[1] - A[1]);
    const best = ranked[0][0];
    const bestEff = ranked[0][1];

    if (bestEff < CFG.MIN_EFFECTIVE_CPE) return;

    const want = Math.min(best.amount, CFG.MAX_PER_DEAL);
    let amount = fitAmountToTerminal(room, best, want);
    if (amount <= 0) return;

    const res = Game.market.deal(best.id, amount, room.name);
    if (res === OK) {
      markTraded(room);
      const fee = Game.market.calcTransactionCost(amount, room.name, best.roomName);
      console.log(
        `[TradeEnergy] ${room.name}: Sold ${amount} energy @ ${best.price.toFixed(3)} to ${best.roomName} ` +
        `(fee ${fee}, eff ${effectiveCreditsPerEnergy(best, room.name, amount).toFixed(3)} cr/energy)`
      );
    } else {
      console.log(
        `[TradeEnergy] ${room.name}: deal failed (${res}). tCooldown=${room.terminal.cooldown} termE=${termE} ` +
        `orderAmt=${best.amount} price=${best.price}`
      );
    }
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
