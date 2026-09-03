// Money over the schedule: labor by seats on payroll (busy or not), non-labor by funding
// year, burn while items run, revenue after the unlocking item completes, funding on its own
// clock, and the cash line that results. Monthly, in dollars, deterministic.

import { fundingYear, has, table, type Calendar, type Plan, type SeatDef } from "./model.js";
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

const finiteResult = (value: number, context: string): number => {
  if (!Number.isFinite(value)) throw new Error(`plangraph: non-finite ${context}`);
  return value;
};

const addFinite = (row: number[], month: number, value: number, context: string) => {
  row[month] = finiteResult(row[month] + value, `${context} at month ${month}`);
};

/** Loaded monthly cost of one seat, escalated from funding year 2. */
export function monthlyLoaded(plan: Plan, loadedAnnual: number, m: number): number {
  const y = Math.max(0, fundingYear(plan.calendar, m) - 1);
  return finiteResult((loadedAnnual * (1 + plan.escalation.rate) ** y) / 12, `monthly loaded cost at month ${m}`);
}

/** Loaded monthly cost of one seat in month m: its per-year schedule when it has one, else the escalated flat rate. */
export function seatMonthlyCost(plan: Plan, seat: SeatDef, m: number): number {
  const byYear = seat.loadedAnnualByYear;
  if (byYear && byYear.length > 0) {
    const y = Math.max(0, fundingYear(plan.calendar, m) - 1);
    const annual = byYear[Math.min(y, byYear.length - 1)];
    return finiteResult(annual / 12, `monthly loaded cost of "${seat.id}" at month ${m}`);
  }
  return monthlyLoaded(plan, seat.loadedAnnual, m);
}

export function ledger(plan: Plan, s: Schedule): Ledger {
  const H = plan.calendar.horizonMonths;
  const zeros = () => new Array(H).fill(0) as number[];

  const labor = zeros();
  const headcount = zeros();
  for (const seat of plan.seats) {
    for (let m = 0; m < H; m++) {
      const n = seatsHired(s.hires[seat.id], m);
      addFinite(headcount, m, n, "headcount");
      addFinite(labor, m, n * seatMonthlyCost(plan, seat, m), "labor cost");
    }
  }

  const nonLabor = zeros();
  for (const line of plan.nonLabor) {
    for (let m = plan.calendar.fundingYearStartMonth; m < H; m++) {
      const y = fundingYear(plan.calendar, m);
      const v = line.byYear[Math.min(y, line.byYear.length) - 1] ?? 0;
      addFinite(nonLabor, m, v / 12, "non-labor cost");
    }
  }

  const burn = zeros();
  for (const it of s.items) {
    if (!it.item.burnPerMonth || it.beyond) continue;
    for (let m = it.start; m < it.end; m++) addFinite(burn, m, it.item.burnPerMonth.usd, "item burn");
  }

  const cost = labor.map((v, m) => finiteResult(v + nonLabor[m] + burn[m], `total cost at month ${m}`));

  const scale = s.scenario.volumeScale ?? 1;
  const byId = new Map(s.items.map((i) => [i.item.id, i]));
  const revenueByStream = table<number[]>();
  const unlocks = table<number | null>();
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
        const units = finiteResult(st.volumeByYear.units[Math.min(year, st.volumeByYear.units.length - 1)] * scale, `units for stream "${st.id}" at month ${m}`);
        const ramp = st.rampMonths > 0 && k < st.rampMonths ? (k + 1) / st.rampMonths : 1;
        row[m] = finiteResult((units / 12) * ramp * st.price.usd, `revenue for stream "${st.id}" at month ${m}`);
      }
    } else {
      unlocks[st.id] = null;
    }
    revenueByStream[st.id] = row;
    for (let m = 0; m < H; m++) addFinite(revenue, m, row[m], "total revenue");
  }

  const funding = zeros();
  const fundingByLine = table<number[]>();
  for (const f of plan.funding) {
    const counted = has(s.scenario.countFunding, f.id) ? s.scenario.countFunding![f.id] : f.counted;
    const row = counted ? f.byMonth.slice(0, H) : [];
    while (row.length < H) row.push(0);
    fundingByLine[f.id] = row;
    for (let m = 0; m < H; m++) addFinite(funding, m, row[m], "total funding");
  }

  const net = cost.map((c, m) => finiteResult(funding[m] + revenue[m] - c, `net cash flow at month ${m}`));
  const cash = zeros();
  let acc = finiteResult(plan.openingCash ?? 0, "opening cash");
  for (let m = 0; m < H; m++) {
    acc = finiteResult(acc + net[m], `cash at month ${m}`);
    cash[m] = acc;
  }

  return { labor, nonLabor, burn, cost, revenue, revenueByStream, funding, fundingByLine, net, cash, headcount, unlocks };
}

export const sumRange = (row: number[], from: number, to: number): number => {
  let t = 0;
  for (let m = Math.max(0, from); m < Math.min(to, row.length); m++) t = finiteResult(t + row[m], `range total at month ${m}`);
  return t;
};

/** How many complete twelve-month funding years fit inside the horizon. */
export const fundingYears = (cal: Calendar): number =>
  Math.max(0, Math.floor((cal.horizonMonths - cal.fundingYearStartMonth) / 12));

/** Total before funding year 1 opens. */
export const beforeFunding = (row: number[], cal: Calendar): number =>
  sumRange(row, 0, Math.min(cal.fundingYearStartMonth, cal.horizonMonths));

/** Totals for complete funding years only. */
export function byFundingYear(row: number[], cal: Calendar, years = fundingYears(cal)): number[] {
  const count = Math.min(Math.max(0, Math.floor(years)), fundingYears(cal));
  const f = cal.fundingYearStartMonth;
  return Array.from({ length: count }, (_, k) => sumRange(row, f + 12 * k, f + 12 * (k + 1)));
}

/** Total after the final complete funding year, through the end of the horizon. */
export const afterFundingYears = (row: number[], cal: Calendar): number => {
  const from = cal.fundingYearStartMonth + 12 * fundingYears(cal);
  return sumRange(row, from, cal.horizonMonths);
};

/** Value at each requested funding-year end, or null when that endpoint is unavailable. */
export function atFundingYearEnd(row: number[], cal: Calendar, years = fundingYears(cal)): Array<number | null> {
  const count = Math.max(0, Math.floor(years));
  const f = cal.fundingYearStartMonth;
  return Array.from({ length: count }, (_, k) => {
    const month = f + 12 * k + 11;
    return month < cal.horizonMonths && month < row.length
      ? finiteResult(row[month], `funding year ${k + 1} endpoint`)
      : null;
  });
}

export const fmtUsd = (n: number): string =>
  Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : `$${Math.round(n / 1e3)}k`;
