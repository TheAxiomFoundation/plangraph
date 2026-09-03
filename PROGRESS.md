# Defensive audit progress

## State

- Branch: `review-fixes`
- Starting point: `06cf875`
- Audit: `plangraph-review-2026-09-03.out.md`, read in full
- Current phase: making lint heuristics measured and policy-driven

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

## Next

1. Make lint findings truthful, booking-based, and policy-driven; expose counted external
   FTE-months in reports (A3, A10; B5, B7; D8).
2. Harden CLI selection/error behavior and selected-scenario comparisons (A11; D5, D9).
3. Apply README corrections C1–C15 and document ESM/package semantics.
4. Add the clean-pack integration test and CI wiring (D10), run the full verification suite,
   push, open the PR, and monitor checks.
5. Write `out.md` with the PR URL, final test count, audit-to-commit table, and disagreements.
