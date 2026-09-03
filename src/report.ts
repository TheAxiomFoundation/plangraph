// One report per scenario: the aggregates a planner reads first, then the findings. The CLI
// prints it; a program can take it as data.

import { atFundingYearEnd, byFundingYear, fundingYears, ledger, type Ledger } from "./economics";
import { countBy, lintAll, type Finding, type Severity } from "./lint";
import { monthLabel, scenariosOf, type Plan, type Scenario } from "./model";
import { overloads, schedule, slips, type Schedule, type Slip } from "./schedule";

export interface ScenarioReport {
  scenario: Scenario;
  schedule: Schedule;
  ledger: Ledger;
  headcountByYearEnd: number[];
  costByYear: number[];
  revenueByYear: number[];
  fundingByYear: number[];
  cashTrough: { usd: number; month: string };
  unlocks: Record<string, string | null>;
  slips: Slip[];
  overloads: { seat: string; months: number; peak: number; first: string }[];
  findings: Finding[];
  counts: Record<Severity, number>;
}

export interface Report {
  plan: string;
  years: number;
  scenarios: ScenarioReport[];
  errors: number;
}

export function report(plan: Plan, only?: string): Report {
  const years = fundingYears(plan);
  const all = scenariosOf(plan);
  const base = schedule(plan, all[0]);
  const out: ScenarioReport[] = [];
  for (const sc of all) {
    if (only && sc.id !== only) continue;
    const s = schedule(plan, sc);
    const l = ledger(plan, s);
    const findings = lintAll(plan, s, l);
    const trough = Math.min(...l.cash);
    out.push({
      scenario: sc,
      schedule: s,
      ledger: l,
      headcountByYearEnd: atFundingYearEnd(plan, l.headcount, years),
      costByYear: byFundingYear(plan, l.cost, years),
      revenueByYear: byFundingYear(plan, l.revenue, years),
      fundingByYear: byFundingYear(plan, l.funding, years),
      cashTrough: { usd: trough, month: monthLabel(plan.calendar, l.cash.indexOf(trough)) },
      unlocks: Object.fromEntries(Object.entries(l.unlocks).map(([k, v]) => [k, v === null ? null : monthLabel(plan.calendar, v)])),
      slips: slips(base, s),
      overloads: overloads(s).map((o) => ({ seat: o.seat, months: o.months.length, peak: o.peak, first: monthLabel(plan.calendar, o.months[0]) })),
      findings,
      counts: countBy(findings),
    });
  }
  return { plan: plan.name, years, scenarios: out, errors: out.reduce((n, r) => n + r.counts.error, 0) };
}
