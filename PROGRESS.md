# Defensive audit progress

## State

- Branch: `review-fixes`
- Starting point: `06cf875`
- Audit: `plangraph-review-2026-09-03.out.md`, read in full
- Current phase: implementation complete; GitHub delivery awaiting write access
- Delivery blocker: the shell cannot resolve `github.com`, `gh` reports an invalid saved
  token, and the connected GitHub app canceled both attempted write operations.

## Done

- Confirmed the worktree is clean and the branch starts at the expected WIP commit.
- Recorded the audit requirements, policy decisions, required commands, PR title, and output deliverable.
- Established `parsePlan` as a complete runtime-shape boundary with exact-path integer,
  finite-number, reference, scenario override, and required-string validation.
- Added structural preflight for cycles, unknown references/circles, duplicate demand seats,
  invalid owners, and duplicate ids across every modeled scope.
- Made report preflight stop scheduling/ledger work on plan errors, with plan findings counted
  once and scenario findings kept scenario-local.
- Made id-keyed records and override lookups prototype-safe across parse, schedule, economics,
  and report, including `__proto__` and `toString` regressions.
- Added thirteen validation/preflight/prototype tests, including sparse-array, reserved-id,
  and derived-overflow guards; 30 committed tests pass and typecheck is clean.
- Closed the programmatic-input edge where non-enumerable own override properties could be
  consumed without validation; inherited override properties remain ignored.
- Completed whole-run horizon enforcement, including standing work that reaches the horizon,
  with zero load, carriers, or bookings for beyond items.
- Preserved each demand's source/carrier placement month by month while aggregating only for
  feasibility; mixed own/fallback fixed load and tied bindings are now deterministic.
- Added explicit per-month bookings, deep fallback/external coverage, the chosen all-or-nothing
  partial-staffing policy, standing metadata, slip, exact revenue, and numeric-closure tests.
- 43 tests pass; typecheck and the example check are clean.
- Reworked funding-year helpers around complete twelve-month periods, with explicit
  pre-funding and trailing totals and nullable unavailable year-end observations.
- Exposed reconciling cost/revenue/funding period totals in every scenario report, seeded
  cash with `openingCash`, and stopped incomplete reference spans from fabricating values.
- Added four shifted-clock, endpoint, reconciliation, and opening-cash tests; 47 tests pass,
  and typecheck, build, and the example check are clean.
- Routed every lint materiality threshold through `lintPolicy`, including measured idle share
  and reference-cost tolerance.
- Corrected W101/W102/W109/W115/W116 with actual capacity, explicit ownership, and monthly
  booking data; W116 now reports its measured fallback share.
- Added `externalFteMonths` to scenario reports while keeping external work uncapped and
  uncosted, and excluded it from W115 internal capacity.
- Added nine lint/external policy tests; 56 tests pass, and typecheck, build, and the example
  check are clean.
- Made missing/unknown scenario selection a concise exit-2 usage error and normalized all
  parse, preflight, and computation failures to one line per error with no stack trace.
- Kept slips anchored to the plan baseline under selection, added the external FTE-months
  human row, and exposed plan/funding/external summaries in CLI JSON.
- Added seven CLI/preflight tests; 63 tests pass, and typecheck, build, and the example check
  are clean.
- Enforced the whole-run horizon invariant for underway finite work as well as movable work;
  an over-horizon item now goes beyond with no carriers, load, or bookings.
- Added an explicit ending-cash assertion from opening cash plus the reconciled pre-funding,
  complete-year, and trailing funding, revenue, and cost periods.
- Applied README corrections C1–C15, including exact parser/preflight, scheduling, funding,
  lint, ESM, root-export, and TaskJuggler claims.
- Documented the serial scheduling heuristic, deterministic single-binding attribution,
  B5 inference conventions, configurable lint policy, and intentionally absent W113/W114.
- Added explicit valid owners to the example without changing its scheduling semantics and
  corrected both leveled scenario gists to acknowledge fixed-load overloads.
- The documentation state passes 64 tests plus typecheck, build, and the example check.
- Added `prepack`, a temporary npm pack/install ESM, declarations, and installed-bin
  integration test, plus explicit Node 20 package coverage in CI.
- The complete seven-file suite passes 65 tests and 901 assertions, including the offline
  package test under Node 25; CI performs the clean registry-backed install under Node 20.
- Typecheck, build, and the example check are clean.
- Completed independent validation, documentation, packaging, and final-diff reviews with
  no remaining A1–A11, C1–C15, or D1–D10 blocker.

## Next

1. Restore GitHub write access, push `review-fixes`, and open the requested PR.
2. Monitor and repair CI until green.
3. Write `out.md` with the PR URL, final test count, audit-to-commit table, and disagreements.
