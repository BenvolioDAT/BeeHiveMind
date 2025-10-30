'use strict';

function safeRequire(name) {
  try {
    return require(name);
  } catch (err) {
    return null;
  }
}

const TaskBaseHarvest = safeRequire('Task.BaseHarvest');

const TASK_SPECS = Object.create(null);

let truckerCourierWarningLogged = false;

function warnMissingCourierForTrucker() {
  if (truckerCourierWarningLogged) {
    return;
  }
  truckerCourierWarningLogged = true;
  try {
    console.log('[Task.Spawn] WARN: Task.Courier spec unavailable; trucker spawn bodies disabled.');
  } catch (err) {
    // ignore console failures (e.g., mocked environments)
  }
}

function cloneParts(parts) {
  if (!Array.isArray(parts)) {
    return [];
  }
  const out = new Array(parts.length);
  for (let i = 0; i < parts.length; i++) {
    out[i] = parts[i];
  }
  return out;
}

function shallowCloneContext(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    return {};
  }
  const copy = {};
  for (const key in ctx) {
    if (Object.prototype.hasOwnProperty.call(ctx, key)) {
      copy[key] = ctx[key];
    }
  }
  return copy;
}

function arraysEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

function repeatPart(part, count) {
  const body = [];
  const limit = (typeof count === 'number' && count > 0) ? count : 0;
  for (let i = 0; i < limit; i++) {
    body.push(part);
  }
  return body;
}

function bodyCounts(definition) {
  const body = [];
  if (!Array.isArray(definition)) {
    return body;
  }
  for (let i = 0; i < definition.length; i++) {
    const entry = definition[i];
    if (!entry) {
      continue;
    }
    if (typeof entry === 'string') {
      body.push(entry);
      continue;
    }
    const part = entry.part;
    const count = entry.count;
    if (!part) {
      continue;
    }
    const limit = (typeof count === 'number' && count > 0) ? count : 0;
    for (let j = 0; j < limit; j++) {
      body.push(part);
    }
  }
  return body;
}

function computeBodyCost(parts) {
  if (!Array.isArray(parts)) {
    return 0;
  }
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    total += BODYPART_COST[part] || 0;
  }
  return total;
}

function availableEnergy(entity) {
  if (!entity) {
    return 0;
  }
  if (typeof entity.energyAvailable === 'number') {
    return entity.energyAvailable;
  }
  if (entity.room && typeof entity.room.energyAvailable === 'number') {
    return entity.room.energyAvailable;
  }
  return 0;
}

function energyCapacity(entity, available) {
  if (!entity) {
    return available || 0;
  }
  if (typeof entity.energyCapacityAvailable === 'number') {
    return entity.energyCapacityAvailable;
  }
  if (entity.room && typeof entity.room.energyCapacityAvailable === 'number') {
    return entity.room.energyCapacityAvailable;
  }
  return available || 0;
}

function resolveAvailableEnergy(room, ctx) {
  if (ctx && typeof ctx.availableEnergy === 'number') {
    return ctx.availableEnergy;
  }
  if (ctx && typeof ctx.energyAvailable === 'number') {
    return ctx.energyAvailable;
  }
  if (room && typeof room.energyAvailable === 'number') {
    return room.energyAvailable;
  }
  return 0;
}

function resolveCapacityEnergy(room, ctx, available) {
  if (ctx && typeof ctx.capacityEnergy === 'number') {
    return ctx.capacityEnergy;
  }
  if (ctx && typeof ctx.energyCapacity === 'number') {
    return ctx.energyCapacity;
  }
  if (room && typeof room.energyCapacityAvailable === 'number') {
    return room.energyCapacityAvailable;
  }
  return available;
}

function countParts(parts, partType) {
  if (!Array.isArray(parts) || !parts.length) {
    return 0;
  }
  let total = 0;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === partType) {
      total++;
    }
  }
  return total;
}

function selectTierByEnergy(tiers, energy, maxWork) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return null;
  }
  const cap = (typeof energy === 'number' && energy >= 0) ? energy : 0;
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    if (!tier || !Array.isArray(tier.parts) || tier.parts.length === 0) {
      continue;
    }
    if (typeof maxWork === 'number' && maxWork > 0) {
      if (countParts(tier.parts, WORK) > maxWork) {
        continue;
      }
    }
    if (tier.cost <= cap) {
      return tier;
    }
  }
  return null;
}

function defineSpec(name, config) {
  if (!name || !config) {
    return;
  }
  const tiers = [];
  if (Array.isArray(config.bodies)) {
    for (let i = 0; i < config.bodies.length; i++) {
      const raw = config.bodies[i];
      const parts = Array.isArray(raw) ? raw.slice() : bodyCounts(raw);
      tiers.push({
        tier: i + 1,
        parts: parts,
        cost: computeBodyCost(parts)
      });
    }
  }
  config.tiers = tiers;
  TASK_SPECS[name] = config;
}

function aliasSpecBodies(targetName, sourceName, onMissing) {
  const source = TASK_SPECS[sourceName];
  const target = TASK_SPECS[targetName];
  if (!target || !source) {
    if (typeof onMissing === 'function') {
      onMissing();
    }
    return;
  }
  target.bodies = source.bodies;
  target.tiers = source.tiers;
}

function normalizeTaskName(name) {
  if (!name) {
    return null;
  }
  return String(name);
}

function selectDefaultTier(spec, room, ctx) {
  const available = resolveAvailableEnergy(room, ctx);
  const capacity = resolveCapacityEnergy(room, ctx, available);
  let tier = selectTierByEnergy(spec.tiers, capacity, null);
  let rationale = 'capacity-tier';
  if (!tier) {
    tier = selectTierByEnergy(spec.tiers, available, null);
    rationale = 'available-tier';
  }
  if (!tier && spec.tiers.length) {
    tier = spec.tiers[spec.tiers.length - 1];
    rationale = 'fallback-tier';
  }
  if (!tier) {
    return { parts: [], cost: 0, tier: 0, rationale: 'no-tier' };
  }
  return {
    parts: tier.parts.slice(),
    cost: tier.cost,
    tier: tier.tier,
    rationale: rationale
  };
}

function selectDismantlerTier(spec, room, ctx) {
  const available = resolveAvailableEnergy(room, ctx);
  const tier = selectTierByEnergy(spec.tiers, available, null);
  if (!tier) {
    return { parts: [], cost: 0, tier: 0, rationale: 'insufficient-energy' };
  }
  return {
    parts: tier.parts.slice(),
    cost: tier.cost,
    tier: tier.tier,
    rationale: 'available-tier'
  };
}

function selectUpgraderTier(spec, room, ctx) {
  const available = resolveAvailableEnergy(room, ctx);
  const capacity = resolveCapacityEnergy(room, ctx, available);
  const economy = ctx && ctx.economyState;
  if (economy) {
    if (economy.recoveryMode || !economy.hasHarvester || !economy.hasCourier) {
      return { parts: [], cost: 0, tier: 0, rationale: 'economy-suppressed' };
    }
  }
  const tier = selectTierByEnergy(spec.tiers, available, null);
  if (!tier || tier.cost > capacity) {
    return { parts: [], cost: 0, tier: 0, rationale: 'insufficient-energy' };
  }
  return {
    parts: tier.parts.slice(),
    cost: tier.cost,
    tier: tier.tier,
    rationale: 'available-tier'
  };
}

function selectCombatMeleeTier(spec, room, ctx) {
  const available = resolveAvailableEnergy(room, ctx);
  let tier = selectTierByEnergy(spec.tiers, available, null);
  let rationale = 'available-tier';
  if (!tier && spec.tiers.length) {
    tier = spec.tiers[spec.tiers.length - 1];
    rationale = 'fallback-tier';
  }
  if (!tier) {
    return { parts: [], cost: 0, tier: 0, rationale: 'no-tier' };
  }
  return {
    parts: tier.parts.slice(),
    cost: tier.cost,
    tier: tier.tier,
    rationale: rationale
  };
}

function selectCombatArcherTier(spec, room, ctx) {
  const available = resolveAvailableEnergy(room, ctx);
  let tier = selectTierByEnergy(spec.tiers, available, null);
  let rationale = 'available-tier';
  if (!tier && spec.tiers.length) {
    tier = spec.tiers[spec.tiers.length - 1];
    rationale = 'fallback-tier';
  }
  if (!tier) {
    return { parts: [], cost: 0, tier: 0, rationale: 'no-tier' };
  }
  return {
    parts: tier.parts.slice(),
    cost: tier.cost,
    tier: tier.tier,
    rationale: rationale
  };
}

function selectCombatMedicTier(spec, room, ctx) {
  const available = resolveAvailableEnergy(room, ctx);
  let tier = selectTierByEnergy(spec.tiers, available, null);
  let rationale = 'available-tier';
  if (!tier && spec.tiers.length) {
    tier = spec.tiers[spec.tiers.length - 1];
    rationale = 'fallback-tier';
  }
  if (!tier) {
    return { parts: [], cost: 0, tier: 0, rationale: 'no-tier' };
  }
  return {
    parts: tier.parts.slice(),
    cost: tier.cost,
    tier: tier.tier,
    rationale: rationale
  };
}

function getHarvesterIntel(room, ctx) {
  if (ctx) {
    if (ctx.harvesterIntel && typeof ctx.harvesterIntel === 'object') {
      return ctx.harvesterIntel;
    }
    if (ctx.intel && typeof ctx.intel === 'object') {
      return ctx.intel;
    }
  }
  let roomName = null;
  if (room && typeof room.name === 'string') {
    roomName = room.name;
  } else if (ctx) {
    if (typeof ctx.home === 'string') {
      roomName = ctx.home;
    } else if (typeof ctx.homeRoom === 'string') {
      roomName = ctx.homeRoom;
    } else if (typeof ctx.roomName === 'string') {
      roomName = ctx.roomName;
    } else if (ctx.room && typeof ctx.room.name === 'string') {
      roomName = ctx.room.name;
    } else if (ctx.request && typeof ctx.request.home === 'string') {
      roomName = ctx.request.home;
    } else if (ctx.request && typeof ctx.request.homeRoom === 'string') {
      roomName = ctx.request.homeRoom;
    }
  }
  if (!roomName) {
    return null;
  }
  if (global && global.__BHM_CACHE && global.__BHM_CACHE.harvesterIntelByRoom) {
    return global.__BHM_CACHE.harvesterIntelByRoom[roomName] || null;
  }
  return null;
}

function resolveHarvesterConfig(ctx) {
  if (ctx) {
    if (ctx.harvesterConfig && typeof ctx.harvesterConfig === 'object') {
      return ctx.harvesterConfig;
    }
    if (ctx.request && ctx.request.harvesterConfig && typeof ctx.request.harvesterConfig === 'object') {
      return ctx.request.harvesterConfig;
    }
  }
  if (TaskBaseHarvest && typeof TaskBaseHarvest.resolveHarvesterConfig === 'function') {
    try {
      return TaskBaseHarvest.resolveHarvesterConfig();
    } catch (err) {
      // fall through to globals
    }
  }
  if (global && global.__beeHarvesterConfig && typeof global.__beeHarvesterConfig === 'object') {
    return global.__beeHarvesterConfig;
  }
  return { MAX_WORK: 6, RENEWAL_TTL: 150, EMERGENCY_TTL: 50 };
}

function selectBaseharvestTier(spec, room, ctx) {
  const available = resolveAvailableEnergy(room, ctx);
  const capacity = resolveCapacityEnergy(room, ctx, available);
  const harvesterConfig = resolveHarvesterConfig(ctx);
  const maxWork = (harvesterConfig && typeof harvesterConfig.MAX_WORK === 'number') ? harvesterConfig.MAX_WORK : 6;
  const targetTier = selectTierByEnergy(spec.tiers, capacity, maxWork);
  const fallbackTier = selectTierByEnergy(spec.tiers, available, maxWork);
  const targetCost = targetTier ? targetTier.cost : 0;
  const fallbackCost = fallbackTier ? fallbackTier.cost : 0;
  const intel = getHarvesterIntel(room, ctx) || {};
  let desired = null;
  if (ctx && typeof ctx.limit === 'number') {
    desired = ctx.limit;
  }
  if (desired === null && typeof intel.desiredCount === 'number') {
    desired = intel.desiredCount;
  }
  if (desired === null) {
    desired = 1;
  }
  let coverage = null;
  if (ctx && typeof ctx.current === 'number') {
    coverage = ctx.current;
  }
  if (coverage === null && typeof intel.coverage === 'number') {
    coverage = intel.coverage;
  }
  if (coverage === null) {
    coverage = 0;
  }

  const result = { parts: [], cost: 0, tier: 0, rationale: 'none' };
  const canAffordTarget = !!(targetTier && targetCost > 0 && available >= targetCost);
  const canAffordFallback = !!(fallbackTier && fallbackCost > 0 && available >= fallbackCost);

  if (coverage < desired) {
    const tier = canAffordTarget ? targetTier : (canAffordFallback ? fallbackTier : null);
    if (tier) {
      result.parts = tier.parts.slice();
      result.cost = tier.cost;
      result.tier = tier.tier;
      result.rationale = canAffordTarget ? 'coverage-target' : 'coverage-fallback';
      return result;
    }
    return result;
  }

  const active = (typeof intel.active === 'number') ? intel.active : 0;
  if (active <= 0) {
    return result;
  }

  const renewalTtl = (harvesterConfig && typeof harvesterConfig.RENEWAL_TTL === 'number') ? harvesterConfig.RENEWAL_TTL : 150;
  const lowestTtl = (typeof intel.lowestTtl === 'number') ? intel.lowestTtl : null;
  if (lowestTtl === null || lowestTtl > renewalTtl) {
    return result;
  }

  const hatching = (typeof intel.hatching === 'number') ? intel.hatching : 0;
  if (hatching > 0) {
    return result;
  }

  if (canAffordTarget) {
    result.parts = targetTier.parts.slice();
    result.cost = targetTier.cost;
    result.tier = targetTier.tier;
    result.rationale = 'renewal-target';
    return result;
  }

  const highestCost = (typeof intel.highestCost === 'number') ? intel.highestCost : 0;
  const canUpgrade = targetCost > highestCost;

  if (!canUpgrade && canAffordFallback && fallbackCost === targetCost) {
    result.parts = fallbackTier.parts.slice();
    result.cost = fallbackTier.cost;
    result.tier = fallbackTier.tier;
    result.rationale = 'renewal-fallback';
    return result;
  }

  const emergencyTtl = (harvesterConfig && typeof harvesterConfig.EMERGENCY_TTL === 'number') ? harvesterConfig.EMERGENCY_TTL : 50;
  if (lowestTtl != null && lowestTtl <= emergencyTtl && canAffordFallback) {
    result.parts = fallbackTier.parts.slice();
    result.cost = fallbackTier.cost;
    result.tier = fallbackTier.tier;
    result.rationale = 'emergency-fallback';
    return result;
  }

  if (!canUpgrade && targetTier) {
    result.parts = targetTier.parts.slice();
    result.cost = targetTier.cost;
    result.tier = targetTier.tier;
    result.rationale = 'renewal-target-deferred';
    return result;
  }

  return result;
}

function selectCourierTier(spec, room, ctx) {
  const available = resolveAvailableEnergy(room, ctx);
  const tier = selectTierByEnergy(spec.tiers, available, null);
  if (tier) {
    return {
      parts: tier.parts.slice(),
      cost: tier.cost,
      tier: tier.tier,
      rationale: 'available-energy'
    };
  }
  if (spec.tiers && spec.tiers.length) {
    const fallback = spec.tiers[spec.tiers.length - 1];
    return {
      parts: fallback.parts.slice(),
      cost: fallback.cost,
      tier: fallback.tier,
      rationale: 'fallback-tier'
    };
  }
  return { parts: [], cost: 0, tier: 0, rationale: 'no-tier' };
}

function selectTruckerTier(spec, room, ctx) {
  const courierSpec = TASK_SPECS.courier;
  if (!courierSpec || !Array.isArray(courierSpec.tiers) || !courierSpec.tiers.length) {
    warnMissingCourierForTrucker();
    return { parts: [], cost: 0, tier: 0, rationale: 'courier-spec-missing' };
  }
  const selection = selectCourierTier(courierSpec, room, ctx);
  if (!selection || !Array.isArray(selection.parts) || !selection.parts.length) {
    warnMissingCourierForTrucker();
    return { parts: [], cost: 0, tier: 0, rationale: 'courier-spec-empty' };
  }
  selection.rationale = selection.rationale ? (selection.rationale + '|courier-alias') : 'courier-alias';
  return selection;
}

function selectQueenTier(spec, room, ctx) {
  const available = resolveAvailableEnergy(room, ctx);
  const tier = selectTierByEnergy(spec.tiers, available, null);
  if (tier) {
    return {
      parts: tier.parts.slice(),
      cost: tier.cost,
      tier: tier.tier,
      rationale: 'available-energy'
    };
  }
  return { parts: [], cost: 0, tier: 0, rationale: 'no-tier' };
}

function selectRemoteTier(spec, room, ctx) {
  const available = resolveAvailableEnergy(room, ctx);
  const capacity = resolveCapacityEnergy(room, ctx, available);
  let tier = selectTierByEnergy(spec.tiers, capacity, null);
  let rationale = 'remote-capacity';
  if (!tier) {
    tier = selectTierByEnergy(spec.tiers, available, null);
    rationale = 'remote-available';
  }
  if (!tier && spec.tiers.length) {
    tier = spec.tiers[spec.tiers.length - 1];
    rationale = 'remote-fallback';
  }
  if (!tier) {
    return { parts: [], cost: 0, tier: 0, rationale: 'no-tier' };
  }
  return {
    parts: tier.parts.slice(),
    cost: tier.cost,
    tier: tier.tier,
    rationale: rationale
  };
}

function findMatchingTierIndex(tiers, body) {
  if (!Array.isArray(tiers) || !Array.isArray(body)) {
    return 0;
  }
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    if (!tier || !Array.isArray(tier.parts)) {
      continue;
    }
    if (arraysEqual(tier.parts, body)) {
      return tier.tier || (i + 1);
    }
  }
  return 0;
}

function extractBlockedUntil(ctx) {
  if (!ctx || typeof ctx !== 'object') {
    return null;
  }
  if (typeof ctx.blockedUntil === 'number') {
    return ctx.blockedUntil;
  }
  if (ctx.plan && typeof ctx.plan.blockedUntil === 'number') {
    return ctx.plan.blockedUntil;
  }
  if (ctx.remote && typeof ctx.remote.blockedUntil === 'number') {
    return ctx.remote.blockedUntil;
  }
  if (ctx.request && typeof ctx.request.blockedUntil === 'number') {
    return ctx.request.blockedUntil;
  }
  return null;
}

function createRemoteMinerContext(room, ctx, available, capacity) {
  const base = shallowCloneContext(ctx);
  base.availableEnergy = available;
  base.capacityEnergy = capacity;
  if (!base.remoteRole) {
    base.remoteRole = (ctx && ctx.remoteRole) || 'miner';
  }
  const plan = base.plan || (ctx && ctx.plan) || null;
  if (plan && !base.plan) {
    base.plan = plan;
  }
  const remoteRoom = (ctx && ctx.remoteRoom) || (plan && plan.remote) || base.remoteRoom || null;
  if (remoteRoom && !base.remoteRoom) {
    base.remoteRoom = remoteRoom;
  }
  if (!base.limit) {
    if (plan && plan.desired != null) {
      base.limit = plan.desired;
    } else if (plan && plan.limit != null) {
      base.limit = plan.limit;
    }
  }
  if (base.current == null && plan && plan.actual && plan.type && plan.actual[plan.type] != null) {
    base.current = plan.actual[plan.type];
  }
  if (!base.seatId && plan && plan.seatId) {
    base.seatId = plan.seatId;
  }
  if (!base.sourceId && plan && plan.seatId) {
    base.sourceId = plan.seatId;
  }
  if (!base.remote && ctx && ctx.remote) {
    base.remote = ctx.remote;
  }
  if (!base.request || typeof base.request !== 'object') {
    base.request = {};
  }
  const request = base.request;
  if (plan) {
    if (request.remoteRole == null && plan.remoteRole != null) {
      request.remoteRole = plan.remoteRole;
    }
    if (request.remoteRole == null && plan.type != null) {
      request.remoteRole = plan.type;
    }
    if (request.remoteRoom == null && plan.remote) {
      request.remoteRoom = plan.remote;
    }
    if (request.targetRoom == null && plan.remote) {
      request.targetRoom = plan.remote;
    }
    if (request.sourceId == null && plan.seatId) {
      request.sourceId = plan.seatId;
    }
    if (request.seatId == null && plan.seatId) {
      request.seatId = plan.seatId;
    }
  }
  if (room && typeof room.name === 'string') {
    if (!base.home) {
      base.home = room.name;
    }
    if (!request.home) {
      request.home = room.name;
    }
  }
  return base;
}

function selectRemoteMinerBody(energy, room, ctx) {
  if (!TaskBaseHarvest || typeof TaskBaseHarvest.getSpawnBody !== 'function') {
    return [];
  }
  try {
    const body = TaskBaseHarvest.getSpawnBody(energy, room, ctx);
    return Array.isArray(body) ? cloneParts(body) : [];
  } catch (err) {
    return [];
  }
}

function selectRemoteMinerTier(spec, room, ctx) {
  const available = resolveAvailableEnergy(room, ctx);
  const capacity = resolveCapacityEnergy(room, ctx, available);
  const selectionContext = createRemoteMinerContext(room, ctx, available, capacity);
  const harvesterConfig = resolveHarvesterConfig(selectionContext);
  const maxWork = (harvesterConfig && typeof harvesterConfig.MAX_WORK === 'number') ? harvesterConfig.MAX_WORK : 6;

  let capacityBody = selectRemoteMinerBody(capacity, room, selectionContext);
  let capacityCost = computeBodyCost(capacityBody);
  if ((!capacityBody.length || capacityCost <= 0 || capacityCost > capacity) && spec.tiers.length) {
    const capTier = selectTierByEnergy(spec.tiers, capacity, maxWork);
    if (capTier) {
      capacityBody = capTier.parts.slice();
      capacityCost = capTier.cost;
    }
  }
  if ((!capacityBody.length || capacityCost <= 0) && spec.tiers.length) {
    const fallback = spec.tiers[spec.tiers.length - 1];
    capacityBody = fallback.parts.slice();
    capacityCost = fallback.cost;
  }

  let workingBody = selectRemoteMinerBody(available, room, selectionContext);
  let workingCost = computeBodyCost(workingBody);
  if ((!workingBody.length || workingCost <= 0 || workingCost > available) && spec.tiers.length) {
    const availTier = selectTierByEnergy(spec.tiers, available, maxWork);
    if (availTier) {
      workingBody = availTier.parts.slice();
      workingCost = availTier.cost;
    }
  }
  if ((!workingBody.length || workingCost <= 0 || workingCost > available) && spec.tiers.length) {
    const fallbackTier = spec.tiers[spec.tiers.length - 1];
    workingBody = fallbackTier.parts.slice();
    workingCost = fallbackTier.cost;
  }

  if (!workingBody.length || workingCost <= 0) {
    return { parts: [], cost: 0, tier: 0, rationale: 'no-tier' };
  }

  const tierIndex = findMatchingTierIndex(spec.tiers, workingBody);
  return {
    parts: workingBody.slice(),
    cost: workingCost,
    tier: tierIndex,
    rationale: (workingCost === capacityCost && arraysEqual(workingBody, capacityBody)) ? 'remote-capacity' : 'remote-available'
  };
}

function remoteMinerGates(room, ctx, bodyInfo) {
  const gates = ['energyAvailable >= cost', 'energyCapacityAvailable >= cost'];
  const plan = ctx && ctx.plan ? ctx.plan : null;
  if (plan && String(plan.status || '').toUpperCase() === 'BLOCKED') {
    gates.push('remote status != BLOCKED');
  }
  const blockedUntil = extractBlockedUntil(ctx);
  if (blockedUntil) {
    gates.push('blockedUntil elapsed');
  }
  return gates;
}

const buildRemoteMinerMemory = remoteMemoryBuilder('miner');

function remoteMinerMemoryBuilder(room, ctx) {
  const memory = buildRemoteMinerMemory(room, ctx) || {};
  if (!memory.role) {
    memory.role = 'Worker_Bee';
  }
  if (!memory.task) {
    memory.task = 'luna';
  }
  if (!memory.bornTask) {
    memory.bornTask = 'luna';
  }
  if (!memory.remoteRole) {
    memory.remoteRole = 'miner';
  }
  if (!memory.remoteRoom && memory.targetRoom) {
    memory.remoteRoom = memory.targetRoom;
  }
  if (!memory.targetRoom && memory.remoteRoom) {
    memory.targetRoom = memory.remoteRoom;
  }
  const seatId = memory.seatId || (ctx && ctx.seatId) || (ctx && ctx.sourceId) || (ctx && ctx.request && ctx.request.seatId) || (ctx && ctx.plan && ctx.plan.seatId);
  if (seatId && !memory.seatId) {
    memory.seatId = seatId;
  }
  if (seatId && !memory.sourceId) {
    memory.sourceId = seatId;
  }
  if (seatId && !memory.targetId) {
    memory.targetId = seatId;
  }
  if (!memory.home) {
    if (ctx && typeof ctx.home === 'string') {
      memory.home = ctx.home;
    } else if (ctx && ctx.request && typeof ctx.request.home === 'string') {
      memory.home = ctx.request.home;
    } else if (room && typeof room.name === 'string') {
      memory.home = room.name;
    }
  }
  return memory;
}

function resolveQuotaFromContext(taskName, room, ctx, fallback) {
  if (ctx && ctx.quotas && typeof ctx.quotas[taskName] === 'number') {
    return ctx.quotas[taskName];
  }
  if (ctx && ctx.limits && typeof ctx.limits[taskName] === 'number') {
    return ctx.limits[taskName];
  }
  if (fallback != null) {
    return fallback;
  }
  return 0;
}

function baseharvestQuota(room, ctx) {
  const intel = getHarvesterIntel(room, ctx) || {};
  if (ctx && typeof ctx.limit === 'number') {
    return ctx.limit;
  }
  if (typeof intel.desiredCount === 'number') {
    return intel.desiredCount;
  }
  if (ctx && ctx.quotas && typeof ctx.quotas.baseharvest === 'number') {
    return ctx.quotas.baseharvest;
  }
  return 1;
}

function resolveCourierLimit(ctx) {
  if (!ctx) {
    return null;
  }
  if (typeof ctx.limit === 'number') {
    return ctx.limit;
  }
  if (ctx.workerTaskLimits && typeof ctx.workerTaskLimits.courier === 'number') {
    return ctx.workerTaskLimits.courier;
  }
  if (ctx.limits && typeof ctx.limits.courier === 'number') {
    return ctx.limits.courier;
  }
  if (ctx.quotas && typeof ctx.quotas.courier === 'number') {
    return ctx.quotas.courier;
  }
  return null;
}

function courierQuota(room, ctx) {
  const limit = resolveCourierLimit(ctx);
  let resolved = (limit != null) ? limit : 1;
  const economy = ctx && ctx.economyState;
  if (economy) {
    if (!economy.hasCourier) {
      resolved = Math.max(resolved || 0, 1);
    }
    if (economy.recoveryMode && limit == null) {
      resolved = Math.max(resolved || 0, 1);
    }
  }
  return resolved | 0;
}

function courierPriority(room, ctx) {
  if (ctx && ctx.priority != null) {
    return ctx.priority;
  }
  if (ctx && ctx.priorities && ctx.priorities.courier != null) {
    return ctx.priorities.courier;
  }
  const economy = ctx && ctx.economyState;
  if (economy && !economy.hasCourier) {
    return 2;
  }
  return 2;
}

function courierGates(room, ctx, bodyInfo) {
  const baseGates = defaultGatesBuilder()(room, ctx, bodyInfo);
  const gates = Array.isArray(baseGates) ? baseGates.slice() : [];
  gates.push('ensure courier fallback satisfied');
  const economy = ctx && ctx.economyState;
  if (economy) {
    if (economy.recoveryMode) {
      gates.push('economy recovery mode (non-economic tasks suppressed)');
    }
    if (!economy.hasCourier) {
      gates.push('no active courier present');
    }
  }
  const limit = resolveCourierLimit(ctx);
  if (limit != null) {
    if (ctx && typeof ctx.current === 'number') {
      gates.push('current ' + ctx.current + ' < limit ' + limit);
    } else {
      gates.push('limit ' + limit + ' available');
    }
  }
  return gates;
}

function computeBuilderLimitFromCounts(totalSites, rcl) {
  const sites = (totalSites | 0);
  const level = (rcl | 0);
  if (sites <= 0) {
    return 0;
  }
  if (level <= 2) {
    return 1;
  }
  if (sites <= 5) {
    return 1;
  }
  if (sites <= 20) {
    return 2;
  }
  if (sites <= 50) {
    return 3;
  }
  return 4;
}

function computeBuilderLimit(room, ctx) {
  if (ctx && typeof ctx.limit === 'number') {
    return ctx.limit;
  }
  if (ctx && typeof ctx.builderLimit === 'number') {
    return ctx.builderLimit;
  }
  const totalSites = resolveBuilderSiteTotal(room, ctx);
  if (typeof totalSites === 'number' && totalSites >= 0) {
    const level = (room && room.controller && room.controller.level) || (ctx && ctx.controllerLevel) || 0;
    return computeBuilderLimitFromCounts(totalSites, level);
  }
  return resolveQuotaFromContext('builder', room, ctx, 0);
}

function resolveBuilderSiteTotal(room, ctx) {
  if (!ctx || typeof ctx !== 'object') {
    return null;
  }
  if (typeof ctx.builderSites === 'number') {
    return ctx.builderSites;
  }
  if (typeof ctx.totalBuilderSites === 'number') {
    return ctx.totalBuilderSites;
  }
  if (typeof ctx.totalSites === 'number') {
    return ctx.totalSites;
  }
  if (typeof ctx.constructionSiteCount === 'number') {
    return ctx.constructionSiteCount;
  }
  const counts = ctx.roomSiteCounts;
  if (counts && typeof counts === 'object') {
    const homeName = room && room.name;
    let total = 0;
    let found = false;
    if (homeName && typeof counts[homeName] === 'number') {
      total += counts[homeName];
      found = true;
    }
    let remoteList = null;
    if (Array.isArray(ctx.remoteRooms)) {
      remoteList = ctx.remoteRooms;
    } else if (Array.isArray(ctx.remotes)) {
      remoteList = ctx.remotes;
    } else if (ctx.remote && Array.isArray(ctx.remote.names)) {
      remoteList = ctx.remote.names;
    }
    if (remoteList) {
      for (let i = 0; i < remoteList.length; i++) {
        const remoteName = remoteList[i];
        if (remoteName && typeof counts[remoteName] === 'number') {
          total += counts[remoteName];
          found = true;
        }
      }
    }
    if (found) {
      return total;
    }
  }
  if (ctx.request && typeof ctx.request.totalSites === 'number') {
    return ctx.request.totalSites;
  }
  return null;
}

function builderGates(room, ctx, bodyInfo) {
  const base = defaultGatesBuilder(['requires construction sites'])(room, ctx, bodyInfo);
  const gates = Array.isArray(base) ? base.slice() : [];
  const economy = ctx && ctx.economyState;
  if (economy && economy.recoveryMode) {
    gates.push('economy recovery mode suppresses builders');
  }
  const limit = computeBuilderLimit(room, ctx);
  gates.push('builder limit ' + limit);
  const siteTotal = resolveBuilderSiteTotal(room, ctx);
  if (typeof siteTotal === 'number') {
    gates.push('total sites ' + siteTotal);
  }
  return gates;
}

function upgraderQuota(room, ctx) {
  if (ctx && typeof ctx.limit === 'number') {
    return ctx.limit;
  }
  return resolveQuotaFromContext('upgrader', room, ctx, 2);
}

function upgraderGates(room, ctx, bodyInfo) {
  const base = defaultGatesBuilder(['requires economy healthy state'])(room, ctx, bodyInfo);
  const gates = Array.isArray(base) ? base.slice() : [];
  const economy = ctx && ctx.economyState;
  if (economy) {
    if (economy.recoveryMode) {
      gates.push('economy recovery mode suppresses upgraders');
    }
    if (!economy.hasHarvester) {
      gates.push('requires active harvester');
    }
    if (!economy.hasCourier) {
      gates.push('requires active courier');
    }
  }
  return gates;
}

function repairQuota(room, ctx) {
  if (ctx && typeof ctx.limit === 'number') {
    return ctx.limit;
  }
  return resolveQuotaFromContext('repair', room, ctx, 0);
}

function repairGates(room, ctx, bodyInfo) {
  const base = defaultGatesBuilder(['economy not in recovery'])(room, ctx, bodyInfo);
  const gates = Array.isArray(base) ? base.slice() : [];
  const economy = ctx && ctx.economyState;
  if (economy && economy.recoveryMode) {
    gates.push('economy recovery mode suppresses repairs');
  }
  return gates;
}

function selectRepairTier(spec, room, ctx) {
  const available = resolveAvailableEnergy(room, ctx);
  const tier = selectTierByEnergy(spec && spec.tiers, available, null);
  if (!tier) {
    return { parts: [], cost: 0, tier: 0, rationale: 'unaffordable' };
  }
  return {
    parts: tier.parts.slice(),
    cost: tier.cost,
    tier: tier.tier,
    rationale: 'available-tier'
  };
}

function scoutQuota(room, ctx) {
  if (ctx && typeof ctx.limit === 'number') {
    return ctx.limit;
  }
  return resolveQuotaFromContext('scout', room, ctx, 1);
}

function selectFixedTier(spec) {
  if (!spec || !Array.isArray(spec.tiers) || spec.tiers.length === 0) {
    const parts = [MOVE];
    return {
      parts: parts.slice(),
      cost: computeBodyCost(parts),
      tier: 1,
      rationale: 'fixed-tier'
    };
  }
  const tier = spec.tiers[0];
  return {
    parts: tier.parts.slice(),
    cost: tier.cost,
    tier: tier.tier,
    rationale: 'fixed-tier'
  };
}

function combatQuota(defaultValue) {
  return function (room, ctx) {
    if (ctx && typeof ctx.limit === 'number') {
      return ctx.limit;
    }
    if (ctx && ctx.quotas && typeof ctx.quotas === 'object') {
      const key = ctx.taskName || ctx.role || ctx.task || null;
      if (key && typeof ctx.quotas[key] === 'number') {
        return ctx.quotas[key];
      }
    }
    return defaultValue || 0;
  };
}

function remoteQuotaAccessor(roleKey) {
  return function (room, ctx) {
    if (ctx && typeof ctx.limit === 'number') {
      return ctx.limit;
    }
    const remote = (ctx && ctx.remote) || (ctx && ctx.remoteSummary) || null;
    if (remote && remote.quotas && typeof remote.quotas[roleKey] === 'number') {
      return remote.quotas[roleKey];
    }
    if (ctx && ctx.quotas && typeof ctx.quotas[roleKey] === 'number') {
      return ctx.quotas[roleKey];
    }
    return 0;
  };
}

function defaultPriorityAccessor(value) {
  return function (room, ctx) {
    if (ctx && ctx.priority != null) {
      return ctx.priority;
    }
    if (ctx && ctx.priorities && typeof ctx.priorities === 'object') {
      const taskName = ctx.taskName || ctx.role || ctx.task || null;
      if (taskName && ctx.priorities[taskName] != null) {
        return ctx.priorities[taskName];
      }
    }
    return value;
  };
}

function defaultGatesBuilder(additional) {
  return function (room, ctx, bodyInfo) {
    const gates = ['energyAvailable >= cost'];
    if (room && typeof room.energyCapacityAvailable === 'number') {
      gates.push('energyCapacityAvailable >= cost');
    }
    if (Array.isArray(additional)) {
      for (let i = 0; i < additional.length; i++) {
        gates.push(additional[i]);
      }
    }
    return gates;
  };
}

function remoteGatesBuilder(additional) {
  return function (room, ctx, bodyInfo) {
    const gates = ['energyAvailable >= cost'];
    if (ctx && ctx.remote && ctx.remote.blockedUntil) {
      gates.push('remote not blocked');
    }
    if (Array.isArray(additional)) {
      for (let i = 0; i < additional.length; i++) {
        gates.push(additional[i]);
      }
    }
    return gates;
  };
}

function defaultMemoryBuilder(taskName) {
  return function (room, ctx) {
    const memory = { task: taskName };
    if (ctx && ctx.memory && typeof ctx.memory === 'object') {
      for (const key in ctx.memory) {
        if (Object.prototype.hasOwnProperty.call(ctx.memory, key)) {
          memory[key] = ctx.memory[key];
        }
      }
    }
    if (ctx && ctx.additionalMemory && typeof ctx.additionalMemory === 'object') {
      for (const key in ctx.additionalMemory) {
        if (Object.prototype.hasOwnProperty.call(ctx.additionalMemory, key)) {
          memory[key] = ctx.additionalMemory[key];
        }
      }
    }
    return memory;
  };
}

function remoteMemoryBuilder(defaultRole) {
  return function (room, ctx) {
    const memory = {
      task: 'luna',
      bornTask: 'luna',
      remoteRole: defaultRole
    };
    const request = ctx && ctx.request ? ctx.request : null;
    if (request) {
      if (request.remoteRole) {
        memory.remoteRole = request.remoteRole;
      }
      if (request.remoteRoom) {
        memory.remoteRoom = request.remoteRoom;
      }
      if (request.targetRoom) {
        memory.targetRoom = request.targetRoom;
      }
      if (request.sourceId) {
        memory.sourceId = request.sourceId;
      }
      if (request.seatId) {
        memory.seatId = request.seatId;
        memory.targetId = request.seatId;
      }
    }
    if (ctx && ctx.remoteRole && !memory.remoteRole) {
      memory.remoteRole = ctx.remoteRole;
    }
    if (ctx && ctx.remoteRoom) {
      memory.remoteRoom = ctx.remoteRoom;
    }
    if (ctx && ctx.targetRoom) {
      memory.targetRoom = ctx.targetRoom;
    }
    if (ctx && ctx.sourceId) {
      memory.sourceId = ctx.sourceId;
    }
    if (ctx && ctx.seatId) {
      memory.seatId = ctx.seatId;
      memory.targetId = ctx.seatId;
    }
    if (ctx && ctx.memory && typeof ctx.memory === 'object') {
      for (const key in ctx.memory) {
        if (Object.prototype.hasOwnProperty.call(ctx.memory, key)) {
          memory[key] = ctx.memory[key];
        }
      }
    }
    return memory;
  };
}

function ensureArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  return value != null ? [value] : [];
}

function baseharvestMemoryBuilder(room, ctx) {
  const baseBuilder = defaultMemoryBuilder('baseharvest');
  const memory = baseBuilder(room, ctx) || {};
  if (!memory.role) {
    memory.role = 'Worker_Bee';
  }
  if (!memory.home) {
    let homeName = null;
    if (ctx && typeof ctx.home === 'string') {
      homeName = ctx.home;
    } else if (ctx && typeof ctx.homeRoom === 'string') {
      homeName = ctx.homeRoom;
    } else if (ctx && typeof ctx.roomName === 'string') {
      homeName = ctx.roomName;
    } else if (ctx && ctx.request && typeof ctx.request.home === 'string') {
      homeName = ctx.request.home;
    } else if (ctx && ctx.request && typeof ctx.request.homeRoom === 'string') {
      homeName = ctx.request.homeRoom;
    } else if (room && typeof room.name === 'string') {
      homeName = room.name;
    }
    if (homeName) {
      memory.home = homeName;
    }
  }
  const request = ctx && ctx.request ? ctx.request : null;
  let sourceId = (ctx && ctx.assignedSource) || (ctx && ctx.sourceId) || (request && request.sourceId) || null;
  if (!sourceId && ctx && ctx.source && ctx.source.id) {
    sourceId = ctx.source.id;
  }
  if (!sourceId && request && request.source && request.source.id) {
    sourceId = request.source.id;
  }
  if (sourceId && !memory.assignedSource) {
    memory.assignedSource = sourceId;
  }
  let containerId = (ctx && ctx.assignedContainer) || (ctx && ctx.containerId) || (request && request.containerId) || null;
  if (!containerId && ctx && ctx.container && ctx.container.id) {
    containerId = ctx.container.id;
  }
  if (!containerId && request && request.container && request.container.id) {
    containerId = request.container.id;
  }
  if (containerId && !memory.assignedContainer) {
    memory.assignedContainer = containerId;
  }
  let seatId = (ctx && (ctx.seat || ctx.seatId)) || (request && (request.seat || request.seatId)) || null;
  if (!seatId && ctx && ctx.seatId === 0) {
    seatId = ctx.seatId;
  }
  if (seatId) {
    if (!memory.seat) {
      memory.seat = seatId;
    }
    if (!memory.seatId) {
      memory.seatId = seatId;
    }
    if (!memory.targetId) {
      memory.targetId = seatId;
    }
  }
  if (ctx && ctx.targetRoom && !memory.targetRoom) {
    memory.targetRoom = ctx.targetRoom;
  }
  return memory;
}

function queenMemoryBuilder(room, ctx) {
  const baseBuilder = defaultMemoryBuilder('queen');
  const memory = baseBuilder(room, ctx) || {};
  if (!memory.role) {
    memory.role = 'Worker_Bee';
  }
  if (!memory.home) {
    let homeName = null;
    if (ctx && typeof ctx.home === 'string') {
      homeName = ctx.home;
    } else if (ctx && typeof ctx.homeRoom === 'string') {
      homeName = ctx.homeRoom;
    } else if (ctx && typeof ctx.roomName === 'string') {
      homeName = ctx.roomName;
    } else if (ctx && ctx.request && typeof ctx.request.home === 'string') {
      homeName = ctx.request.home;
    } else if (room && typeof room.name === 'string') {
      homeName = room.name;
    }
    if (homeName) {
      memory.home = homeName;
    }
  }
  return memory;
}

function registerSpecs() {
  const baseharvestBodies = (function () {
    if (TaskBaseHarvest && Array.isArray(TaskBaseHarvest.BODY_TIERS)) {
      return TaskBaseHarvest.BODY_TIERS.map(function (body) {
        return Array.isArray(body) ? body.slice() : [];
      });
    }
    return [
      [].concat(repeatPart(WORK, 6), repeatPart(MOVE, 5)),
      [].concat(repeatPart(WORK, 5), repeatPart(MOVE, 5)),
      [].concat(repeatPart(WORK, 4), repeatPart(MOVE, 4)),
      [].concat(repeatPart(WORK, 3), repeatPart(MOVE, 3)),
      [].concat(repeatPart(WORK, 2), repeatPart(MOVE, 2)),
      [].concat(repeatPart(WORK, 1), repeatPart(MOVE, 1))
    ];
  }());
  // baseharvest
  defineSpec('baseharvest', {
    namePrefix: 'baseharvest',
    bodies: baseharvestBodies,
    selectTier: selectBaseharvestTier,
    quota: baseharvestQuota,
    priority: defaultPriorityAccessor(1),
    gates: defaultGatesBuilder(['harvester intel allows spawn']),
    memoryBuilder: baseharvestMemoryBuilder,
    notes: 'Domestic source miner'
  });

  // courier
  const courierBodies = [];
  (function () {
    function pushTier(carryCount, moveCount) {
      courierBodies.push([].concat(repeatPart(CARRY, carryCount), repeatPart(MOVE, moveCount)));
    }
    pushTier(30, 15);
    pushTier(23, 23);
    for (let c = 22; c >= 1; c--) {
      pushTier(c, c);
    }
  }());
  defineSpec('courier', {
    namePrefix: 'courier',
    bodies: courierBodies,
    selectTier: selectCourierTier,
    quota: courierQuota,
    priority: courierPriority,
    gates: courierGates,
    memoryBuilder: defaultMemoryBuilder('courier'),
    notes: 'Energy hauler for home room'
  });

  // queen
  const queenBodies = [];
  (function () {
    function pushTier(count) {
      queenBodies.push([].concat(repeatPart(CARRY, count), repeatPart(MOVE, count)));
    }
    for (let count = 22; count >= 1; count--) {
      pushTier(count);
    }
  }());
  defineSpec('queen', {
    namePrefix: 'queen',
    bodies: queenBodies,
    selectTier: selectQueenTier,
    quota: function (room, ctx) {
      if (ctx && typeof ctx.limit === 'number') {
        return ctx.limit;
      }
      if (ctx && ctx.workerTaskLimits && typeof ctx.workerTaskLimits.queen === 'number') {
        return ctx.workerTaskLimits.queen;
      }
      return resolveQuotaFromContext('queen', room, ctx, 1);
    },
    priority: defaultPriorityAccessor(3),
    gates: defaultGatesBuilder(['queen ensures spawn refill logistics']),
    memoryBuilder: queenMemoryBuilder,
    notes: 'Primary spawn feeder'
  });

  // builder
  const builderBodies = [];
  (function () {
    function pushTier(work, carry, move) {
      builderBodies.push([].concat(repeatPart(WORK, work), repeatPart(CARRY, carry), repeatPart(MOVE, move)));
    }
    pushTier(6, 12, 18);
    pushTier(4, 8, 12);
    pushTier(3, 6, 9);
    pushTier(2, 4, 6);
    pushTier(2, 2, 4);
    pushTier(1, 2, 3);
    pushTier(1, 1, 2);
    pushTier(1, 1, 1);
  }());
  defineSpec('builder', {
    namePrefix: 'builder',
    bodies: builderBodies,
    selectTier: selectDefaultTier,
    quota: computeBuilderLimit,
    priority: defaultPriorityAccessor(4),
    gates: builderGates,
    memoryBuilder: defaultMemoryBuilder('builder'),
    notes: 'Construction worker'
  });

  // upgrader
  const upgraderBodies = [];
  (function () {
    function pushTier(work, carry, move) {
      upgraderBodies.push([].concat(repeatPart(WORK, work), repeatPart(CARRY, carry), repeatPart(MOVE, move)));
    }
    pushTier(8, 8, 8);
    pushTier(8, 7, 7);
    pushTier(8, 6, 6);
    pushTier(8, 5, 5);
    pushTier(8, 4, 4);
    pushTier(7, 4, 4);
    pushTier(6, 4, 4);
    pushTier(5, 4, 4);
    pushTier(4, 4, 4);
    pushTier(4, 3, 4);
    pushTier(3, 2, 4);
    pushTier(3, 1, 4);
    pushTier(2, 1, 3);
    pushTier(1, 1, 2);
    pushTier(1, 1, 1);
  }());
  defineSpec('upgrader', {
    namePrefix: 'upgrader',
    bodies: upgraderBodies,
    selectTier: selectUpgraderTier,
    quota: upgraderQuota,
    priority: defaultPriorityAccessor(5),
    gates: upgraderGates,
    memoryBuilder: defaultMemoryBuilder('upgrader'),
    notes: 'Controller upgrader'
  });

  // repair
  const repairBodies = [];
  (function () {
    function pushTier(work, carry, move) {
      repairBodies.push([].concat(repeatPart(WORK, work), repeatPart(CARRY, carry), repeatPart(MOVE, move)));
    }
    pushTier(5, 2, 7);
    pushTier(4, 1, 5);
    pushTier(2, 1, 3);
  }());
  defineSpec('repair', {
    namePrefix: 'repair',
    bodies: repairBodies,
    selectTier: selectRepairTier,
    quota: repairQuota,
    priority: defaultPriorityAccessor(6),
    gates: repairGates,
    memoryBuilder: defaultMemoryBuilder('repair'),
    notes: 'Structure repairer'
  });

  // scout
  defineSpec('scout', {
    namePrefix: 'scout',
    bodies: [[MOVE]],
    selectTier: selectFixedTier,
    quota: scoutQuota,
    priority: defaultPriorityAccessor(7),
    gates: defaultGatesBuilder(['requires intel demand']),
    memoryBuilder: defaultMemoryBuilder('scout'),
    notes: 'Vision scout'
  });

  // trucker
  defineSpec('trucker', {
    namePrefix: 'trucker',
    bodies: courierBodies,
    selectTier: selectTruckerTier,
    quota: function (room, ctx) {
      if (ctx && typeof ctx.limit === 'number') {
        return ctx.limit;
      }
      return resolveQuotaFromContext('trucker', room, ctx, 0);
    },
    priority: defaultPriorityAccessor(50),
    gates: defaultGatesBuilder(['logistics flag active']),
    memoryBuilder: defaultMemoryBuilder('trucker'),
    notes: 'Long-haul logistics'
  });
  aliasSpecBodies('trucker', 'courier', warnMissingCourierForTrucker);

  // claimer
  const claimerBodies = [
    [CLAIM, CLAIM, MOVE, MOVE],
    [CLAIM, MOVE]
  ];
  defineSpec('claimer', {
    namePrefix: 'Claimer',
    bodies: claimerBodies,
    selectTier: selectDefaultTier,
    quota: function (room, ctx) {
      if (ctx && typeof ctx.limit === 'number') {
        return ctx.limit;
      }
      return resolveQuotaFromContext('claimer', room, ctx, 0);
    },
    priority: defaultPriorityAccessor(60),
    gates: defaultGatesBuilder(['requires claim/reserve order']),
    memoryBuilder: defaultMemoryBuilder('claimer'),
    notes: 'Controller claimer/reserver'
  });

  // dismantler
  defineSpec('dismantler', {
    namePrefix: 'Dismantler',
    bodies: [[WORK, WORK, WORK, WORK, WORK, MOVE, MOVE, MOVE, MOVE, MOVE]],
    selectTier: selectDismantlerTier,
    quota: function (room, ctx) {
      if (ctx && typeof ctx.limit === 'number') {
        return ctx.limit;
      }
      return resolveQuotaFromContext('dismantler', room, ctx, 0);
    },
    priority: defaultPriorityAccessor(70),
    gates: defaultGatesBuilder(['requires dismantle directive']),
    memoryBuilder: defaultMemoryBuilder('dismantler'),
    notes: 'Structure dismantler'
  });

  // Combat roles
  const combatMeleeBodies = [
    [TOUGH, TOUGH, TOUGH, TOUGH, ATTACK, ATTACK, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
    [TOUGH, ATTACK, MOVE, MOVE]
  ];

  const combatArcherBodies = [
    [TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
    [TOUGH, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE]
  ];

  const combatMedicBodies = [
    [MOVE, MOVE, HEAL, HEAL],
    [MOVE, HEAL]
  ];

  defineSpec('CombatMelee', {
    namePrefix: 'CombatMelee',
    bodies: combatMeleeBodies,
    selectTier: selectCombatMeleeTier,
    quota: combatQuota(0),
    priority: defaultPriorityAccessor(20),
    gates: defaultGatesBuilder(['requires combat authorization']),
    memoryBuilder: defaultMemoryBuilder('CombatMelee'),
    notes: 'Squad melee attacker'
  });

  defineSpec('CombatArcher', {
    namePrefix: 'CombatArcher',
    bodies: combatArcherBodies,
    selectTier: selectCombatArcherTier,
    quota: combatQuota(0),
    priority: defaultPriorityAccessor(21),
    gates: defaultGatesBuilder(['requires combat authorization']),
    memoryBuilder: defaultMemoryBuilder('CombatArcher'),
    notes: 'Squad ranged attacker'
  });

  defineSpec('CombatMedic', {
    namePrefix: 'CombatMedic',
    bodies: combatMedicBodies,
    selectTier: selectCombatMedicTier,
    quota: combatQuota(0),
    priority: defaultPriorityAccessor(22),
    gates: defaultGatesBuilder(['requires combat authorization']),
    memoryBuilder: defaultMemoryBuilder('CombatMedic'),
    notes: 'Squad healer'
  });

  // Remote roles (Luna)
  defineSpec('luna.remoteMiner', {
    namePrefix: 'miner',
    bodies: baseharvestBodies,
    selectTier: selectRemoteMinerTier,
    quota: remoteQuotaAccessor('miners'),
    priority: defaultPriorityAccessor(1),
    gates: function (room, ctx, bodyInfo) {
      const gates = remoteMinerGates(room, ctx, bodyInfo);
      gates.push('remote queue available');
      return gates;
    },
    memoryBuilder: remoteMinerMemoryBuilder,
    notes: 'Remote miner'
  });

  defineSpec('luna.remoteHauler', {
    namePrefix: 'hauler',
    bodies: courierBodies,
    selectTier: selectRemoteTier,
    quota: remoteQuotaAccessor('haulers'),
    priority: defaultPriorityAccessor(3),
    gates: remoteGatesBuilder(['remote queue available']),
    memoryBuilder: remoteMemoryBuilder('hauler'),
    notes: 'Remote hauler'
  });

  defineSpec('luna.reserver', {
    namePrefix: 'reserver',
    bodies: claimerBodies,
    selectTier: selectRemoteTier,
    quota: remoteQuotaAccessor('reserver'),
    priority: defaultPriorityAccessor(2),
    gates: remoteGatesBuilder(['remote queue available']),
    memoryBuilder: remoteMemoryBuilder('reserver'),
    notes: 'Remote reserver'
  });
  aliasSpecBodies('luna.reserver', 'claimer');
}

registerSpecs();

function getTaskSpec(name) {
  const taskName = normalizeTaskName(name);
  if (!taskName) {
    return null;
  }
  return TASK_SPECS[taskName] || null;
}

function getBodyFor(taskName, room, ctx) {
  const spec = getTaskSpec(taskName);
  if (!spec) {
    return { parts: [], cost: 0, tier: 0, rationale: 'unknown-task' };
  }
  const context = ctx || {};
  if (typeof spec.selectTier === 'function') {
    const selection = spec.selectTier(spec, room, context);
    if (selection && Array.isArray(selection.parts)) {
      return {
        parts: selection.parts.slice(),
        cost: selection.cost || computeBodyCost(selection.parts),
        tier: selection.tier || 0,
        rationale: selection.rationale || 'custom-selector'
      };
    }
  }
  return selectDefaultTier(spec, room, context);
}

function getQuota(taskName, room, ctx) {
  const spec = getTaskSpec(taskName);
  if (!spec) {
    return 0;
  }
  const context = ctx || {};
  if (typeof spec.quota === 'function') {
    return spec.quota(room, context) | 0;
  }
  return resolveQuotaFromContext(taskName, room, context, 0) | 0;
}

function getPriority(taskName, room, ctx) {
  const spec = getTaskSpec(taskName);
  if (!spec) {
    return 0;
  }
  const context = ctx || {};
  if (typeof spec.priority === 'function') {
    return spec.priority(room, context);
  }
  return 0;
}

function mergeMemory(target, source) {
  if (!source || typeof source !== 'object') {
    return;
  }
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      continue;
    }
    target[key] = source[key];
  }
}

function planSpawn(room, ctx) {
  const context = ctx || {};
  const plans = [];
  const requests = Array.isArray(context.requests) ? context.requests : null;
  if (requests && requests.length) {
    for (let i = 0; i < requests.length; i++) {
      const request = requests[i] || {};
      const taskName = normalizeTaskName(request.taskName || request.task || request.role);
      if (!taskName) {
        continue;
      }
      const spec = getTaskSpec(taskName);
      if (!spec) {
        continue;
      }
      const mergedCtx = Object.create(null);
      mergeMemory(mergedCtx, context);
      mergedCtx.request = request;
      if (request.context && typeof request.context === 'object') {
        mergeMemory(mergedCtx, request.context);
      }
      const bodyInfo = getBodyFor(taskName, room, mergedCtx);
      if (!bodyInfo.parts.length) {
        continue;
      }
      const plan = {
        taskName: taskName,
        role: taskName,
        parts: bodyInfo.parts.slice(),
        cost: bodyInfo.cost,
        tier: bodyInfo.tier,
        rationale: bodyInfo.rationale,
        priority: (request.priority != null) ? request.priority : getPriority(taskName, room, mergedCtx),
        gates: [],
        memory: {}
      };
      if (typeof spec.gates === 'function') {
        plan.gates = ensureArray(spec.gates(room, mergedCtx, bodyInfo));
      }
      if (typeof spec.memoryBuilder === 'function') {
        const memory = spec.memoryBuilder(room, mergedCtx, bodyInfo) || {};
        mergeMemory(plan.memory, memory);
      }
      if (request.memory && typeof request.memory === 'object') {
        mergeMemory(plan.memory, request.memory);
      }
      if (request.additionalMemory && typeof request.additionalMemory === 'object') {
        mergeMemory(plan.memory, request.additionalMemory);
      }
      if (request.remoteRole) {
        plan.remoteRole = request.remoteRole;
      }
      if (request.remoteRoom) {
        plan.remoteRoom = request.remoteRoom;
      }
      if (request.targetRoom) {
        plan.targetRoom = request.targetRoom;
      }
      if (request.sourceId) {
        plan.sourceId = request.sourceId;
      }
      if (request.seatId) {
        plan.seatId = request.seatId;
      }
      plan.namePrefix = (request.namePrefix != null) ? request.namePrefix : (spec.namePrefix || taskName);
      plans.push(plan);
    }
    plans.sort(function (a, b) {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      if (a.tier !== b.tier) {
        return a.tier - b.tier;
      }
      return 0;
    });
    return plans;
  }

  const counts = (context.counts && typeof context.counts === 'object') ? context.counts : Object.create(null);
  const taskNames = Object.keys(TASK_SPECS);
  for (let i = 0; i < taskNames.length; i++) {
    const task = taskNames[i];
    const spec = TASK_SPECS[task];
    if (!spec) {
      continue;
    }
    const quota = getQuota(task, room, context);
    if (quota <= 0) {
      continue;
    }
    const current = counts[task] | 0;
    const deficit = quota - current;
    if (deficit <= 0) {
      continue;
    }
    const bodyInfo = getBodyFor(task, room, context);
    if (!bodyInfo.parts.length) {
      continue;
    }
    for (let n = 0; n < deficit; n++) {
      const plan = {
        taskName: task,
        role: task,
        parts: bodyInfo.parts.slice(),
        cost: bodyInfo.cost,
        tier: bodyInfo.tier,
        rationale: bodyInfo.rationale,
        priority: getPriority(task, room, context),
        gates: [],
        memory: {},
        namePrefix: spec.namePrefix || task
      };
      if (typeof spec.gates === 'function') {
        plan.gates = ensureArray(spec.gates(room, context, bodyInfo));
      }
      if (typeof spec.memoryBuilder === 'function') {
        const memory = spec.memoryBuilder(room, context, bodyInfo) || {};
        mergeMemory(plan.memory, memory);
      }
      plans.push(plan);
    }
  }
  plans.sort(function (a, b) {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    if (a.tier !== b.tier) {
      return a.tier - b.tier;
    }
    return 0;
  });
  return plans;
}

function getTierList(taskName) {
  const normalized = normalizeTaskName(taskName);
  if (!normalized) {
    return [];
  }
  const spec = TASK_SPECS[normalized];
  if (!spec || !Array.isArray(spec.tiers)) {
    return [];
  }
  const list = [];
  for (let i = 0; i < spec.tiers.length; i++) {
    const entry = spec.tiers[i];
    if (!entry || !Array.isArray(entry.parts)) {
      continue;
    }
    const tierIndex = (typeof entry.tier === 'number' && entry.tier > 0) ? entry.tier : (i + 1);
    list.push({
      parts: entry.parts.slice(),
      cost: (typeof entry.cost === 'number') ? entry.cost : computeBodyCost(entry.parts),
      tier: tierIndex,
      label: entry.label || ('T' + tierIndex)
    });
  }
  return list;
}

function generateName(prefix) {
  const base = (typeof prefix === 'string' && prefix.length) ? prefix : 'Worker';
  for (let i = 1; i <= 70; i++) {
    const name = base + '_' + i;
    if (!Game.creeps || !Game.creeps[name]) {
      return name;
    }
  }
  return null;
}

function trySpawn(spawn, plan) {
  if (!spawn || !plan) {
    return ERR_INVALID_ARGS;
  }
  const parts = Array.isArray(plan.parts) ? plan.parts : (Array.isArray(plan.body) ? plan.body : null);
  if (!parts || !parts.length) {
    return ERR_INVALID_ARGS;
  }
  const cost = computeBodyCost(parts);
  const available = availableEnergy(spawn);
  if (cost > available) {
    return ERR_NOT_ENOUGH_ENERGY;
  }
  const prefix = (plan.namePrefix != null) ? plan.namePrefix : (plan.taskName || 'Worker');
  const name = generateName(prefix);
  if (!name) {
    return ERR_NAME_EXISTS;
  }
  const memory = {};
  if (plan.memory && typeof plan.memory === 'object') {
    mergeMemory(memory, plan.memory);
  }
  const taskName = plan.taskName || memory.task || prefix;
  if (!memory.role) {
    memory.role = 'Worker_Bee';
  }
  if (!memory.task) {
    memory.task = taskName;
  }
  if (!memory.bornTask) {
    memory.bornTask = taskName;
  }
  memory.birthBody = cloneParts(parts);
  if (!memory.home && spawn.room && typeof spawn.room.name === 'string') {
    memory.home = spawn.room.name;
  }
  if (plan.remoteRole && !memory.remoteRole) {
    memory.remoteRole = plan.remoteRole;
  }
  if (plan.remoteRoom && !memory.remoteRoom) {
    memory.remoteRoom = plan.remoteRoom;
  }
  if (plan.targetRoom && !memory.targetRoom) {
    memory.targetRoom = plan.targetRoom;
  }
  if (plan.sourceId && !memory.sourceId) {
    memory.sourceId = plan.sourceId;
  }
  if (plan.seatId && !memory.seatId) {
    memory.seatId = plan.seatId;
  }
  const options = { memory: memory };
  return spawn.spawnCreep(parts, name, options);
}

module.exports = {
  TASK_SPECS: TASK_SPECS,
  getBodyFor: getBodyFor,
  getQuota: getQuota,
  getPriority: getPriority,
  planSpawn: planSpawn,
  getTierList: getTierList,
  trySpawn: trySpawn
};
