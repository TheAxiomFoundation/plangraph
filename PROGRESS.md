# Defensive audit progress

## State

- Branch: `review-fixes`
- Starting point: `06cf875`
- Audit: `plangraph-review-2026-09-03.out.md`, read in full
- Current phase: inventorying the WIP and planning the validation boundary

## Done

- Confirmed the worktree is clean and the branch starts at the expected WIP commit.
- Recorded the audit requirements, policy decisions, required commands, PR title, and output deliverable.

## Next

1. Fix the duplicate `ownerOf` export and implement complete parse/preflight validation (A4, A6, A8, A9; B1, B6; D4, D5).
2. Complete carrier-by-month feasibility and fallback/external accounting (A1–A5; B2, B4, B5; D1–D3, D6).
3. Reconcile the funding clock and opening cash (A7; B3; D7).
4. Make lint findings truthful and policy-driven (A10; B7; D8).
5. Harden report and CLI selection/error behavior (A11; D9).
6. Apply README corrections C1–C15 and document ESM/package semantics.
7. Add the clean-pack integration test and CI wiring (D10), run the full verification suite, push, open the PR, and monitor checks.
8. Write `out.md` with the PR URL, final test count, audit-to-commit table, and disagreements.
