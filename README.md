# plangraph

Planning as a computation graph. A plan is a directed acyclic graph of work items over a
monthly calendar: items demand seats, seats exist from a hire month and cost money whether
or not they are busy, items depend on other items, finishing an item can unlock a revenue
stream, funding arrives on its own clock. A scenario is a set of overrides on that graph.
The scheduler is a pure, deterministic function from plan and scenario to schedule, and
every start it produces carries the constraint that bound it, so "why is this late" is an
output rather than an argument. When two constraints bind in the same month the label names
one of them, chosen the same way every time.

It comes with a harness. With `bun run watch`, every save re-schedules every scenario and
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
bun run watch          # the same, on every save
bun src/cli.ts check my-plan.json --json --scenario leveled
```

Or from an ESM program:

```ts
import { loadPlanFile, report } from "plangraph";
const result = report(loadPlanFile("my-plan.json"));
for (const s of result.scenarios) console.log(s.scenario.name, s.costByYear, s.findings);
```

The package is ESM-only and needs Node 20 or newer. The root export includes
`loadPlanFile`, which reads from `node:fs`, so it is a Node entry point, not a browser one.

## The model

| Node | What it carries |
|---|---|
| Seat | `loadedAnnual` cost, `hireMonths` (one per seat in the role), `capacityFte`, and a `fallback`: the seat id that carries the role's work while the role has no hire, `"external"` for outside help, or `null` for nobody, in which case the load stays on the empty role. |
| Work item | `earliest` month, a finite `duration` or `standing` (runs to the horizon), `predecessors` with optional lag, `demands` in FTE per month per seat, an optional explicit `owner`, `underway` when the start is a fact, optional `burnPerMonth`, and a `circle`, its priority group. |
| Revenue stream | `unlockedBy` an item, `price`, recurring annual `volumeByYear` after unlock, `rampMonths`. |
| Funding line | dollars `byMonth`, `counted` by default or overridden by a scenario. |
| Non-labor line | dollars `byYear` on the funding calendar. |
| Scenario | `hireDelay` by seat, `volumeScale`, `countFunding`, `durationScale`, `effortScale`, and `level`: whether movable work respects capacity. |
| Plan | the calendar, circles in priority order, optional `openingCash`, optional reference totals, optional `lint` thresholds. |

Fallback is all-or-nothing per role: while a role has no hire, all of its demand goes to the
fallback; once the first seat is hired, all of it stays on the role. External work is
uncapped and uncosted, and it is counted: month by month in `Schedule.external`, and as
`externalFteMonths` in every scenario report. Two findings lean on conventions rather than
fields: W116 treats a seat with `fallback: null` as a principal, and W115 treats the last
circle as the one that is separately funded.

Cost, demand, revenue and funding assumptions carry a basis: `D` derived from a source
model, `A` assumed, `M` measured. Calendar values, durations, lags, capacity, ramps, hire
dates and scenario scales do not. Months are integers; there is no partial-month proration.

## Scheduling

The scheduler takes items in priority order (circle, then declared start, then id),
predecessors first, which can pull a lower-priority predecessor ahead of unrelated work. Ids
break ties for scarce capacity. It is a serial heuristic, not an optimizer.

Each item starts at the latest of its declared month, its predecessors' ends (a standing
predecessor releases its successors one month after it starts), and, when leveling, the
first month from which every carrier it needs has room for the whole run. Demands are
resolved to carriers month by month and added up per carrier before they are compared with
capacity, so two demands that land on the same person count together. A finite item that
cannot finish inside the horizon, underway or not, goes beyond it: it books nothing,
unlocks nothing, and takes its dependents with it. Standing work runs from its scheduled
start to the horizon.

## Funding clock and reports

A funding year is twelve complete months from `calendar.fundingYearStartMonth`. Reports
carry `preFunding`, one entry per complete year in `costByYear`, `revenueByYear` and
`fundingByYear`, and `trailing`, and the three reconcile exactly to the monthly ledger. A
year-end outside the horizon is `null`, never copied from the last month. `openingCash`
(default 0) seeds the cash line.

`report()` returns the full schedule, the monthly ledger, plan findings once, scenario
findings with their scenario, and the summaries. The CLI's `--json` is a smaller
projection of the same.

## Findings

| Code | Meaning |
|---|---|
| E001 | Duplicate item, seat, stream, funding line, non-labor line or scenario id, or circle name. |
| E002 | Unknown or self dependency, negative lag, or a dependency cycle, named. |
| E003 | A stream unlocked by an unknown item, or with no volumes. |
| E004 | An item with no demands, an unknown or duplicate seat, a non-positive FTE, or an owner outside its demands. |
| E005 | An item with no duration, or a start outside the horizon. |
| E006 | A seat with no hires, an unknown or looping fallback, or the reserved id `external`. |
| E007 | An item in a circle the plan does not list. |
| W101 | A seat over capacity for the policy's months, or by the policy's FTE in any month. |
| W102 | A hire whose role stays under the policy's share of its capacity for the policy's months; the measured share is stated. |
| W103 | An item starting well before its seat arrives, with another internal seat carrying it. |
| W104 | An item starting late against its declared month, or never fitting, with the binding cause. |
| W105 | Cash going negative: first month and trough. |
| W106 | More than the policy's share of complete-year revenue resting on assumed volumes. |
| W107 | A first-circle item ending after funding year 1. |
| W108 | A stream that never unlocks inside the horizon. |
| W109 | An owner (explicit, else the first demand) running too many items at once. |
| W110–W112 | Headcount, gross cost and non-labor share drifting from the reference model, over complete years. |
| W115 | Internal FTE-months booked to the last circle beyond the policy, in plans with more than one circle; external carriage is stated separately. |
| W116 | A `fallback: null` seat carrying more than the policy's multiple of one seat's capacity through funding year 1, with the fallback share stated. |

Thresholds come from `lintPolicy(plan)`; a plan sets its own under `lint`. There are no
W113 or W114.

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
