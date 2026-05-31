# Remote Mining

BeeHiveMind now treats remote mining as a source plan first, not a room toggle.

## Ownership
- `SourceEnergy.Manager.js` owns active and inactive source records for each home.
- `BeeSpawnManager.js` reads only active remote source records when queueing remote `Veinseeker` creeps.
- `role.Veinseeker.Remote.js` remains source-bound: it validates the assigned source every tick, builds or repairs the source container, harvests, and publishes haul requests.
- `role.Claimer.js` can now reserve active remote rooms selected by the source plan, not only rooms discovered from manual `Reserve` flags or legacy Veinseeker memory.
- `role.Trucker.Dispatcher.js` reads remote haul requests, rejects requests for inactive sources, and scores jobs by expected energy at arrival.
- `role.Trucker.Logic.js` executes the chosen pickup or return job and writes the latest remote run diagnostic.
- `role.Builder.Logic.js` builds remote containers and RoadPlanner roads only when they map back to an active remote source plan.

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

## Reservation
`SourceEnergy.Manager.getRemoteReservationPlan(home)` groups active remote source records by target room and decides whether a `Claimer` should reserve the controller. The plan protects only active, profitable rooms and skips unsafe rooms, rooms owned or reserved by another player, rooms without controllers, and rooms already above the refresh threshold.

Controller intel does not have to be perfect. If a profitable active remote has no fresh controller snapshot, the plan marks it as `reserve-controller-unknown` so a reserver can travel, refresh intel, and reserve if the room is valid.

`BeeSpawnManager.js` converts `plan.needed` into `Claimer` queue items with `task: 'reserveRemote'`, `claimerMode: 'reserve'`, `targetRoom`, protected source ids, reservation thresholds, and a capped CLAIM/MOVE body request.

## Hauling
Local trucker quota is no longer a flat base count. The spawn manager estimates local carry demand from source-container energy, dropped energy, and spawn/extension/tower refill demand, then clamps it between `LOCAL_TRUCKER_MIN` and `LOCAL_TRUCKER_MAX`.

Remote trucker quota combines live haul requests with active-source prediction. Prediction estimates energy that will exist by arrival, per-source pipeline energy, and expected carry demand, then requests remote-mode truckers when remote carry capacity is short.

Queued truckers carry `mode`, `desiredCarryParts`, and road/offroad body context so `spawn.logic.js` can pick local or remote hauler bodies from the actual workload instead of a single static Trucker table.

## Upgrading
`BeeSpawnManager.js` now writes an upgrade budget before queueing Upgraders. The budget targets more WORK parts at RCL2-RCL4 when local containers, drops, storage, or remote income show surplus, but throttles when construction backlog is high and downgrade is not urgent.

The Upgrader body request carries `targetWorkParts`, so the spawn layer can build an affordable WORK/CARRY/MOVE body for the remaining upgrade budget.

## Diagnostics
Useful Memory paths:
- `Memory.rooms[home].lastSourceEnergyPlan.remoteSelection`
- `Memory.rooms[home].lastSourceEnergyPlan.sourceRecords[].economics`
- `Memory.rooms[home].lastRemoteSourceEconomics`
- `Memory.rooms[home].lastRemoteReservationPlan`
- `Memory.rooms[home].lastClaimerQuota`
- `Memory.rooms[home].lastClaimerSpawnDecision`
- `Memory.rooms[home].lastBuilderTargetDecision`
- `Memory.rooms[home].lastUpgraderQuota`
- `Memory.rooms[home].lastUpgraderRefuel`
- `Memory.rooms[home].lastTruckerQuota.remoteSourcePrediction`
- `Memory.rooms[home].lastTruckerQuota.localWorkload`
- `Memory.rooms[home].lastRemoteHaulRequestAudit`
- `Memory.rooms[home].lastTruckerRemoteRun`

## Main Knobs
- `role.Veinseeker.Config.js`: `REMOTE_PROFITABILITY_ENABLED`, `REMOTE_MIN_NET_INCOME`, `REMOTE_MAX_SPAWN_USAGE_PER_HOME`, `REMOTE_MAX_ACTIVE_SOURCES_PER_HOME`, `REMOTE_RESERVATION_ENABLED`, `REMOTE_RESERVATION_TICKS_REFRESH_AT`, `REMOTE_RESERVER_MAX_PER_HOME`, `REMOTE_RESERVER_BODY_MAX_CLAIM_PARTS`, and remote maintenance assumptions.
- `role.Trucker.Config.js`: local haul workload limits, remote haul prediction, expected-arrival multiplier, minimum expected energy, max assignments per request, and debug score logging.
- `role.Upgrader.Config.js`: RCL target WORK budgets, surplus bonus, downgrade safety thresholds, and max Upgrader creeps per RCL.
