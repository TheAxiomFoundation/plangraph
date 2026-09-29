# Completion odds from duration uncertainty

A design sketch, not built. It would answer "how likely is this item to finish by month
m, and what makes it late" from the graph, rather than from a probability someone types
in.

## What exists

`schedule(plan, scenario)` is a pure function. Each planned item starts at the latest of
its declared month, its predecessors' ends plus lag, and, when the scenario levels, the
first month from which its carriers have room; underway work keeps its declared start.
The start records which of these bound it.
Durations are one integer per item, and nothing in a plan says how sure anyone is about
that integer.

## Proposal

An item may carry a duration distribution beside its point duration:

```yaml
duration: 2                       # the plain schedule keeps using this
durationOdds:                     # illustrative numbers
  months: [1, 2, 3, 4]
  p: [0.1, 0.5, 0.3, 0.1]         # sums to 1
  basis: A                        # D, A or M, as on every other assumption
  note: why these odds, and from where
```

`odds(plan, scenario, { draws, seed })` runs the existing scheduler once per draw, with
each item's duration drawn from its distribution (items without one keep their point
duration), and returns for every item:

- P(finished by the end of month m) for each month in the horizon, and P(beyond it);
- the median and 80th-percentile finish month;
- binding shares: the fraction of draws in which each predecessor, capacity on a named
  seat, or the declared month bound the start.

Binding shares extend the existing binding from "why is this late" to "how often, and
because of what".

## Why it stays plangraph-shaped

- The probabilities come from the graph, the durations and the capacity, so they move when
  the plan moves. Nobody types a probability for an item.
- Deterministic. Each draw is seeded from `seed`, the draw index and the item id, so the
  same plan gives the same numbers, and adding an item leaves the others' draws alone.
- `schedule()` does not change. `odds()` builds a per-draw copy of the plan with durations
  replaced and calls it, so leveling, fallbacks, underway work, dropped items and scenario
  scales all apply in every draw.
- Shared predecessors correlate the draws by construction. A closed form (convolution
  along a chain, a product of CDFs at a join) is exact only without leveling and without
  shared ancestors. The microcosm roadmap has shared ancestors: its certified Route A
  release gates both flips, the dashboard, the waiver follow-up and the graph switch.
- Precision is stated: at 4,000 draws the standard error of any probability is at most
  0.8 percentage points.
- `durationScale` multiplies each drawn duration of planned work, as it multiplies the
  point duration today.

## Deadlines follow

plangraph lists deadlines under "Not yet". With odds, a deadline becomes a question the
graph can answer: P(the item finishes by the deadline's month). The microcosm roadmap has
four dated obligations plangraph checks none of: UK register entries that expire 10-03
and from 11-25, the County Files MVP target of late October to late November (#922), and
the QRF waiver that lapses 12-31. On 09-29, with the County Files owner decision parked,
the plan puts that MVP in November and December, after its target, and no finding says
so. A deadline field plus odds would report that miss, and how likely it is.

## On the microcosm roadmap

The graph switch is the first place this pays. #956 already states odds for it: 25% that
the first full-source attempt succeeds and 70% within three, and for the publish 10% by
10-01, 35% by 10-15 and 60% by 11-01 (as of 09-18). An attempt there takes 1-3 days, so
at month grain three attempts mostly land in one month. What moves the switch by months in
the roadmap plan is upstream: #1011, the native candidate and the d112 funding
placeholder. Distributions on those, derived through the edges, would give the switch's
odds by month. Binding shares would say how often d112 funding, rather than the run
itself, sets the date.

## What it cannot do

Month grain stays. A one-week item still occupies a month, so "done by 1 October" reads
as "done by the end of September". Durations are drawn independently unless the plan links
them through an edge or a shared seat, so a common cause the graph does not hold (one
build machine, one reviewer) is not in the odds. Each distribution carries its basis, so
an assumed one is visibly assumed.

Scoring the odds against outcomes stays outside plangraph, in the forecast log (ruled
2026-09-24).

## Found while modeling the roadmap

- Scenarios can drop items but cannot rewire an edge, so the Route A flip (directly, or
  after #578's gate) needed two alternative flip items, each dropped in the other
  scenario. Anything downstream of the flip would have needed a copy per branch.
- Durations and dates carry no basis, so the roadmap marks sourced and assumed in comments.
  `durationOdds` would carry one.
- In YAML, ` #` starts a comment, so an unquoted label such as `Fix #450` is cut to `Fix`
  without an error. The parser could refuse a label that ends where a comment begins, or
  the README could say to quote labels.

## Questions for Max

1. Distributions as explicit month probabilities only, or also shorthand that compiles to
   them (an attempt ledger like #956's, or low/likely/high)?
2. A separate `plangraph odds <plan>` command, or a column in `check`?
3. Deadlines in the same change, reported as P(finish by the deadline month)?
