import fc from "fast-check";
import { describe, it } from "vitest";
import { ledger, monthLabel, report, schedule, type Plan, type Scenario } from "../src/index";
import { ECON, arbRawPlan, arbRawScenario, buildPlan, buildScenario, compactEconomics, compactPlan, compactScenario, type RawPlan, type RawScenario } from "./property/arbitraries";
import { oracleLedger } from "./property/ledger-oracle";
import { Admission, TIMEOUT, expectCoverage, holds } from "./property/run";

// P5, economics conservation: the ledger and the report agree, month by month and period by
// period, with an independent recomputation from the plan, the scenario and the scheduled
// starts (test/property/ledger-oracle.ts). The generator adds money to every scheduling
// feature: per-year and per-hire salaries, escalation, a funding year that opens mid-horizon,
// burn, revenue streams with ramps and volume scaling, funding lines with scenario overrides,
// and non-labor lines, over horizons up to 40 months so several funding years close.

/** Equal to a millionth, relative to the larger magnitude (sums of dollars differ in their last bits with the order they were added). */
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

const ROWS = ["labor", "headcount", "nonLabor", "burn", "revenue", "funding", "cost", "net", "cash"] as const;

interface Seen {
  unlocked: boolean;
  lockedStream: boolean;
  completeYear: boolean;
  trailing: boolean;
  preFunding: boolean;
}

/** Every disagreement between the engine and the oracle for one plan and scenario. */
function economicsProblems(plan: Plan, sc: Scenario, seen?: Seen): string[] {
  const out: string[] = [];
  const H = plan.calendar.horizonMonths;
  const S = schedule(plan, sc);
  const L = ledger(plan, S);
  const O = oracleLedger(plan, sc, S);

  for (const r of ROWS) {
    for (let m = 0; m < H; m++) {
      if (!close(L[r][m], O[r][m])) {
        out.push(`${r}[${m}]: engine ${L[r][m]}, oracle ${O[r][m]}`);
        break;
      }
    }
  }
  for (const st of plan.streams) {
    if (L.unlocks[st.id] !== O.unlocks[st.id]) out.push(`unlock of ${st.id}: engine ${L.unlocks[st.id]}, oracle ${O.unlocks[st.id]}`);
    const on = L.unlocks[st.id] ?? H;
    for (let m = 0; m < on; m++) if (L.revenueByStream[st.id][m] !== 0) out.push(`revenue of ${st.id} in month ${m}, before its unlock at ${L.unlocks[st.id]}`);
    for (let m = 0; m < H; m++) if (!close(L.revenueByStream[st.id][m], O.revenueByStream[st.id][m])) out.push(`revenueByStream.${st.id}[${m}]: engine ${L.revenueByStream[st.id][m]}, oracle ${O.revenueByStream[st.id][m]}`);
    if (seen) {
      if (L.unlocks[st.id] !== null) seen.unlocked = true;
      else seen.lockedStream = true;
    }
  }

  // The report's periods reconcile to the monthly ledger: pre-funding, one entry per complete
  // funding year, trailing; year-end headcount is null when the year ends outside the horizon.
  const R = report({ ...plan, scenarios: [sc] });
  if (R.errors) return [...out, `report found ${R.errors} errors`];
  const s = R.scenarios[0];
  const cal = plan.calendar;
  const years = Math.max(0, Math.floor((H - cal.fundingYearStartMonth) / 12));
  const sum = (row: number[], a: number, b: number) => row.slice(Math.max(0, a), Math.min(b, H)).reduce((x, y) => x + y, 0);
  if (seen) {
    if (years > 0) seen.completeYear = true;
    if (cal.fundingYearStartMonth + 12 * years < H) seen.trailing = true;
    if (cal.fundingYearStartMonth > 0) seen.preFunding = true;
  }
  if (s.costByYear.length !== years) out.push(`costByYear has ${s.costByYear.length} entries for ${years} complete years`);
  for (let k = 0; k < years; k++) {
    const a = cal.fundingYearStartMonth + 12 * k;
    if (!close(s.costByYear[k], sum(O.cost, a, a + 12))) out.push(`costByYear[${k}]: report ${s.costByYear[k]}, oracle ${sum(O.cost, a, a + 12)}`);
    if (!close(s.revenueByYear[k], sum(O.revenue, a, a + 12))) out.push(`revenueByYear[${k}]: report ${s.revenueByYear[k]}, oracle ${sum(O.revenue, a, a + 12)}`);
    if (!close(s.fundingByYear[k], sum(O.funding, a, a + 12))) out.push(`fundingByYear[${k}]: report ${s.fundingByYear[k]}, oracle ${sum(O.funding, a, a + 12)}`);
  }
  if (s.headcountByYearEnd.length !== years) out.push(`headcountByYearEnd has ${s.headcountByYearEnd.length} entries for ${years} complete years`);
  for (let k = 0; k < years; k++) {
    const end = cal.fundingYearStartMonth + 12 * k + 11;
    const want = end < H ? O.headcount[end] : null;
    if (s.headcountByYearEnd[k] !== want) out.push(`headcountByYearEnd[${k}]: report ${s.headcountByYearEnd[k]}, oracle ${want}`);
  }
  for (const key of ["cost", "revenue", "funding"] as const) {
    const total = sum(O[key], 0, H);
    const byYear = key === "cost" ? s.costByYear : key === "revenue" ? s.revenueByYear : s.fundingByYear;
    const parts = s.preFunding[key] + byYear.reduce((x, y) => x + y, 0) + s.trailing[key];
    if (!close(total, parts)) out.push(`${key}: preFunding + complete years + trailing = ${parts}, monthly total ${total}`);
    if (!close(s.preFunding[key], sum(O[key], 0, cal.fundingYearStartMonth))) out.push(`preFunding.${key}: report ${s.preFunding[key]}, oracle ${sum(O[key], 0, cal.fundingYearStartMonth)}`);
  }
  // The cash trough is the lowest cash, in the first month it is reached.
  const trough = Math.min(...O.cash);
  if (!close(s.cashTrough.usd, trough)) out.push(`cashTrough ${s.cashTrough.usd}, oracle minimum cash ${trough}`);
  const first = L.cash.indexOf(Math.min(...L.cash));
  if (s.cashTrough.month !== monthLabel(cal, first)) out.push(`cashTrough month ${s.cashTrough.month}, but the ledger's cash first bottoms out in ${monthLabel(cal, first)}`);
  for (const st of plan.streams) {
    const want = L.unlocks[st.id] === null ? null : monthLabel(cal, L.unlocks[st.id]!);
    if (s.unlocks[st.id] !== want) out.push(`report unlock of ${st.id} ${s.unlocks[st.id]}, ledger ${want}`);
  }
  return out;
}

describe("P5 economics conservation, against an independent ledger", () => {
  it("P5.economics: the ledger matches the oracle month by month, and the report's periods, trough, year-end headcount and unlocks match both", () => {
    const admission = new Admission();
    const hits = { unlocked: 0, lockedStream: 0, completeYear: 0, trailing: 0, preFunding: 0 };
    const build = ([rp, rs]: [RawPlan, RawScenario]) => {
      const plan = buildPlan(rp);
      return { plan, sc: buildScenario(plan, rs) };
    };
    const result = holds(
      fc.tuple(arbRawPlan(ECON), arbRawScenario({ overrides: true })),
      (raw) => {
        const { plan, sc } = build(raw);
        admission.admit(plan, sc);
        const seen: Seen = { unlocked: false, lockedStream: false, completeYear: false, trailing: false, preFunding: false };
        const ok = economicsProblems(plan, sc, seen).length === 0;
        for (const k of Object.keys(hits) as (keyof Seen)[]) if (seen[k]) hits[k]++;
        return ok;
      },
      (raw) => {
        const { plan, sc } = build(raw);
        return [
          `plan:      ${JSON.stringify(compactPlan(plan))}`,
          `economics: ${JSON.stringify(compactEconomics(plan))}`,
          `scenario:  ${JSON.stringify(compactScenario(sc))}`,
          ...economicsProblems(plan, sc).map((x) => `  -> ${x}`),
        ].join("\n");
      },
    );
    admission.expectFewSkipped();
    const runs = result.numRuns;
    expectCoverage("a stream that unlocks", hits.unlocked, runs, 0.15);
    expectCoverage("a stream that never unlocks", hits.lockedStream, runs, 0.09);
    expectCoverage("a complete funding year", hits.completeYear, runs, 0.15);
    expectCoverage("a trailing partial year", hits.trailing, runs, 0.3);
    expectCoverage("months before the funding year opens", hits.preFunding, runs, 0.3);
  }, TIMEOUT);
});
