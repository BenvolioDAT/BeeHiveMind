# How Roles Work

## Role tick flow
1. BeeHiveMind loops creeps.
2. It picks each creep's role module (`role.X.js`).
3. Role `run(creep)` executes one tick of behavior.

## Orchestrator vs helpers
Some roles are split into helper files:
- `role.Trucker.js` calls Trucker helper modules and owns hauling (local + remote).
- `role.Queen.js` calls Queen helper modules.

This keeps the top-level role file easy to read:
- prepare identity/state
- pick task/state
- run action phase

## Movement
- Roles should request movement through movement helpers.
- `Movement.Manager.js` resolves movement intents and conflicts.
- `Movement.Intent.js` stores per-tick move intent metadata.
- `Movement.Border.js` handles border stabilization rules.

## Debug visuals
`BeeRoleVisuals.js` provides shared role drawing/say helpers so role files stay cleaner.

## Harabi-Style Role Rules

Every creep role now enters through `role.HarabiCreep.wrapRole()` or `wrapModule()`.
That shared entrypoint keeps the rules consistent across workers, remotes, claimers,
and combat creeps:

- Normalize `creep.memory.role`, default `creep.memory.task`, and `creep.memory.home`.
- Skip role execution while spawning unless the role explicitly opts in.
- Prefer shared helpers for movement, idling, and combat scoring instead of raw
  one-off target selection.
- Store visible state in `creep.memory.state` so visuals, diagnostics, and spawn
  logic can reason about creeps uniformly.
- Set a creep idle with `HarabiCreep.setIdler(creep)` when a manager has no work
  for it, matching the Harabi manager pattern.

Combat roles use the same shared module for threat filtering and combat memory.
Archers now keep range 3, flee if too close, and prefer hostile creeps with real
combat parts; melee and medic roles use the same target/movement rule set.
