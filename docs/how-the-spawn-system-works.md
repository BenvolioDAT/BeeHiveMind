# How the Spawn System Works

## Core idea
The spawn system answers two questions every tick:
1. **What roles does this room want?** (quota/planning)
2. **Which queued role is allowed to spawn now?** (arbitration)

## Main file
- `BeeSpawnManager.js` orchestrates the full process.

## Step-by-step
1. Read room state and debug memory.
2. Compute planner signals (economy, backlog, remote pressure).
3. Build desired quotas by role.
4. Fill the room queue from quota deficits.
5. Run arbitration gates to decide if each queued item can spawn right now.
6. Spawn the first allowed item that meets energy + gate rules.

## Why so many Spawn.* files?
To keep `BeeSpawnManager` readable:
- Quota/backlog helpers in `Spawn.Quotas.js`
- Policy gates in `Spawn.Arbitration.js`
- Feedback smoothing in `Spawn.Feedback.js`
- Recovery history in `Spawn.Stability.js`
- Body guidance in `Spawn.BodyGuidance.js`

## Beginner terms
- **Quota**: how many creeps of a role the room wants.
- **Planned count**: live + queued + spawning, so we do not over-order.
- **Recovery mode**: temporary strict mode that protects survival/economy roles.
- **Arbitration**: the allow/deny decision for queued spawns on this tick.
