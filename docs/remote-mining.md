# Remote Mining

BeeHiveMind now treats remote mining as a source plan first, not a room toggle.

## Ownership
- `SourceEnergy.Manager.js` owns active and inactive source records for each home.
- `BeeSpawnManager.js` reads only active remote source records when queueing remote `Veinseeker` creeps.
- `role.Veinseeker.Remote.js` remains source-bound: it validates the assigned source every tick, builds or repairs the source container, harvests, and publishes haul requests.
- `role.Trucker.Dispatcher.js` reads remote haul requests, rejects requests for inactive sources, and scores jobs by expected energy at arrival.
- `role.Trucker.Logic.js` executes the chosen pickup or return job and writes the latest remote run diagnostic.

## Economics
Each remote source gets an `economics` object in `Memory.rooms[home].lastSourceEnergyPlan.sourceRecords` and `Memory.rooms[home].lastRemoteSourceEconomics`.

The estimate includes:
- source energy per tick, with unreserved remotes discounted by `REMOTE_UNRESERVED_ENERGY_MULTIPLIER`
- miner body cost and spawn usage
- hauler body pressure based on route length and expected round trip
- optional reservation cost when `REMOTE_ASSUME_RESERVED` is enabled or the room is already reserved by us
- container and road maintenance loss
- net income and spawn usage

Active selection sorts profitable sources by value, then net income, then path cost. Sources can be inactive because of safety, stale intel, low income, active-source caps, or remote spawn budget.

## Diagnostics
Useful Memory paths:
- `Memory.rooms[home].lastSourceEnergyPlan.remoteSelection`
- `Memory.rooms[home].lastSourceEnergyPlan.sourceRecords[].economics`
- `Memory.rooms[home].lastRemoteSourceEconomics`
- `Memory.rooms[home].lastTruckerQuota.remoteSourcePrediction`
- `Memory.rooms[home].lastRemoteHaulRequestAudit`
- `Memory.rooms[home].lastTruckerRemoteRun`

## Main Knobs
- `role.Veinseeker.Config.js`: `REMOTE_PROFITABILITY_ENABLED`, `REMOTE_MIN_NET_INCOME`, `REMOTE_MAX_SPAWN_USAGE_PER_HOME`, `REMOTE_MAX_ACTIVE_SOURCES_PER_HOME`, reservation and maintenance assumptions.
- `role.Trucker.Config.js`: remote haul prediction, expected-arrival multiplier, minimum expected energy, max assignments per request, and debug score logging.
