# BeeHiveMind testing + deploy smoke checks

This repo currently has no `package.json` scripts, so run lightweight manual checks before deploy.

## Local syntax checks

Run these from repo root:

```bash
node --check main.js
node --check core.maintenance.js
node --check BeeSpawnManager.js
node --check BeeToolbox.js
```

## Pre-deploy sanity checklist

1. Confirm spawn queue debug is readable in Memory:
   - `Memory.rooms[roomName].spawnDebug.lastDecision`
   - `Memory.rooms[roomName].spawnDebug.decisionHistory`
2. Confirm source intel policy only persists:
   - owned rooms
   - planner-known remotes (`Memory.__BHM.remotesByHome`)
   - optional manual allow-list (`Memory.sourceIntelApprovedRooms`)
3. Confirm stale room cleanup does **not** delete active remotes.

## Suggested test-server workflow

1. Deploy to Screeps PTR/private server first.
2. Observe for at least 500 ticks.
3. Watch for:
   - unexpected growth in `Memory.rooms`
   - spawn queue items stuck without reason
   - missing source container intel in owned/approved remote rooms
4. Promote to main shard only after memory + spawn behavior is stable.
