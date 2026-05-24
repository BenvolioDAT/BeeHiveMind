# BeeHiveMind Module Map (Beginner Version)

## Tick flow at a glance
1. `main.js` starts each game tick.
2. `BeeHiveMind` builds shared context and calls subsystems.
3. `BeeSpawnManager` prepares source plans, fills queues, and asks `spawn.logic.js` to spawn.
4. Role modules run creeps (`role.*.js`).
5. `Movement.Manager.js`, `Traveler.js`, and `BeeActions.js` handle movement requests.

## Major systems
- **Core helpers**: `core.roles.js` owns canonical role names, legacy aliases, and default role tasks; `core.memory.js` owns safe Memory bucket creation.
- **Spawn system**: `BeeSpawnManager.js`, `spawn.logic.js`, `Spawn.BodyConfig.js`, `Spawn.BodyParts.js`
- **Role system**: `role.registry.js` wires public `role.*.js` modules into `BeeHiveMind`; small wrappers such as `role.Builder.js` delegate to behavior files such as `role.Builder.Logic.js`
- **Veinseeker/source system**: `role.Veinseeker.Logic.js` routes to `role.Veinseeker.Home.js` or `role.Veinseeker.Remote.js`; `SourceWorker.Manager.js` owns shared source/container helpers
- **Remote source planning**: `SourceEnergy.Manager.js`
- **Movement system**: `Movement.Manager.js`, `Traveler.js`, `BeeActions.js`
- **Visual/debug helpers**: `BeeVisuals.js`, `BeeVisuals.SpawnPanel.js`, `BeeVisuals.SourceEconomyPanel.js`, and `BeeToolbox` debug drawing helpers

## Logistics roles split
- **Trucker** wrapper: `role.Trucker.js`
- Trucker helpers: `role.Trucker.Config.js`, `role.Trucker.Logic.js`, `Trucker.Dispatcher.js`
- **Queen** role: `role.Queen.js` with config in `role.Queen.Config.js`

## Spawn helper modules
- `spawn.logic.js`: body selection, minimum energy rules, and `spawn.spawnCreep` calls
- `Spawn.BodyConfig.js`: role-to-body-config registry
- `Spawn.BodyParts.js`: shared body part constants
