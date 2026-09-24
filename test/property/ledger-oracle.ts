// An independent recomputation of the money from the plan, the scenario and the scheduled
// starts, following the documented rules (the header of src/economics.ts, the doc comments on
// SeatDef, RevenueStream, FundingLine, NonLaborLine and Scenario in src/model.ts, and the
// README's "Funding clock and reports"). It does not call the engine's cost helpers; the
// effective hires come from the schedule oracle's specHires, not from the engine.

import type { Plan, Scenario, Schedule, SeatDef } from "../../src/index";
import { specHires } from "./oracle";

/** model.ts fundingYear: 1 for the first twelve months from the funding start, 0 or less before it. */
const fundingYear = (plan: Plan, m: number): number => Math.floor((m - plan.calendar.fundingYearStartMonth) / 12) + 1;

/**
 * Loaded monthly cost of hire k of a seat in month m (SeatDef in model.ts): the hire's own
 * per-year schedule, else the role's per-year schedule, else loadedAnnual escalated from
 * funding year 2; months before the funding year opens use year 1; the last value holds.
 */
export function hireCost(plan: Plan, s: SeatDef, k: number, m: number): number {
  const y = Math.max(0, fundingYear(plan, m) - 1);
  const ownRate = s.loadedAnnualByHire?.[k];
  if (ownRate && ownRate.length) return ownRate[Math.min(y, ownRate.length - 1)] / 12;
  if (s.loadedAnnualByYear && s.loadedAnnualByYear.length) return s.loadedAnnualByYear[Math.min(y, s.loadedAnnualByYear.length - 1)] / 12;
  return (s.loadedAnnual * (1 + plan.escalation.rate) ** y) / 12;
}

export interface LedgerRows {
  labor: number[];
  headcount: number[];
  nonLabor: number[];
  burn: number[];
  revenue: number[];
  revenueByStream: Record<string, number[]>;
  funding: number[];
  cost: number[];
  net: number[];
  cash: number[];
  unlocks: Record<string, number | null>;
}

export function oracleLedger(plan: Plan, sc: Scenario, S: Schedule): LedgerRows {
  const H = plan.calendar.horizonMonths;
  const zeros = () => new Array<number>(H).fill(0);
  const hires = specHires(plan, sc);
  const labor = zeros(), headcount = zeros(), nonLabor = zeros(), burn = zeros(), revenue = zeros(), funding = zeros();

  // Every seat on payroll from its hire month, busy or not.
  for (const s of plan.seats) {
    const { months, index } = hires[s.id];
    months.forEach((h, j) => {
      for (let m = Math.max(0, h); m < H; m++) {
        labor[m] += hireCost(plan, s, index[j], m);
        headcount[m] += 1;
      }
    });
  }
  // Non-labor by funding year from the funding start, the last year holding; nothing before it.
  for (const line of plan.nonLabor) {
    for (let m = plan.calendar.fundingYearStartMonth; m < H; m++) {
      if (line.byYear.length) nonLabor[m] += line.byYear[Math.min(fundingYear(plan, m), line.byYear.length) - 1] / 12;
    }
  }
  // Burn while an item runs.
  for (const it of S.items) if (!it.beyond && it.item.burnPerMonth) for (let m = it.start; m < it.end; m++) burn[m] += it.item.burnPerMonth.usd;
  // A stream turns on when its item completes (a standing item: when it starts), never when the
  // item is beyond the horizon; annual volume by year since unlock, ramped linearly over rampMonths, times volumeScale.
  const unlocks: Record<string, number | null> = {};
  const revenueByStream: Record<string, number[]> = {};
  for (const st of plan.streams) {
    const row = zeros();
    revenueByStream[st.id] = row;
    const it = S.items.find((x) => x.item.id === st.unlockedBy)!;
    const on = it.beyond ? null : it.item.standing ? it.start : it.end;
    unlocks[st.id] = on !== null && on < H ? on : null;
    if (unlocks[st.id] === null) continue;
    for (let m = on!; m < H; m++) {
      const k = m - on!;
      const units = st.volumeByYear.units[Math.min(Math.floor(k / 12), st.volumeByYear.units.length - 1)] * (sc.volumeScale ?? 1);
      const ramp = st.rampMonths > 0 && k < st.rampMonths ? (k + 1) / st.rampMonths : 1;
      row[m] = (units / 12) * ramp * st.price.usd;
      revenue[m] += row[m];
    }
  }
  // Funding counts by the scenario's override, else the line's default; missing months are zero.
  for (const f of plan.funding) {
    const counted = sc.countFunding && Object.prototype.hasOwnProperty.call(sc.countFunding, f.id) ? sc.countFunding[f.id] : f.counted;
    if (counted) for (let m = 0; m < H; m++) funding[m] += f.byMonth[m] ?? 0;
  }
  const cost = labor.map((x, m) => x + nonLabor[m] + burn[m]);
  const net = cost.map((c, m) => funding[m] + revenue[m] - c);
  const cash = zeros();
  let acc = plan.openingCash ?? 0;
  for (let m = 0; m < H; m++) cash[m] = acc += net[m];
  return { labor, headcount, nonLabor, burn, revenue, revenueByStream, funding, cost, net, cash, unlocks };
}
