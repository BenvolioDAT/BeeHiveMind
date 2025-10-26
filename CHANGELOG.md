## CHANGELOG

- Fix 1: Task.Luna now records spawn cooldown metadata per home and enforces it during spawn planning.
- Fix 2: Luna rotates blocked remote queue entries with bounded cycles and trace logging to avoid spawn thrash.
- Fix 3: Planner.Room.ensureSites and Planner.Road.ensureRemoteRoads accept optional cache hints with trace logging.
- Fix 4: Remote road planning honours configurable storage energy thresholds plus per-room overrides.
- Fix 5: Added Spawn_Squad_Compat wrapper to bridge doc and implementation expectations.
- Fix 6: Luna creep names include remote role and target to reduce collisions.
- Fix 7: Remote assignment lookups tolerate missing Memory.remoteAssignments with optional tracing.
- Fix 8: Builder limits scale with site counts and controller level for conservative ramp-up.
- Fix 9: Queen courier fallback obeys BeeToolbox.ECON_CFG.queen.allowCourierFallback (default true).
- Fix 10: BeeHiveMind forwards Luna spawn cooldown context with safe feature detection.

## CONFIG NOTES

- BeeToolbox.ECON_CFG.remoteRoads.minStorageEnergy defaults to 40000 and supports per-room overrides at Memory.rooms[home].econ.remoteRoads.minStorageEnergy.
- BeeToolbox.ECON_CFG.queen.allowCourierFallback defaults to true to preserve existing behaviour while allowing opt-out.
