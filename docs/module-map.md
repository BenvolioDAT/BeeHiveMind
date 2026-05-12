# BeeHiveMind Module Map (Beginner Version)

## Tick flow at a glance
1. `main.js` starts each game tick.
2. `BeeHiveMind` builds shared context and calls subsystems.
3. `BeeSpawnManager` plans queue + spawning.
4. Role modules run creeps (`role.*.js`).
5. Movement helpers (`Movement.*`) resolve movement intents.

## Major systems
- **Spawn system**: `BeeSpawnManager.js` + `Spawn.*.js`
- **Role system**: `role.*.js`
- **Movement system**: `Movement.Manager.js`, `Movement.Intent.js`, `Movement.Border.js`
- **Visual/debug helpers**: `BeeRoleVisuals.js`

## Logistics roles split
- **Courier** orchestrator: `role.Courier.js`
- Courier helpers: `Courier.Config/Memory/Cache/Reservations/Targets/Actions.js`
- **Queen** orchestrator: `role.Queen.js`
- Queen helpers: `Queen.Config/Memory/Reservations/TerminalJob/Tasks/Actions.js`

## Spawn helper modules
- `Spawn.Roles.js`: role name normalization + bands/priorities
- `Spawn.Counts.js`: room/home aware counting
- `Spawn.Economy.js`: maturity/economy-state classification
- `Spawn.BodyGuidance.js`: body-size guidance logic
- `Spawn.Feedback.js`: EMA feedback and action sampling
- `Spawn.Stability.js`: recovery/starvation history state
- `Spawn.Arbitration.js`: queue gating and allow/deny decisions
- `Spawn.Quotas.js`: backlog helpers and quota-oriented helpers
