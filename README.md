# plangraph

Planning as a computation graph. A plan is a directed acyclic graph of work items over a
monthly calendar: items demand seats, seats exist from a hire month and cost money whether
or not they are busy, items depend on other items, finishing an item can unlock a revenue
stream, funding arrives on its own clock. A scenario is a set of overrides on that graph.
The scheduler is a pure, deterministic function from plan and scenario to schedule, and
every start it produces carries the constraint that bound it, so "why is this late" is an
output rather than an argument. When two constraints bind in the same month the label names
one of them, chosen the same way every time.

It comes with a harness. With `plangraph watch <plan>`, every save of the plan file
re-schedules every scenario and
prints the aggregates a planner reads first and the findings a reviewer would raise: seats
over capacity, hires sitting idle, work carried before its seat arrives, slips and their
cause, cash going negative, revenue that rests on assumptions, streams that never unlock,
portfolios too wide, principals carrying unfilled seats. The parser rejects malformed data
with the exact path. A structural error means the graph is not a plan yet, and nothing is
scheduled until it is fixed.

Plans are plain YAML or JSON, so a person or an agent writes one without a build step. YAML
is for people, with comments carrying provenance; JSON is the interchange. The npm package
itself is built to `dist`.

## Quick start

```sh
bun install
bun run check          # schedules examples/studio.yaml and prints the report
bun run watch          # the same, again on every save of the plan file
bun src/cli.ts check my-plan.json --json --scenario leveled
```

Or from an ESM program:

```ts
import { report } from "plangraph";
import { loadPlanFile } from "plangraph/node";
const result = report(loadPlanFile("my-plan.json"));
for (const s of result.scenarios) console.log(s.scenario.name, s.costByYear, s.findings);
```

The package is ESM-only and needs Node 20 or newer. The root export never touches the
filesystem, so a browser bundle can import the engine and `parsePlan`/`parsePlanText`
directly; `plangraph/node` adds `loadPlanFile`, which reads from `node:fs`.

## The model

| Node | What it carries |
|---|---|
| Seat | `loadedAnnual` cost. Optionally `loadedAnnualByYear` (one value per funding year, the last holding), which replaces the flat escalation for sources that escalate salary and then load it. Optionally `loadedAnnualByHire`, for a pooled role whose seats are paid differently: one entry per hire in `hireMonths` order, each a schedule like `loadedAnnualByYear`, or `null` for the role's rate. `hireMonths` (one per seat in the role), `capacityFte`, and a `fallback`: the seat id that carries the role's work while the role has no hire, `"external"` for outside help, or `null` for nobody, in which case the load stays on the empty role. `unlevelled: true` marks a leadership seat: leveling does not wait for room on it, and its overload is reported instead. The exception is an item the seat owns before its first hire, when the seat has `fallback: null`: leveling will not put that item's load on the empty seat, so the item waits until its load there falls after the hire, or goes beyond the horizon if the scenario never hires the seat. With a fallback, the seat's demand goes to the fallback before the hire and is leveled there as usual. |
| Work item | `earliest` month, a finite `duration`, or `standing` (runs to the horizon, and the duration may be omitted), `predecessors` with optional lag, `demands` in FTE per month per seat (a demand may add a `profile`: FTE by quarter of the run, the last value holding, which replaces the flat FTE month by month), an optional explicit `owner`, `underway` when the start is a fact, optional `burnPerMonth`, a `circle`, its priority group, and an optional `priority`, the booking order of planned work inside the circle when leveling (underway items book first): lower first, default 0. |
| Revenue stream | `unlockedBy` an item: the stream turns on when that item finishes, or, for a standing item, when it starts; `price`; recurring annual `volumeByYear` counted from the unlock, the last year holding; `rampMonths`. |
| Funding line | dollars `byMonth`, `counted` by default or overridden by a scenario. |
| Non-labor line | dollars `byYear` on the funding calendar. |
| Scenario | `hireDelay` by seat in whole months (one delay for every hire in the role, or a list with one per hire in `hireMonths` order, missing entries 0; a negative delay pulls a hire forward, to month 0 at the earliest), `dropSeats` (roles that do not exist in the scenario: never hired or costed; their demand goes to their fallback, or, with `fallback: null`, stays on the empty role), `dropHires` (individual hires that do not exist, by position in the role's `hireMonths`, counting from 0; per-hire costs stay with the hires that remain), `dropItems` (items that do not exist in the scenario: they stay in the schedule with `dropped` and `beyond` set and binding `dropped`, but have no run, no bookings and no scenario findings of their own; dependents that are not underway go beyond the horizon, and the streams keyed to them never turn on), `volumeScale`, `countFunding`, `durationScale`, `effortScale`, and `level`: whether movable work respects capacity. |
| Plan | a `name`, the calendar, circles in priority order, `escalation` (an annual rate that compounds `loadedAnnual` from funding year 2, with a basis), optional `scenarios` (the first is the baseline that slips are measured against; a plan with none runs `as-planned` and `leveled`), optional `levelOn` (what leveling waits for: `"all"`, the default, or `"owner"`; see Scheduling), optional `openingCash`, optional reference totals, optional `lint` thresholds. |

Fallback is all-or-nothing per role: while a role has no hire, all of its demand goes to the
fallback; once the first seat is hired, all of it stays on the role. A fallback with no hire
in that month passes the work along its own fallback, until a hired seat, `"external"`, or a
seat with `fallback: null`, where the load stays on that empty role. External work is
uncapped and uncosted, and it is counted: month by month in `Schedule.external`, and as
`externalFteMonths` in every scenario report. Two findings lean on conventions rather than
fields: W116 treats a seat with `fallback: null` as a principal, and W115 treats the last
circle as the one that is separately funded.

Cost, demand, revenue and funding assumptions carry a basis: `D` derived from a source
model, `A` assumed, `M` measured. Calendar values, durations, lags, capacity, ramps, hire
dates and scenario scales do not. Months are integers; there is no partial-month proration.

## Scheduling

The scheduler books underway items first: their starts are facts, so wherever leveling
waits for room, their load is already counted. It then books planned items in priority order
(circle, then `priority`, then declared start, then id), each after its predecessors, which
go in id order. That can pull a predecessor ahead of work that outranks it; an underway item
pulls nothing ahead, since it waits for nothing. The order moves starts only when leveling.
It is a serial heuristic, not an optimizer.

Each planned item starts at the later of its declared month and its predecessors' ends plus
any lag (a standing predecessor releases its successors one month after it starts). When
leveling, it then waits for the first month from which every carrier it needs has room for
the whole run; demand carried externally in a month is never waited for, and unlevelled
seats hold work only as the Seat row says. With `levelOn: owner`, it waits only for room on
the owner's seat (the explicit `owner`, else the first demand's seat), counting any load
that lands there. Load on any other seat, including a fallback that carries the owner's own
demand, is not waited for; an overload there shows in the report's `overloads`, and as W101
past the policy. Work marked `underway` keeps its declared start: it waits for nothing, is
not leveled, and a beyond predecessor does not take it beyond. Demands are resolved to
carriers month by month and added up per carrier before they are compared with capacity, so
two demands that land on the same person count together. A finite item that cannot finish
inside the horizon, underway or not, goes beyond it: it books nothing, unlocks nothing, and
takes its planned dependents with it. Standing work runs from its scheduled start to the
horizon.

When leveling moves a start, its binding says what the item waited for, judged in the first
month the last refused start was short of room, on the seat shortest of room then: `hire`
when nobody was hired yet to carry a demand the item made of it there, on the seat itself or
anywhere along the seat's fallback chain, and otherwise `capacity` (someone was hired and there
was no room, or the item asked nothing of that seat that month). W104 prints a `hire` binding as a wait for that hire, with the month it lands, since
the hire date and not the seat's workload is what moves the item. A pooled role that is full
until its next hire is still `capacity`: someone is there, and there is no room. So is
standing work that a later start fits once it drops the horizon's last month, the only month
that start was short in.

An item beyond the horizon says why in its binding, and W104 repeats it: a predecessor that
never finishes; the horizon, when the run is longer than the months left after its declared
start and its predecessors; or, when leveling pushed it out, the seat that last had no room
for it, or a `hire` when, by the same test, nobody was hired in time to carry its demand from
the last month its run could start (W104 says when the hire lands, or that the scenario never
makes it). An item the scenario drops (`dropItems`) has binding `dropped`, and W104 leaves it
out.

## Funding clock and reports

A funding year is twelve complete months from `calendar.fundingYearStartMonth`. Reports
carry `preFunding`, one entry per complete year in `costByYear`, `revenueByYear` and
`fundingByYear`, and `trailing`, and the three reconcile exactly to the monthly ledger. A
year-end outside the horizon is `null`, never copied from the last month. `openingCash`
(default 0) seeds the cash line.

`report()` returns the full schedule, the monthly ledger, plan findings once, scenario
findings with their scenario, and the summaries. The CLI's `--json` is a smaller projection
of the same. `check` exits 2 on a usage error (a command other than `check` or `watch`, no
plan path right after the command, or `--scenario` without an id) or when `--scenario` names
no scenario; 1 when the plan does not load or parse, has errors, or cannot be computed (a
non-finite or out-of-range result); and 0 otherwise. Arguments after the plan path other
than `--json` and `--scenario id` are ignored. `--scenario id` reports one scenario, with
its slips still measured against the baseline, the first scenario (`as-planned` for a plan
with none); `report(plan, id)` does the same.

## Findings

| Code | Meaning |
|---|---|
| E001 | Duplicate item, seat, stream, funding line, non-labor line or scenario id, or circle name. |
| E002 | Unknown or self dependency, negative lag, or a dependency cycle, named. |
| E003 | A stream unlocked by an unknown item, or with no volumes. |
| E004 | An item with no demands, an unknown or duplicate seat, a non-positive FTE, or an owner outside its demands. |
| E005 | An item with no duration, or a start outside the horizon. |
| E006 | A seat with no hires, non-positive capacity, an unknown or looping fallback, or the reserved id `external`. |
| E007 | An item in a circle the plan does not list. |
| W101 | A seat over capacity for the policy's months, or by the policy's FTE in any month. |
| W102 | A hire after month 0 whose role stays under the policy's share of its capacity for the policy's months in a row from its hire month; the peak share over that stretch is stated. |
| W103 | An item that starts the policy's months or more before a seat it demands is first hired, or that demands a seat the scenario never hires: which hired seat carries that demand at the start, or that nobody does. Demand carried externally at the start is not flagged. |
| W104 | An item starting late against its declared month, or never fitting, with the binding cause. |
| W105 | Cash going negative: first month and trough. |
| W106 | More than the policy's share of complete-year revenue resting on assumed volumes. |
| W107 | A finite first-circle item ending after funding year 1. |
| W108 | A stream that never unlocks inside the horizon. |
| W109 | An owner (explicit, else the first demand) running too many items at once. |
| W110–W112 | Headcount, gross cost and non-labor share drifting from the reference model, over complete years. |
| W115 | FTE-months booked to the last circle on seats that are hired in that month, beyond the policy, in plans with more than one circle; external carriage and load on empty roles are not counted. |
| W116 | A `fallback: null` seat carrying more than the policy's multiple of one seat's capacity in any month, from the plan's start through funding year 1, in which it is hired and carries other seats' work; the fallback share is stated. |

E codes are errors: while one stands, `report()` schedules nothing and `check` fails.
`schedule()` called directly does not run these checks, though it throws on a dependency
cycle or an unknown predecessor. W106, W107, W110–W112 and W115 are info; the other W codes
are warnings. Thresholds come from `lintPolicy(plan)`; a plan sets its own under `lint`:
`overloadMonths` (default 3) and `overloadPeakFte` (0.5) for W101, `idleMonths` (3) and
`idleLoadShare` (0.1) for W102, `lateOwnerMonths` (6) for W103, `slipMonths` (3) for W104,
`assumedRevenueShare` (0.8) for W106, `wideOwnerItems` (4) for W109,
`referenceCostTolerance` (0.15) for W111, `lastCircleFteMonths` (12) for W115, and
`principalLoad` (1.5) for W116. There are no W113 or W114.

A sum of FTE or dollars can differ in its last bit with the order it was added up, so the
thresholds on sums and on shares of them (W101's peak, W102's share, W106's share, W111's
ratio, W112's share, W115 and W116) allow 1e-9 of slack, as the scheduler does: a value
exactly at a threshold counts as at it, whatever the order. W105 counts cash within half a
cent of zero as zero, since a running sum of dollars can drift by more than 1e-9.

## Compared with TaskJuggler

[TaskJuggler](https://taskjuggler.org/) has done dependencies, resource leveling, accounts
and scenarios in a text DSL [for twenty years](https://taskjuggler.org/manual-git/change_log.html),
and it is the closest thing to this. Its scenarios
[inherit and override](https://taskjuggler.org/tj3/manual/scenario.html) too, and it charges
accounts [at task start, end or by period](https://taskjuggler.org/tj3/manual/charge.html),
so neither is where plangraph differs. What is: a compact YAML or JSON graph that agents and
people write and check, a deterministic binding on every start, and revenue as recurring
annual volumes with a ramp, keyed to the item that unlocks it. plangraph does less: no
working calendars or shifts, no effort-driven durations, no shared resource pools across
plans, no report-definition engine. `report()` and the CLI are fixed, and there is no
renderer.

## Not yet

Critical path and float. Deadlines and latest starts. Working calendars and part-time
shifts. Effort-driven durations (today duration is fixed and demand is per month). Resource
pools shared across plans. Priced external work. Cost of capital. A drag interface.

## License

Apache-2.0. Built at [The Axiom Foundation](https://axiom.org).
