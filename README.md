# plangraph

Planning as a computation graph. A valid plan must be a directed acyclic graph of work
items over a monthly calendar: items demand seats, seats exist from a hire month and cost
money whether or not they are busy, items depend on other items, finishing an item can
unlock a revenue stream, and funding arrives on its own clock. A scenario is a set of
overrides on that graph.

The scheduler is a pure, deterministic serial schedule-generation heuristic. Every
scheduled start carries one deterministic binding label, so “why is this late?” is usually
an output rather than an argument. When constraints coincide, that label names one of them;
it is not an exhaustive set of every binding cause.

It comes with a harness. With `bun run watch`, every save re-schedules every scenario and
prints the aggregates a planner reads first and the findings a reviewer would raise:
capacity overloads, underused hires, work carried before a role arrives, slips and their
cause, cash going negative, assumed revenue, missing unlocks, wide owner portfolios, and
principal fallback load. Malformed data is rejected by the parser with exact paths.
Structural error findings mean the graph is not a plan yet, so `report()` returns no
scenario schedules; plan findings appear once and schedule findings stay with their
scenario.

Plans are plain YAML or JSON, so authoring plan data needs no build step. YAML is for
people, with comments carrying provenance; JSON is the interchange. Producing the npm
package does use a build step to create JavaScript and declarations in `dist`.

## Quick start

```sh
bun install
bun run check          # schedules examples/studio.yaml and prints the report
bun run watch          # the same, on every save
bun src/cli.ts check my-plan.json --json --scenario leveled
```

Or, from an ESM program:

```ts
import { loadPlanFile, report } from "plangraph";

const result = report(loadPlanFile("my-plan.json"));
for (const scenario of result.scenarios) {
  console.log(scenario.scenario.name, scenario.costByYear, scenario.findings);
}
```

The published package is ESM-only and requires Node.js 20 or newer; CommonJS `require()` is
not exported. The root export includes `loadPlanFile`, which statically reaches `node:fs`,
so it is a Node entry point rather than a browser entry point.

## The model

| Node | What it carries |
|---|---|
| Seat | `loadedAnnual` cost, `hireMonths` (one per seat in the role), `capacityFte`, and a `fallback`. While a role has zero hires, all its work goes to that seat id, to `"external"`, or stays on the empty role when fallback is `null`. |
| Work item | `earliest`, finite `duration` or `standing`, dependencies with optional lag, FTE `demands`, explicit optional `owner`, `underway` when the start is a fact, optional `burnPerMonth`, and a priority `circle`. |
| Revenue stream | An `unlockedBy` item, `price`, recurring annual `volumeByYear` after unlock, and `rampMonths`. |
| Funding line | Dollars `byMonth`, counted by default or overridden by a scenario. |
| Non-labor line | Dollars `byYear` on the funding calendar. |
| Scenario | `hireDelay` by seat, `volumeScale`, `countFunding`, `durationScale`, `effortScale`, and `level`, which decides whether movable work respects capacity. |
| Plan | Calendar, priority circles, optional `openingCash`, optional reference totals, and optional `lint` threshold overrides. |

Fallback is all-or-nothing per role, not per unfilled seat. Once the first seat in a role is
hired, all demand remains on that role; the scheduler does not split excess demand between
internal and fallback capacity. External work is unlimited and uncosted, but it is counted
month by month in `Schedule.external` and as `externalFteMonths` in each scenario report.
The model has no separate principal/bridge or separately-funded/out-of-scope circle fields:
W116 treats `fallback: null` seats as principals, and W115 treats the final declared circle
as the separately-funded candidate. Those are lint conventions, not semantic facts.

Selected cost, demand, revenue, and funding assumptions carry a basis: `D` derived from a
source model, `A` assumed, or `M` measured. Calendar values, durations, capacity, ramps, and
lags, hire dates and delays, and scenario scales do not have basis fields. Months are
integers and there is no partial-month proration.

## Scheduling policy

The scheduler orders movable work by circle, declared start, then item id, while visiting
predecessors first. That dependency walk can pull a lower-priority predecessor ahead of
unrelated work. Item ids break otherwise equal capacity contests. This is a stable,
explainable heuristic, not a global optimizer.

Each movable item starts at the latest of its declared month, predecessor readiness,
and—when leveling—the first month where the demands, resolved and aggregated by carrier for
every month, fit for the whole run. A standing predecessor releases a successor one month
after the standing work starts. Any finite item, including work marked underway, that
cannot finish inside the horizon goes beyond it, books nothing, and takes its dependents
with it. Standing work runs from its scheduled start through the horizon.

The chosen binding label is stable under input-array permutation: predecessor ids and equal
capacity shortages are tie-broken deterministically. Coincident causes beyond that one label
are not currently retained.

## Funding clock and reports

Funding years contain twelve complete months beginning at
`calendar.fundingYearStartMonth`. Reports expose `preFunding`, one entry per complete year in
`costByYear` / `revenueByYear` / `fundingByYear`, and `trailing`; those periods reconcile
exactly to each monthly ledger. A funding-year endpoint outside the horizon is `null`, never
copied from the final month. `openingCash` defaults to zero and seeds the monthly cash line.

The library `report()` result contains the full schedule, monthly ledger, plan findings,
scenario findings, and summaries. CLI JSON is a smaller projection intended for command-line
consumers.

## Findings

| Code | Meaning |
|---|---|
| E001 | Duplicate item, seat, stream, funding-line, non-labor-line, scenario id, or circle name. |
| E002 | Unknown/self dependency, invalid lag, or a dependency cycle; the cycle is named. |
| E003 | A stream names an unknown unlocking item or has no annual volumes. |
| E004 | Missing, unknown, non-positive, or duplicate demand; or an owner outside the item’s demands. |
| E005 | Work has an invalid duration or lies outside the horizon. |
| E006 | A seat has no capacity/hires, an unknown or looping fallback, or uses reserved id `external`. |
| E007 | A work item names an unknown circle. |
| W101 | A seat exceeds capacity for the configured duration or peak magnitude. |
| W102 | After a hire, aggregate role demand remains below the configured share of current aggregate role capacity; the measured share is reported. |
| W103 | A demanded role arrives well after work starts and another internal seat carries it. |
| W104 | Work slips past its declared month or cannot fit, with one deterministic binding cause. |
| W105 | Cash goes negative, with the first month and trough. |
| W106 | More than the configured share of complete-year revenue rests on assumed volumes. |
| W107 | A first-circle item finishes after funding year 1. |
| W108 | A stream never unlocks inside the horizon. |
| W109 | An explicit owner (or first-demand default) owns too many concurrent items. |
| W110–W112 | Headcount, gross-cost, and non-labor-share drift from a reference model, over complete comparable years. |
| W115 | In plans with more than one circle, internal, never external, FTE-months booked to the final circle exceed policy. |
| W116 | From month 0 through funding-year 1, a `fallback: null` seat exceeds the one-seat load threshold while carrying fallback work; the measured fallback share is reported. |

All materiality thresholds used by these heuristics come from `lintPolicy(plan)` and can be
overridden through `plan.lint`. There are intentionally no W113 or W114 findings.

## Compared with TaskJuggler

[TaskJuggler](https://taskjuggler.org/) has handled dependencies, resource leveling,
accounts, and scenarios in a text DSL [for twenty years](https://taskjuggler.org/manual-git/change_log.html),
and it is the closest thing to this. TaskJuggler also supports
[inheriting scenario-specific overrides](https://taskjuggler.org/tj3/manual/scenario.html),
so overrides alone are not a differentiator. Both tools support accounting keyed to task
[periods or completion](https://taskjuggler.org/tj3/manual/charge.html). plangraph’s narrower
distinction is a compact YAML/JSON graph for agents and people, deterministic binding
explanations, and recurring annual-volume revenue streams with explicit ramps.

plangraph does less: no working calendars or shifts, no effort-driven durations, no shared
resource pools across plans, and no configurable report-definition/rendering engine. It has
a fixed `report()` API and CLI, but no renderer.

## Not yet

Critical path and total/free float. Deadlines and latest starts. Working calendars and
part-time shifts. Effort-driven durations (today duration is fixed and demand is per month).
Resource pools shared across plans. External pricing. Cost of capital. A drag interface.

## License

Apache-2.0. Built at [The Axiom Foundation](https://axiom.org).
