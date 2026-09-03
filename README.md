# plangraph

Planning as a computation graph. A plan is a directed acyclic graph of work items over a
monthly calendar: items demand seats, seats exist from a hire month and cost money whether
or not they are busy, items depend on other items, finishing an item can unlock a revenue
stream, funding arrives on its own clock. A scenario is a set of overrides on that graph.
The scheduler is a pure, deterministic function from plan and scenario to schedule, and
every start it produces names the constraint that bound it, so "why is this late" is an
output rather than an argument.

It comes with a harness. Every save re-schedules every scenario and prints the aggregates a
planner reads first and the findings a reviewer would raise: seats over capacity, seats hired
before their work, owners arriving after their work starts, slips and their cause, cash going
negative, revenue that rests on assumptions, streams that never unlock, portfolios too wide,
principals carrying unfilled seats. Errors mean the graph is not a plan yet.

Plans are plain YAML or JSON, so a person or an agent can write one without a build step. YAML is for people, with comments carrying provenance; JSON is the interchange.

## Quick start

```
bun install
bun run check          # schedules examples/studio.yaml and prints the report
bun run watch          # the same, on every save
bun src/cli.ts check my-plan.json --json --scenario leveled
```

Or as a library:

```ts
import { loadPlanFile, report } from "plangraph";
const r = report(loadPlanFile("my-plan.json"));
for (const s of r.scenarios) console.log(s.scenario.name, s.costByYear, s.findings);
```

## The model

| Node | What it carries |
|---|---|
| Seat | `loadedAnnual` cost, `hireMonths` (one per seat in the role), `capacityFte`, and a `fallback`: the seat id that carries the work until the hire lands, `"external"` for a contractor with no capacity limit, or `null` for nobody. |
| Work item | `earliest` month, `duration` or `standing` (runs to the horizon), `predecessors` with optional lag, `demands` in FTE per month per seat, `underway` when the start is a fact, optional `burnPerMonth`. Its `circle` is its priority group. |
| Revenue stream | `unlockedBy` an item, `price`, `volumeByYear` after unlock, `rampMonths`. |
| Funding line | dollars `byMonth`, `counted` by default or not. |
| Non-labor line | dollars `byYear` of the funding calendar. |
| Scenario | `hireDelay` by seat, `volumeScale`, `countFunding`, `durationScale`, `effortScale`, and `level`: whether capacity binds. |

Every number carries a basis: `D` derived from a source model, `A` assumed, `M` measured.

The scheduler takes items in priority order (circle, then declared start, then id),
predecessors first. Each starts at the latest of its declared month, its predecessors' ends
(a standing predecessor counts from its start), and, when leveling, the first month every
demanded seat has room for the whole run. An unfilled seat's demand lands on its fallback,
so a late hire shows up as load on the person carrying it. An item that never fits goes
beyond the horizon rather than being crammed into the last month, and takes its dependents
with it.

## Findings

| Code | Meaning |
|---|---|
| E001–E006 | Broken graph: duplicate ids, unknown or self predecessors, unowned items, missing durations, looping or unknown fallbacks. |
| W101 | A seat is over capacity for three months or more. |
| W102 | A seat is hired, then idle for three months. |
| W103 | An item starts six months or more before its owner exists, and a person carries it. |
| W104 | An item starts three months or more after its declared month, or never fits, and why. |
| W105 | Cash goes negative, and when. |
| W106 | Most revenue rests on assumed volumes. |
| W107 | A first-circle item ends after funding year 1. |
| W108 | A stream never unlocks inside the horizon. |
| W109 | A seat owns four or more items at once. |
| W110–W112 | Drift from a reference model: headcount, gross, non-labor share. |
| W115 | Seats spent on work in the last circle. |
| W116 | A principal carries more than 1.5× capacity, mostly as fallback for unfilled seats. |

## Compared with TaskJuggler

[TaskJuggler](https://taskjuggler.org/) has done dependencies, resource leveling, cost and
revenue accounts and scenarios in a text DSL for twenty years, and it is the closest thing to
this. plangraph differs in what it is for: plans as YAML or JSON that agents write and check;
explainable bindings on every start; revenue keyed to unlocks with ramps and volumes by year;
scenarios as overrides; a harness that says where the plan does not make sense; a library
that renders in a browser. It does less: no working calendars or shifts, no effort-driven
durations, no shared resource pools across plans, no report engine.

## Not yet

Working calendars and part-time shifts. Effort-driven durations (today duration is fixed and
demand is per month). Resource pools shared across plans. Cost of capital. A drag interface.

## License

Apache-2.0. Built at [The Axiom Foundation](https://axiom.org).
