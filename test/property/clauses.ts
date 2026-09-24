// Runs one clause of the schedule oracle as a fast-check property: generate a plan and a
// scenario, schedule, replay, and hold the clause to zero violations. Each clause is its own
// property with its own shrunk counterexample, so a failure names the rule that broke.

import fc from "fast-check";
import { schedule, type Plan, type Scenario, type Schedule } from "../../src/index";
import { arbRawPlan, arbRawScenario, buildPlan, buildScenario, describeCase, type GenOpts, type RawPlan, type RawScenario } from "./arbitraries";
import { zeroCoverage, type Coverage, type Violation } from "./oracle";
import { Admission, holds } from "./run";

export type Check = (plan: Plan, sc: Scenario, S: Schedule) => { violations: Violation[]; coverage?: Coverage };

export interface ClauseRun {
  /** Inputs the clause was checked on. */
  runs: number;
  /** For each coverage key, how many runs met that case at least once. */
  hits: Record<keyof Coverage, number>;
}

/**
 * Check that `check` reports no violation tagged `tag` over generated plans and scenarios
 * (every scenario knob on; `level` pins leveling, or leaves it to the generator).
 */
export function clauseHolds(tag: string, gen: GenOpts, check: Check, level?: boolean): ClauseRun {
  const admission = new Admission();
  const hits: Record<keyof Coverage, number> = zeroCoverage();
  const build = ([rp, rs]: [RawPlan, RawScenario]) => {
    const plan = buildPlan(rp);
    return { plan, sc: buildScenario(plan, rs) };
  };
  const result = holds(
    fc.tuple(arbRawPlan(gen), arbRawScenario({ level, overrides: true })),
    (raw) => {
      const { plan, sc } = build(raw);
      admission.admit(plan, sc);
      const { violations, coverage } = check(plan, sc, schedule(plan, sc));
      if (coverage) for (const k of Object.keys(coverage) as (keyof Coverage)[]) if (coverage[k] > 0) hits[k]++;
      return !violations.some((x) => x.prop === tag);
    },
    (raw) => {
      const { plan, sc } = build(raw);
      const S = schedule(plan, sc);
      const mine = check(plan, sc, S).violations.filter((x) => x.prop === tag);
      return `${describeCase(plan, sc, S)}\n${mine.map((x) => `  -> ${x.prop}${x.item ? ` ${x.item}` : ""}: ${x.msg}`).join("\n")}`;
    },
  );
  admission.expectFewSkipped();
  return { runs: result.numRuns, hits };
}
