// Money over the schedule: labor by seats on payroll (busy or not), non-labor by funding
// year, burn while items run, revenue after the unlocking item completes, funding on its own
// clock, and the cash line that results. Monthly, in dollars, deterministic.

import { fundingYear, type Plan } from "./model.js";
import { seatsHired, type Schedule } from "./schedule.js";

export interface Ledger {
  labor: number[];
  nonLabor: number[];
  burn: number[];
  cost: number[];
  revenue: number[];
  revenueByStream: Record<string, number[]>;
  funding: number[];
  fundingByLine: Record<string, number[]>;
  net: number[];
  cash: number[];
  headcount: number[];
  /** Month index the stream turned on, or null when its unlocking item never completes. */
  unlocks: Record<string, number | null>;
}

/** Loaded monthly cost of one seat, escalated from funding year 2. */
export function monthlyLoaded(plan: Plan, loadedAnnual: number, m: number): number {
  const y = Math.max(0, fundingYear(plan.calendar, m) - 1);
  return (loadedAnnual * (1 + plan.escalation.rate) ** y) / 12;
}

export function ledger(plan: Plan, s: Schedule): Ledger {
  const H = plan.calendar.horizonMonths;
  const zeros = () => new Array(H).fill(0) as number[];

  const labor = zeros();
  const headcount = zeros();
  for (const seat of plan.seats) {
    for (let m = 0; m < H; m++) {
      const n = seatsHired(s.hires[seat.id], m);
      headcount[m] += n;
      labor[m] += n * monthlyLoaded(plan, seat.loadedAnnual, m);
    }
  }

  const nonLabor = zeros();
  for (const line of plan.nonLabor) {
    for (let m = plan.calendar.fundingYearStartMonth; m < H; m++) {
      const y = fundingYear(plan.calendar, m);
      const v = line.byYear[Math.min(y, line.byYear.length) - 1] ?? 0;
      nonLabor[m] += v / 12;
    }
  }

  const burn = zeros();
  for (const it of s.items) {
    if (!it.item.burnPerMonth || it.beyond) continue;
    for (let m = it.start; m < it.end; m++) burn[m] += it.item.burnPerMonth.usd;
  }

  const cost = labor.map((v, m) => v + nonLabor[m] + burn[m]);

  const scale = s.scenario.volumeScale ?? 1;
  const byId = new Map(s.items.map((i) => [i.item.id, i]));
  const revenueByStream: Record<string, number[]> = {};
  const unlocks: Record<string, number | null> = {};
  const revenue = zeros();
  for (const st of plan.streams) {
    const it = byId.get(st.unlockedBy);
    if (!it) throw new Error(`plangraph: stream "${st.id}" is unlocked by unknown item "${st.unlockedBy}"`);
    const on = it.beyond ? H : it.item.standing ? it.start : it.end;
    const row = zeros();
    if (on < H) {
      unlocks[st.id] = on;
      for (let m = on; m < H; m++) {
        const k = m - on;
        const year = Math.floor(k / 12);
        const units = st.volumeByYear.units[Math.min(year, st.volumeByYear.units.length - 1)] * scale;
        const ramp = st.rampMonths > 0 && k < st.rampMonths ? (k + 1) / st.rampMonths : 1;
        row[m] = (units / 12) * ramp * st.price.usd;
      }
    } else {
      unlocks[st.id] = null;
    }
    revenueByStream[st.id] = row;
    for (let m = 0; m < H; m++) revenue[m] += row[m];
  }

  const funding = zeros();
  const fundingByLine: Record<string, number[]> = {};
  for (const f of plan.funding) {
    const counted = s.scenario.countFunding?.[f.id] ?? f.counted;
    const row = counted ? f.byMonth.slice(0, H) : [];
    while (row.length < H) row.push(0);
    fundingByLine[f.id] = row;
    for (let m = 0; m < H; m++) funding[m] += row[m];
  }

  const net = cost.map((c, m) => funding[m] + revenue[m] - c);
  const cash = zeros();
  let acc = 0;
  for (let m = 0; m < H; m++) {
    acc += net[m];
    cash[m] = acc;
  }

  return { labor, nonLabor, burn, cost, revenue, revenueByStream, funding, fundingByLine, net, cash, headcount, unlocks };
}

export const sumRange = (row: number[], from: number, to: number): number => {
  let t = 0;
  for (let m = Math.max(0, from); m < Math.min(to, row.length); m++) t += row[m];
  return t;
};

/** Totals by funding year 1..years. */
export function byFundingYear(plan: Plan, row: number[], years = 5): number[] {
  const f = plan.calendar.fundingYearStartMonth;
  return Array.from({ length: years }, (_, k) => sumRange(row, f + 12 * k, f + 12 * (k + 1)));
}

/** Value at the last month of each funding year 1..years. */
export function atFundingYearEnd(plan: Plan, row: number[], years = 5): number[] {
  const f = plan.calendar.fundingYearStartMonth;
  return Array.from({ length: years }, (_, k) => row[Math.min(f + 12 * k + 11, row.length - 1)] ?? 0);
}

/** How many funding years fit inside the horizon. */
export const fundingYears = (plan: Plan): number =>
  Math.max(1, Math.floor((plan.calendar.horizonMonths - plan.calendar.fundingYearStartMonth) / 12));

export const fmtUsd = (n: number): string =>
  Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1e3)}k`;
