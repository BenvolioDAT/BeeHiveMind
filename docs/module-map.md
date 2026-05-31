# BeeHiveMind Module Map (Beginner Version)

## Tick flow at a glance
1. `main.js` starts each game tick.
2. `BeeHiveMind` builds shared context and calls subsystems.
3. `BeeSpawnManager` prepares source plans, fills queues, and asks `spawn.logic.js` to spawn.
4. Role modules run creeps (`role.*.js`).
5. `Movement.Manager.js`, `Movement.Actions.js`, and `Traveler.js` handle movement requests.

## Major systems
- **Core helpers**: `core.roles.js` owns canonical role names, legacy aliases, and default role tasks; `core.memory.js` owns safe Memory bucket creation; `core.selectors.js`, `core.body.js`, `core.maintenance.js`, logger/config/profiler files provide shared support.
- **Spawn system**: `BeeSpawnManager.js`, `spawn.logic.js`, `Spawn.BodyConfig.js`, `Spawn.BodyParts.js`
- **Role system**: `role.registry.js` wires public `role.*.js` modules into `BeeHiveMind`; small wrappers such as `role.Builder.js` delegate to behavior files such as `role.Builder.Logic.js`
- **Veinseeker/source system**: `role.Veinseeker.Logic.js` routes to `role.Veinseeker.Home.js` or `role.Veinseeker.Remote.js`; `SourceWorker.Manager.js` owns shared source/container helpers; `Source.Economy.js` tracks local source pickup economics.
- **Remote source planning**: `SourceEnergy.Manager.js` owns source-level remote activation, profitability diagnostics, source reservations, and active/inactive remote source records.
- **Remote reservation**: `SourceEnergy.Manager.js` writes reservation plans; `BeeSpawnManager.js` turns needed reservations into `Claimer` queue items; `role.Claimer.js` travels, reserves, signs, and rotates when the controller is healthy.
- **Combat system**: `Combat.Squads.js` and `Combat.Staging.js`
- **Structure system**: `Structure.Logic.js`
- **Movement system**: `Movement.Manager.js`, `Movement.Actions.js`, `Traveler.js`
- **Visual/debug helpers**: `BeeVisuals.js`, `BeeVisuals.SpawnPanel.js`, `BeeVisuals.SourceEconomyPanel.js`, and `BeeToolbox` debug drawing helpers

## Logistics roles split
- **Trucker** wrapper: `role.Trucker.js`
- Trucker helpers: `role.Trucker.Config.js`, `role.Trucker.Logic.js`, `role.Trucker.Dispatcher.js`
- Remote hauling reads active remote source records plus Veinseeker-published haul requests; diagnostics live in `lastTruckerQuota`, `lastRemoteHaulRequestAudit`, and `lastTruckerRemoteRun`.
- Local hauling uses workload-based Trucker quotas; remote hauling uses active-source prediction plus live haul requests. Spawn items include body context so `spawn.logic.js` can choose local, roaded remote, or offroad remote hauler bodies.
- **Queen** role: `role.Queen.js` with config in `role.Queen.Config.js`

## Spawn helper modules
- `spawn.logic.js`: body selection, minimum energy rules, and `spawn.spawnCreep` calls
- `Spawn.BodyConfig.js`: role-to-body-config registry
- `Spawn.BodyParts.js`: shared body part constants
