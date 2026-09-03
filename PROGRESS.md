# Defensive audit progress

## State

- Branch: `review-fixes`
- Starting point: `06cf875`
- Audit: `plangraph-review-2026-09-03.out.md`, read in full
- Current phase: completing carrier-by-month scheduling semantics

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

## Next

1. Complete carrier-by-month feasibility, per-demand booking integrity, fallback/external
   accounting, horizon edges, and scheduling/revenue tests (A1–A5; B2, B4, B5; D1–D3, D6).
2. Reconcile the funding clock and opening cash (A7; B3; D7).
3. Make lint findings truthful and policy-driven (A10; B7; D8).
4. Harden CLI selection/error behavior and selected-scenario comparisons (A11; D9).
5. Apply README corrections C1–C15 and document ESM/package semantics.
6. Add the clean-pack integration test and CI wiring (D10), run the full verification suite,
   push, open the PR, and monitor checks.
7. Write `out.md` with the PR URL, final test count, audit-to-commit table, and disagreements.
