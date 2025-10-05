# Combat Design Notes (ES5 Combat Refactor)

These notes describe the threat model, squad micro rules, and fortress playbook introduced in this refactor. Tune knobs here to match your shard tempo.

## Threat Model
- **Tower DPS**: `Combat.ThreatAnalyzer.estimateTowerDps(roomName, pos)` calculates the per-position tower pressure using the official `StructureTower.attack` falloff (600 at range ≤5, linear to 150 at range 20) with a 10% safety buffer. Ramparts and walls on the target tile zero out projected tower damage so we avoid overestimating while hitting fortress doors.
- **Hostile Priorities**: Healers → heavy ranged → melee → dismantlers → remaining creeps → structures. Rampart/wall cover reduces their desirability until we expose them. Static structures fall back to tower > spawn > terminal/storage > labs/links.
- **Caches**: Room intel caches for 25 ticks; without vision we rely on memory for 200 ticks. Hostile re-scans refresh every 5 ticks while we have vision. Memory path: `Memory.combatIntel.rooms[roomName]`.

## Flag Intents
- `Squad.Intents.es5.js` normalizes colors/names into intents: `RALLY`, `ASSAULT`, `BREACH`, `KITE`, `RETREAT`, `HOLD`.
- Place a flag with matching color or prefix (e.g., `BreachAlpha`, color RED/WHITE) to steer squads without spaghetti checks.

## Squad Flee / Hold Rules
- **Hold Band**: Ranged creeps hold if within desired range ±1 and the threat isn’t advancing. Prevents jittery dancing.
- **Flee Thresholds**: Creeps retreat if projected tower DPS exceeds squad heal throughput or if personal HP <40%.
- **Commit Windows**: Assault begins only when `shouldCommitAssault` reports the squad’s total HPS exceeds tower DPS by at least 5%. Otherwise we kite or fall back.
- **Fallback**: Intent `RETREAT` or dropping below tower margin triggers a stepwise fallback to the last rally anchor (flag or spawn room exit).

## Role Micro
- **Archer**: Maintains range 2–3, focus fires highest priority target, uses `rangedMassAttack` only with ≥3 enemies in radius. Holds position if target is stationary and tower pressure acceptable.
- **Medic**: Heal order: (1) self under 45% HP, (2) assigned buddy (melee/dismantler) within 2, (3) nearest hurt ally. Always attempts heal before/after movement so every tick counts.
- **Melee/Vanguard**: Only charges when tower DPS margin positive. Uses cover checks to avoid faceplanting into ramparts. Guards medics/archers by swapping positions if needed.
- **Dismantler**: Commits once tower DPS < squad HPS or rampart cover confirmed. Parks on safe tiles, requests medic tether when margin thin.

## Body Tier Rationale
- **Archers**: Heal-to-ranged ratio ~1:2 at mid tiers keeps kiting sustainable. High tiers add TOUGH padding for first volley resilience.
- **Medics**: HEAL dense (≥1 MOVE per 1.5 HEAL) so they can keep up with squads while offering 60–96 HPS.
- **Melee**: TOUGH parts lead each body to absorb initial tower volleys. HEAL parts act as self-stems between medic pulses.
- **Dismantlers**: MOVE keeps work parts fatigue-neutral while traveling; minimal HEAL ensures they survive chip damage when medics are busy.
- Boost variants can be enabled by adding flagged tiers in `bodyConfigs.combat.es5.js`.

## Fortress Playbook
1. **Scout**: Use a fast scout to gather intel. `Combat.ThreatAnalyzer.getIntel(roomName)` caches tower positions and rampart cover.
2. **Choose Breach Face**: Select rampart wall with minimal tower overlap (`estimateTowerDps` per tile).
3. **Pressure Calculation**: Ensure `shouldCommitAssault(roomName, squadCreeps)` returns true before moving through the breach. Otherwise stay in `RALLY` or `KITE` mode.
4. **Breach**: Dismantler moves under medic cover, melee screens towers. Archers focus healers/towers.
5. **Heal Rotation**: Medics keep vanguard topped; if `projectedTowerPressure` spikes, swap frontliner back for fresh TOUGH padding.
6. **Fallback**: If HPS margin drops (tower DPS ≥ squad HPS) or flag switches to `RETREAT`, pull back along reserved retreat path, re-staging at rally flag or friendly room.

## Config Knobs
- Adjust `SAFE_MARGIN`, `CACHE_TTL`, and tower thresholds in `Combat.ThreatAnalyzer.es5.js`.
- Modify hold range + flee HP in `Task.CombatArcher.js` and `Task.CombatMedic.js` configs.
- Update tier minimum energies or add boost tiers in `bodyConfigs.combat.es5.js`.
- Toggle logging via `core.logger.js` and new debug flags described below.

## Debug & Telemetry
- `global.COMBAT_DEBUG` (boolean) enables detailed logging (set in console).
- `global.COMBAT_VISUALS` renders overlays (set in Task files where noted).
- `Memory.combatIntel.rooms` stores tower DPS and hostile notes for post-fight review.

## How to Use
1. Drop a `Rally` (white/blue) flag near your staging room. Squads gather without aggro.
2. Drop an `Assault` (red/red) or `Breach` (red/white) flag on the target room. The intent map switches squads to the proper behavior.
3. Ensure spawn rooms have the energy for desired tiers; the squad planner will pick the best fit and stagger reinforcements.
4. When ready to disengage, place a `Retreat` (blue/red) flag or remove the assault flag.
5. For fortress sieges, wait until `shouldCommitAssault` says go (logged when debug enabled), then advance dismantler + vanguard as a unit.
