// How the property suite runs: one fixed seed and a modest run count by default, so CI is
// fast and reproducible, and environment overrides for deep local runs:
//
//   PLANGRAPH_PROPERTY_RUNS=5000 PLANGRAPH_PROPERTY_SEED=424242 bunx vitest run test/property-
//
// A failing property throws with its shrunk counterexample printed compactly, and the seed and
// path that replay it: add PLANGRAPH_PROPERTY_PATH and select the one test with -t.

import fc from "fast-check";
import { expect } from "vitest";
import { validPlan } from "./arbitraries";
import type { Plan, Scenario } from "../../src/index";

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new Error(`${name} must be an integer, got "${raw}"`);
  return n;
};

export const SEED = envInt("PLANGRAPH_PROPERTY_SEED", 20260924);
export const RUNS = envInt("PLANGRAPH_PROPERTY_RUNS", 500);
const PATH = process.env.PLANGRAPH_PROPERTY_PATH || undefined;

/** Vitest's per-test timeout, scaled with the run count so a deep run is not cut off. */
export const TIMEOUT = Math.max(60_000, RUNS * 100);

/**
 * Coverage floors (the share of runs that must exercise a case) are only meaningful over
 * enough runs; below this a floor could trip by chance, so it is not checked.
 */
const FLOOR_MIN_RUNS = 100;

/**
 * Check a property with the suite's seed and run count. On failure, throw an error whose
 * message is `explain` applied to the shrunk counterexample, with the seed and path to replay.
 */
export function holds<T>(
  arb: fc.Arbitrary<T>,
  predicate: (value: T) => boolean,
  explain: (value: T) => string,
  params: fc.Parameters<[T]> = {},
): fc.RunDetails<[T]> {
  const result = fc.check(fc.property(arb, predicate), { seed: SEED, numRuns: RUNS, ...(PATH ? { path: PATH } : {}), ...params });
  if (!result.failed) return result;
  const where = `seed ${result.seed}${result.counterexamplePath ? `, path "${result.counterexamplePath}"` : ""}; ${result.numRuns} runs, ${result.numShrinks} shrinks`;
  if (result.counterexample === null) {
    throw new Error(`property could not run (${result.interrupted ? "interrupted" : "too many skipped inputs"}; ${where})`);
  }
  let detail: string;
  try {
    detail = explain(result.counterexample[0]);
  } catch (e) {
    detail = `(explaining the counterexample threw: ${String(e)})\n${JSON.stringify(result.counterexample[0])}`;
  }
  const thrown = result.errorInstance ? `\nthrew: ${String(result.errorInstance).split("\n")[0]}` : "";
  throw new Error(`counterexample (${where}):\n${detail}${thrown}\nreplay: PLANGRAPH_PROPERTY_SEED=${result.seed} PLANGRAPH_PROPERTY_PATH="${result.counterexamplePath}" bunx vitest run <file> -t "<test name>"`);
}

/**
 * Counts the inputs a property saw and the ones it skipped as invalid plans, so a generator
 * regression cannot quietly turn a property into a check over almost nothing.
 */
export class Admission {
  tried = 0;
  invalid = 0;
  private lastWhy = "";

  /** Count the input, and skip it (fc.pre) unless the plan, under the scenario, is valid. */
  admit(plan: Plan, scenario: Scenario): void {
    this.tried++;
    const v = validPlan(plan, scenario);
    if (!v.ok) {
      this.invalid++;
      this.lastWhy = v.why;
    }
    fc.pre(v.ok);
  }

  /** Fewer than 2% of generated inputs may be invalid. The generators aim for none. */
  expectFewSkipped(): void {
    expect(this.invalid, `${this.invalid} of ${this.tried} generated plans were invalid; last: ${this.lastWhy}`).toBeLessThanOrEqual(this.tried * 0.02);
  }
}

/**
 * Assert that at least `share` of the runs exercised a case, so the property is not vacuous
 * over the default seed and run count, or over any seed at a deep run count.
 */
export function expectCoverage(what: string, hits: number, runs: number, share: number): void {
  if (runs < FLOOR_MIN_RUNS) return;
  expect(hits, `only ${hits} of ${runs} runs had ${what}`).toBeGreaterThanOrEqual(Math.ceil(runs * share));
}
