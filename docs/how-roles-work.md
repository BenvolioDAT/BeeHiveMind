# How Roles Work

## Role tick flow
1. BeeHiveMind loops creeps.
2. It picks each creep's role module (`role.X.js`).
3. Role `run(creep)` executes one tick of behavior.

## Orchestrator vs helpers
Some roles are split into helper files:
- `role.Courier.js` calls Courier helper modules.
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
