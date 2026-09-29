# Completion odds from duration uncertainty

A design sketch, not built. It would answer "how likely is this item to finish by month
m, and what makes it late" from the graph, rather than from a probability someone types
in.

## What exists

`schedule(plan, scenario)` is a pure function. Each planned item starts at the latest of
its declared month, its predecessors' ends plus lag (a standing predecessor releases its
successors a month after it starts), and, when the scenario levels, the first month from
which its carriers have room (a hired seat marked `unlevelled` does not hold it); underway work
keeps its declared start. The start records one of these as its binding. When several tie,
it keeps one by a fixed rule: the declared month over a predecessor, and among
predecessors the id that sorts first. An item that cannot finish inside the horizon books
nothing.
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
each item's duration drawn from its distribution, and returns for every item the list
below. Items without a distribution keep their point duration; that includes finished
work, and a `done` flag would make it explicit.

- P(finished by the end of month m) for each month in the horizon, and P(beyond it);
- the median and 80th-percentile finish month;
- binding shares: the fraction of draws in which each constraint bound the start,
  counting every constraint that ties rather than the one the fixed rule records.

Binding shares extend the existing binding from "why does this start late" to "how often,
and because of what". They name the immediate cause of a start. Saying whether an upstream
item or the item's own duration sets its finish needs attribution along the whole path,
which this sketch does not include.

One change to how draws run, not to `schedule()`: because work that cannot finish inside
the horizon books nothing, a long draw would free its seats for other items and flatter
their odds. `odds()` should schedule each draw on a horizon extended by the longest
possible overrun, report on the plan's horizon, and count finishes past it as censored.

## Why it stays plangraph-shaped

- The probabilities come from the graph, the durations and the capacity, so they move when
  the plan moves. Nobody types a probability for an item.
- Deterministic. Each draw is seeded from `seed`, the draw index and the item id, so the
  same plan gives the same numbers, and adding an item leaves the others' draws alone.
- `schedule()` does not change. `odds()` builds a per-draw copy of the plan with durations
  replaced and calls it, so leveling, fallbacks, underway work, dropped items and scenario
  scales all apply in every draw.
- Durations are drawn independently, but finish dates depend on each other: through shared
  predecessors always, and through shared seats when the scenario levels. Each draw is a
  whole schedule, so those dependencies carry through. A closed form (convolution along a
  chain, a product of CDFs at a join) gives one item's odds exactly when nothing levels
  and the finish dates arriving at each join on its path are independent, which holds when
  no two of them share an ancestor with a drawn duration. The microcosm roadmap meets that
  today, so a first version could be exact for single items. Joint questions ("both by
  November") and leveled scenarios need the draws.
- Precision is stated: at 4,000 draws the standard error of any probability is at most
  0.8 percentage points.
- `durationScale` multiplies each drawn duration of planned work, as it multiplies the
  point duration today.

## Deadlines follow

plangraph lists deadlines under "Not yet". With odds, a deadline becomes a question the
graph can answer. A deadline falling inside month m is met with probability between
P(finished by the end of month m−1) and P(finished by the end of month m), and a report
should give both. The microcosm roadmap has dated obligations plangraph checks none of:
UK register entries that expire from 10-03 through 12-22, the County Files MVP target of
late October to late November (#922), and the QRF waiver entries that lapse on 12-31 or
at the next certified build. On 09-29, with the County Files owner decision still open,
the plan puts that MVP in November and December, past its target, and no finding says so.
A deadline field plus odds would report that miss, and how likely it is.

## On the microcosm roadmap

The graph switch is the first place this pays. #956 already states odds for it: 25% that
the first full-source attempt succeeds and 70% within three, and for the publish 10% by
10-01, 35% by 10-15 and 60% by 11-01 (as of 09-18). An attempt there takes 1-3 days, so
at month grain three attempts mostly land in one month. What moves the switch by months in
the roadmap plan is upstream: #1011, the native candidate and the d112 funding
placeholder. Distributions on those, carried through the edges, would give the switch's
odds by month, and binding shares would say how often the funding placeholder, rather
than the candidate, is what holds the run's start.

## What it cannot do

Month grain stays. A one-week item still occupies a month, so "done by 1 October" reads
as "done by the end of September". A common cause the graph does not hold (one build
machine, one reviewer) is not in the odds, because durations are drawn independently.
Each distribution carries its basis, so an assumed one is visibly assumed.

Scoring computed odds against outcomes would sit outside plangraph, next to the team's
hand-set weekly forecasts, which stay in the scoreboard issue (#1013).

## Found while modeling the roadmap

- Scenarios can drop items but cannot rewire an edge, so the US default (Route A
  flipped directly, or an exact-k release through #578's gate) needed two alternative
  items, and the graph switch two more, each pair dropped in the other scenario. Because
  the ids differ, plangraph lists no slips between the branches; the reader compares
  dates by hand.
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
