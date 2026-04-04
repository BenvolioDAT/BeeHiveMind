# Luna Room-Entry Repath Investigation (Fresh First-Principles Trace)

## A. Executive Summary

- Luna **does repath on room entry**, and in this codebase that is expected in two distinct ways: (1) Traveler path cache invalidation, and (2) Luna state transition from `TRAVEL` (room-center target) to `HARVEST` (source target). The current implementation also forces broader-than-intended repathing.  
- Luna is **not forgetting assignment intent at room entry** in the normal case: `creep.memory.targetRoom` and `creep.memory.sourceId` remain set unless a release path is triggered.  
- On first border tile in target room, Luna runs a dedicated border stabilizer (`stabilizeLunaBorder`) that issues a raw inward `creep.move(...)` and returns early; this intentionally interrupts Traveler for one tick.  
- After that inward step, Luna calls `harvestSource`, resolves `sourceId` with `Game.getObjectById`, and moves toward the source if out of range. If source lookup fails, it releases assignment (different failure mode from repath).  
- Traveler’s `_trav.path` is explicitly cleared when `state.lastCoord` differs from current position while destination is unchanged (line-level behavior currently makes this occur after normal movement too), so path reuse is heavily suppressed.  
- Because path reuse is frequently dropped, pathfinding is repeatedly recomputed from the current tile; this can legitimately choose a first step that exits a room if costs/route constraints make that global route cheaper.  
- For Luna specifically, there is an additional destination switch at entry boundary: before entry target is `RoomPosition(25,25,targetRoom)` with wide `range:20`, after entry target becomes exact source (`range:1`). Destination switch itself guarantees repath.  
- No evidence in this trace that `Movement.Manager` overwrites Luna movement: Luna does not queue through `MovementManager.request`; it calls `creep.travelTo` directly via `issueLunaMove`.  
- Most likely root mechanism for “leave then re-enter” is **recalculation + new global cost evaluation**, not “source memory loss.”

## B. Tick-Level Entry Analysis

### Tick T-1 (before crossing border)

1. `BeeHiveMind.run()` calls role runner for Luna.  
2. `prepareLuna()` runs movement/room breadcrumbs (`_lx/_ly/_lr`, `_lastRoom`, `_roomEntryTick` as needed).  
3. `determineLunaState()` returns `TRAVEL` because `creep.pos.roomName !== targetRoom`.  
4. `travelToAssignedRoom()` sets destination to room center `(25,25,targetRoom)` and calls `issueLunaMove(... creep.travelTo ...)` with `range:20`.  
5. Traveler runs with destination = room center; may use cached path or compute one.

### Tick T0 (room-entry tick: creep appears on border tile in target room)

1. `prepareLuna()` detects room transition and stamps `creep.memory._roomEntryTick = Game.time`.  
2. `ensureActiveAssignment()` does nothing destructive if assignment still exists.  
3. `stabilizeLunaBorder()` fires because creep is in `targetRoom` and on edge (`x|y == 0|49`).  
4. Stabilizer sets `_lunaMoveTick` and issues a direct one-step inward `creep.move(...)`, then returns early.  
5. No source-target `travelTo` call happens this tick (by design).

### Tick T+1 (first fully inside tile)

1. `determineLunaState()` now resolves to `HARVEST` (same room as `targetRoom`).  
2. `harvestSource()` runs; if source ID resolves, destination shifts to source (`range:1`) and `issueLunaMove(...src...)` calls Traveler.  
3. Traveler clears/refreshes cached path when destination changed and (in current code) also clears on `lastCoord` mismatch with same destination, causing frequent full repaths.  
4. First step of this newly computed path may be in any legal direction, including toward border, if global path cost says so.

### Tick T+2 (if it exits again)

1. If moved back to border/outside, `determineLunaState()` may flip back to `TRAVEL` (room-center objective).  
2. Destination switches again from source to room-center objective, causing another path reset/recompute cycle.  
3. This oscillation can look like “forgetting,” but observed state machine behavior shows target-mode changes + path invalidations.

## C. Path/Memory State Table

| Field | Stored in | Before entry | Entry tick (on border in target room) | After repath (inside) |
|---|---|---|---|---|
| `targetRoom` | `creep.memory.targetRoom` | set to assigned remote | unchanged | unchanged unless release path triggers |
| `sourceId` | `creep.memory.sourceId` | set to assigned source | unchanged | unchanged; used by `Game.getObjectById` |
| Role state | `creep.memory.state` | `TRAVEL` | evaluated before/after border stabilizer path, effectively travel halted by stabilizer | `HARVEST` once inside non-border |
| Last room | `creep.memory._lastRoom` | previous room | updated to target room | target room |
| Room entry tick | `creep.memory._roomEntryTick` | old/absent | set on room change | retained for debounce windows |
| Border stabilization move gate | `creep.memory._lunaMoveTick` | usually clear | set by `stabilizeLunaBorder` after raw `creep.move` | reset next tick in `prepareLuna` |
| Traveler cache | `creep.memory._trav.path` | route toward room-center target may exist | untouched this tick if stabilizer early-returns | often reset + recomputed for source destination |
| Traveler state | `creep.memory._trav.state` | stores last coord + prior destination | still previous serialization | updated with current coord + source destination |
| Stuck breadcrumb | `creep.memory._stuck` + `_lx/_ly/_lr` | tracks movement continuity | updated with entry position | updated normally |
| Release metadata | `_release*` fields | absent unless prior release | unchanged unless release trigger fires | unchanged unless source invalid/hostile/lock/exclusive paths trigger |

## D. Exact Call Chain

### Core tick/order chain
1. `main.loop` (via `BeeHiveMind.run`) initializes movement tick and runs roles.  
2. `BeeHiveMind.runCreeps` dispatches Luna role handler.  
3. `role.Luna.run` executes `prepareLuna → updateReturnState → determineLunaState → assignment checks → border stabilization → travel/harvest`.  
4. Luna movement is issued via `issueLunaMove`, which directly calls `creep.travelTo` (Traveler).

### Room-entry and repath chain
- Entry detection: `trackRoomEntryBreadcrumb` sets `_roomEntryTick` when `_lastRoom !== currentRoom`.  
- Border handling: `stabilizeLunaBorder` checks `pos.roomName === targetRoom && isOnBorder(pos)` then issues raw inward `creep.move`.  
- Mode switch: `determineLunaState` switches from `TRAVEL` to `HARVEST` once in target room.  
- Destination switch: `travelToAssignedRoom` targets room center, `harvestSource` targets source object.  
- Traveler cache behavior: `Traveler.travelTo` deserializes `_trav.state`, conditionally deletes `_trav.path` under mismatch/destination-change checks, then pathfinds and serializes state.

## E. Repath Triggers Ranked

1. **Destination change at room entry (`room center` → `source`)** — **expected behavior**.  
   - Triggered by Luna state machine transition from `TRAVEL` to `HARVEST` and different target objects/ranges.

2. **Traveler path invalidation on destination mismatch** — **expected behavior**.  
   - `if (!samePos(state.destination, destination)) delete travelData.path;`.

3. **Traveler invalidation on `lastCoord` mismatch with same destination** — **suspicious/likely over-triggering**.  
   - Current logic clears path whenever current coord differs from `state.lastCoord`; after successful movement this is normally true, so cache reuse is frequently defeated.

4. **Intentional border stabilization raw move** — **expected behavior with side effects**.  
   - One-tick forced inward move interrupts Traveler continuity and can force fresh calculations next tick.

5. **Release flows (hostile/lock/exclusive/source invalid)** — **conditional bug vectors, not required for this repro**.  
   - These can clear `sourceId/targetRoom`, but not required to explain entry repath in normal path.

## F. Why It Might Exit the Room Again

### Confirmed mechanisms
- Fresh pathfinding from a border-adjacent tile can choose any legal first step based on full cost search; no rule in Traveler or Luna forbids first step toward exit when global path cost says so.  
- Luna’s destination can switch across ticks (`center` vs `source`) and Traveler path cache is frequently reset, so first-step direction is recomputed often instead of following a stable serialized tail.

### Hypotheses requiring instrumentation (not yet proven from static code)
- Room interior cost conditions (structures/ramparts/construction/creep blocking) may make temporary outside route cheaper.  
- Route constraints (`allowedRooms`/`findRoute` when crossing rooms) might bias a re-entry via another edge depending on discovered costs and avoid flags.  
- A stale or incomplete source-intel scenario might transiently push room-center travel fallback before source lookup stabilizes (less likely here because source lookup is direct by `sourceId` once in-room).

## G. Confirmed Findings

1. Luna preserves `sourceId` and `targetRoom` across normal room entry; they are only cleared in `releaseAssignment`.  
2. Luna has explicit room-entry border handling that consumes the movement for that tick with raw `creep.move` inward.  
3. Luna does not use `MovementManager` for its own movement calls; it uses direct `creep.travelTo`.  
4. Traveler stores path/state in `creep.memory._trav` (`path` string + serialized state array).  
5. Traveler deliberately deletes cached path on destination change.  
6. Traveler currently also deletes cached path on coordinate mismatch for same destination, which can force recalculation much more often than intended.  
7. Frequent recalculation + border adjacency is sufficient to explain observed “repath out then re-enter” without requiring source-memory loss.

## H. Minimal Observability Patch Plan

If runtime proof is needed, add **tiny, temporary logs only** (no architectural rewrite):

1. **In `role.Luna.issueLunaMove`** (guarded by `creep.name === 'Luna'` and optional debug flag): log tick, pos, dest pos, state, `targetRoom`, `sourceId`, and whether `_lunaMoveTick` already set.  
2. **In `stabilizeLunaBorder`**: log when stabilizer consumes movement (`from`, `to direction`, `_roomEntryTick`).  
3. **In `Traveler.travelTo` before/after invalidation checks**: log `_trav.path` length, reason for deletion (`destChanged`, `coordMismatchFar`, `coordMismatchSameDest`), and first new direction chosen.  
4. **In `harvestSource`**: log source resolution success/failure and resolved source pos.

These four probes are enough to prove whether reversal is from destination switch, path invalidation trigger, or route cost decision.

## I. Recommended Fix Direction

Given static evidence, safest first code fix (after instrumentation confirms frequency):

1. **Narrow Traveler same-destination invalidation** so it only clears path when creep diverged unexpectedly (e.g., not same room and not adjacent to expected progression, or teleported), not after every normal move.  
2. Keep destination-change invalidation intact (needed).  
3. Keep Luna border stabilizer intact (it prevents immediate ping-pong at literal border tile).  
4. Optional safety: when just entered target room and switching to source destination, add one-tick “no-exit-first-step” guard only if instrumentation proves persistent regressions.

This is smallest safe fix path: stabilize cache behavior first, then only add directional guard if still needed.

---

## Bring this back to ChatGPT

- **Single most likely explanation:** Luna is not forgetting `sourceId`; it is repeatedly recalculating path at/after room entry due to destination switch plus aggressive Traveler path invalidation, and the fresh solver can choose a border-exit first step when that route is evaluated cheaper.  
- **Inspect first:** `Traveler.travelTo` invalidation logic around `travelData.path` deletion checks (same-destination coord mismatch block).  
- **Next step:** instrumentation first (tiny logs), then targeted Traveler invalidation fix.
