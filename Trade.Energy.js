// Trade.Energy.js
// Purpose: Sell excess ENERGY via the Market using the room Terminal.
// Style: "novice-friendly" — simple, explicit, heavily commented.

// ===== Config you can tweak safely =====
const CFG = {
  // Keep this much in Storage for emergencies (towers, rebuilds, “oops!”)
  KEEP_ENERGY_STORAGE: 300_000,

  // Keep some energy inside the Terminal for future trades / ops
  KEEP_ENERGY_TERMINAL: 50_000,

  // Don't bother selling below this price (credits per unit)
  MIN_PRICE: 0.15,

  // Max units to attempt per one deal (keeps CPU calm)
  MAX_PER_DEAL: 20_000,

  // Only try one deal every N ticks per room so we don't spam market / CPU
  COOLDOWN_TICKS: 25,

  // Ignore tiny buy orders (not worth the fee/CPU churn)
  MIN_ORDER_AMOUNT: 2_000,

  // How many top BUY orders to examine before picking (0 = all; 20 is plenty)
  SCAN_TOP_N: 20
};

// ===== Helpers =====

// Effective price considering transaction energy cost.
// When you "deal" a BUY order, you send `amount` energy and also pay an extra
// energy `fee` (transaction cost). So total energy lost = amount + fee.
// Credits received = amount * price.
// We rank orders by "credits per net energy spent".
function effectiveCreditsPerEnergy(order, roomName, amount) {
  const fee = Game.market.calcTransactionCost(amount, roomName, order.roomName);
  const netEnergySpent = amount + fee;
  if (netEnergySpent <= 0) return 0;
  return (order.price * amount) / netEnergySpent;
}

// Shrink `amount` until Terminal has enough energy to cover amount + fee
// and we still keep our terminal reserve. Returns the final amount (>=0).
function fitAmountToTerminal(room, order, desiredAmount) {
  const term = room.terminal;
  if (!term) return 0;

  // Energy we must keep in the terminal
  const reserve = CFG.KEEP_ENERGY_TERMINAL;

  // Available energy we can spend (both to ship and to pay the fee)
  let spendable = (term.store[RESOURCE_ENERGY] || 0) - reserve;
  if (spendable <= 0) return 0;

  // Start with desiredAmount, reduce in steps if needed
  let amt = Math.max(0, Math.min(desiredAmount, spendable));
  if (amt === 0) return 0;

  // Reduce until amt + fee <= spendable
  // step size 500 to converge quickly without tons of CPU
  const STEP = 500;
  for (let guard = 0; guard < 100 && amt > 0; guard++) {
    const fee = Game.market.calcTransactionCost(amt, room.name, order.roomName);
    if (amt + fee <= spendable) break;
    amt = Math.max(0, amt - STEP);
  }
  return amt;
}

// Persisted per-room throttle
function canTradeThisTick(room) {
  if (!Memory.trade) Memory.trade = {};
  if (!Memory.trade.rooms) Memory.trade.rooms = {};
  const rec = Memory.trade.rooms[room.name] || (Memory.trade.rooms[room.name] = { last: 0 });
  const now = Game.time || 0;
  return now - rec.last >= CFG.COOLDOWN_TICKS;
}

function markTraded(room) {
  Memory.trade.rooms[room.name] = Memory.trade.rooms[room.name] || {};
  Memory.trade.rooms[room.name].last = Game.time || 0;
}

// ===== Core =====
const TradeEnergy = {
  /**
   * Try to sell energy from ONE room (if it has a Terminal and surplus).
   * Safe to call every tick; internal cooldown prevents spam.
   */
  run(room) {
    if (!room || !room.terminal || !room.storage) return; // needs both
    if (!canTradeThisTick(room)) return;

    const storageEnergy = room.storage.store[RESOURCE_ENERGY] || 0;
    const termEnergy = room.terminal.store[RESOURCE_ENERGY] || 0;

    // Only trade if we truly have surplus in STORAGE
    if (storageEnergy < CFG.KEEP_ENERGY_STORAGE) return;

    // Get BUY orders for ENERGY
    let orders = Game.market.getAllOrders({
      type: ORDER_BUY,
      resourceType: RESOURCE_ENERGY
    });

    // Filter obviously bad orders
    orders = orders.filter(o =>
      o.amount >= CFG.MIN_ORDER_AMOUNT &&
      o.price >= CFG.MIN_PRICE
    );

    if (!orders.length) return; // no decent buyers right now

    // Consider only the best N by nominal price to keep CPU low
    orders.sort((a, b) => b.price - a.price);
    if (CFG.SCAN_TOP_N > 0 && orders.length > CFG.SCAN_TOP_N) {
      orders = orders.slice(0, CFG.SCAN_TOP_N);
    }

    // For each candidate, compute the "effective" credits per real energy spent
    // using a tentative amount (we'll fit it to the terminal later).
    // Start with desired = min(order.amount, MAX_PER_DEAL)
    let ranked = [];
    for (const o of orders) {
      const tentative = Math.min(o.amount, CFG.MAX_PER_DEAL);
      // Use a tiny test amount (e.g., 10k or less) to estimate efficiency
      const testAmt = Math.max(1000, Math.min(tentative, 10_000));
      const eff = effectiveCreditsPerEnergy(o, room.name, testAmt);
      ranked.push([o, eff]);
    }

    // Choose the order with the best effective credits per net energy
    ranked.sort((A, B) => B[1] - A[1]);
    const best = ranked[0] && ranked[0][0];
    if (!best) return;

    // Final amount: respect order cap, our per-deal cap, and terminal energy
    const want = Math.min(best.amount, CFG.MAX_PER_DEAL);

    // We can only ship what's in the TERMINAL (not storage),
    // so if terminal is low, sell less (or not at all).
    let amount = fitAmountToTerminal(room, best, want);
    if (amount <= 0) return; // terminal energy too low to cover fee+ship

    // Do the deal!
    const res = Game.market.deal(best.id, amount, room.name);
    if (res === OK) {
      markTraded(room);
      const fee = Game.market.calcTransactionCost(amount, room.name, best.roomName);
      console.log(
        `[TradeEnergy] ${room.name}: Sold ${amount} energy to ${best.roomName} @ ${best.price.toFixed(3)} ` +
        `(fee ${fee}, eff ${(effectiveCreditsPerEnergy(best, room.name, amount)).toFixed(3)} cr/energy)`
      );
    } else {
      // If failed, don't lock ourselves; we just log it.
      console.log(`[TradeEnergy] ${room.name}: deal failed with code ${res}`);
    }
  },

  /**
   * Call this once per tick to try all your visible rooms.
   * (It just loops run(room) over owned rooms with terminals)
   */
  runAll() {
    for (const name in Game.rooms) {
      const room = Game.rooms[name];
      if (room && room.controller && room.controller.my && room.terminal) {
        this.run(room);
      }
    }
  }
};

module.exports = TradeEnergy;
