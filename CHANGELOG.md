# Change Log

## Current Updates

- Enforced global and per-colony squad caps driven by configurable NATO callsigns. Cap handling is enforced during flag planning (`Task.Squad.ensureSquadFlags`) and when producing spawn plans (`BeeHiveMind.buildSquadSpawnPlans`).
- Introduced a persistent squad registry in `Memory.squads` with automatic cleanup, callsign reuse, and BeeDebug helpers for inspection and manual release.
- Updated spawn logic to gracefully defer or drop unaffordable combat plans so worker spawning remains unblocked and economic creeps are not starved.
- Added optional dismantler roles to combat squads when hostile structures dominate the threat profile.
