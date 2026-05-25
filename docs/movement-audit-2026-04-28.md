# Role-wide movement hardening audit (2026-04-28)

## Scope reviewed
- Shared movement layers: `Traveler`, `BeeToolbox.BeeTravel`, `MovementManager`, `MovementActions`.
- Role movement callsites: Builder, Scout, Luna, Repair, Claimer, Courier, Queen, Upgrader, Trucker, BaseHarvest, Dismantler, CombatMelee/Archer/Medic.
- `role.BeeWorker.js`: not present in this repo.

## Audit table

| Role/file | Movement method used | Uses shared Traveler protection? | Direct move/moveTo risk? | Exit-tile target risk? | Early-return-on-border risk? | Recommended action | Code changed? |
|---|---|---|---|---|---|---|---|
| `role.Builder.js` | `issueBuilderMove -> creep.travelTo`, local `creep.move` border nudge | Yes (travelTo) + local nudge | Partial (`creep.move` intentional) | **Was yes** (nearest exit, `range:0`) | Low | Target room interior center instead of explicit exit tile | **Yes** |
| `role.Scout.js` | `issueScoutMove -> creep.travelTo`, local border `creep.move` | Yes + local nudge | Partial (`creep.move` intentional) | No | Low | Keep as-is; already guarded | No |
| `role.Luna.js` | `issueLunaMove -> creep.travelTo`, local border `creep.move` | Yes + local nudge | Partial (`creep.move` intentional) | No | Low | Keep as-is; already guarded | No |
| `role.Repair.js` | `go -> BeeTravel/travelTo`, fallback `moveTo` | Partial (fallback path) | Yes (`moveTo` fallback) | No | Medium (if branch idles on border) | Keep fallback but clear `_move` in shared BeeTravel fallback to avoid cache mixing | **Shared fix** |
| `role.Claimer.js` | direct `creep.travelTo` | Yes | No direct `moveTo`; no local nudge | No | Medium | Keep travelTo; prior duplicate-move fix retained | No (this pass) |
| `role.Courier.js` | direct `creep.travelTo` | Yes | No | No | Medium | Rely on Traveler + shared BeeTravel hardening; optional future border helper at role entry | No |
| `role.Queen.js` | `MovementActions` + `MovementManager.request` | Yes (MovementManager resolves via travelTo) | No | No | Low | Keep centralized ownership | No |
| `role.Upgrader.js` | direct `creep.travelTo` | Yes | No | No | Medium-low | No change | No |
| `role.Trucker.js` | direct `creep.travelTo` | Yes | No | No | Medium | No change; Traveler should handle room crossings | No |
| `role.BaseHarvest.js` | direct `creep.travelTo` | Yes | No | No explicit exit target | Medium-low | No change; local role mostly intra-room | No |
| `role.Dismantler.js` | `moveSmart -> BeeTravel`, fallback `moveTo` | Partial (fallback path) | Yes (`moveTo` fallback) | No | Medium | Shared BeeTravel fallback cleanup for `_move` mixing | **Shared fix** |
| `role.CombatMelee.js` | `MovementManager.request` else direct `travelTo` | Yes | No | No | Low | Keep; request path preferred | No |
| `role.CombatArcher.js` | `MovementManager.request` else direct `travelTo` | Yes | No | No | Low | Keep; request path preferred | No |
| `role.CombatMedic.js` | `MovementManager.request` else direct `travelTo` | Yes | No | No | Low | Keep; request path preferred | No |

## Shared-layer findings

1. **Traveler remains the core protection path** for most movement calls (`travelTo` and MovementManager resolve).
2. **BeeToolbox.BeeTravel fallback used `moveTo`**, which can introduce `_move` cache alongside `_trav`.
3. Several roles call `creep.travelTo` directly (no BeeToolbox wrapper), but still route through Traveler.
4. Local border nudges already exist in Builder/Scout/Luna and should remain role-specific.

## Hardening changes applied (small, low-risk)

1. **Shared BeeToolbox border nudge helper added**: `BeeToolbox.nudgeOffExitIfNeeded(creep, destination, options)`.
   - Applies only when creep is on border **and destination is in same room**.
   - Skips when `options.flee` is set.
   - Attempts a single inward `creep.move(...)`; if blocked, falls back to Traveler pathing.
2. **BeeToolbox.BeeTravel now calls the shared border nudge helper before Traveler**.
3. **BeeToolbox.BeeTravel fallback `moveTo` now clears `creep.memory._move`** after the fallback call to reduce `_move` / `_trav` mixing persistence.
4. **Builder cross-room helper no longer explicitly targets exit tile (`range:0`)**.
   - Now targets target-room center `(25,25,targetRoom)` with `range:20`, letting Traveler handle crossing.

## Roles fully protected by shared movement (current)
- Any role whose normal movement is `creep.travelTo(...)` or `MovementManager.request(...)` resolves through Traveler protections.
- Practical list: Scout, Luna, Claimer, Courier, Queen, Upgrader, Trucker, BaseHarvest, combat roles.

## Roles patched in this pass
- `BeeToolbox.js` (shared hardening helper + fallback cache cleanup).
- `role.Builder.js` (remove explicit exit-tile target behavior in cross-room travel helper).

## Roles still partially risky and why
- Roles with explicit `moveTo` fallbacks (Repair, Dismantler, BeeTravel catch path) are still partial-risk if Traveler is unavailable/throws; mitigation now clears `_move` in shared wrapper fallback.
- Roles without local border nudge may still have edge cases where non-movement branches early-return while on border, but Traveler-level protections remain primary defense.

## Files changed
- `BeeToolbox.js`
- `role.Builder.js`

## Remaining risks
1. Any future role that calls raw `creep.moveTo` directly can reintroduce `_move` cache mixing.
2. Intentional flee/retreat flows are intentionally not overridden by inward nudge.
3. Non-BeeTravel direct `creep.travelTo` calls rely entirely on Traveler safeguards (which is acceptable by current design).
