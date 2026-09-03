// One report per scenario: the aggregates a planner reads first, then the findings. The CLI
// prints it; a program can take it as data.

import { afterFundingYears, atFundingYearEnd, beforeFunding, byFundingYear, fundingYears, ledger, sumRange, type Ledger } from "./economics.js";
import { countBy, lintPlan, lintSchedule, type Finding, type Severity } from "./lint.js";
import { monthLabel, scenariosOf, table, type Plan, type Scenario } from "./model.js";
import { overloads, schedule, slips, type Schedule, type Slip } from "./schedule.js";

export interface PeriodTotals {
  cost: number;
  revenue: number;
  funding: number;
}

export interface ScenarioReport {
  scenario: Scenario;
  schedule: Schedule;
  ledger: Ledger;
  headcountByYearEnd: Array<number | null>;
  preFunding: PeriodTotals;
  costByYear: number[];
  revenueByYear: number[];
  fundingByYear: number[];
  trailing: PeriodTotals;
  /** Uncosted, uncapped work routed to external carriers over the horizon. */
  externalFteMonths: number;
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
  planFindings: Finding[];
  scenarios: ScenarioReport[];
  errors: number;
}

export function report(plan: Plan, only?: string): Report {
  const cal = plan.calendar;
  const years = fundingYears(cal);
  const planFindings = lintPlan(plan);
  const planErrors = countBy(planFindings).error;
  if (planErrors > 0) return { plan: plan.name, years, planFindings, scenarios: [], errors: planErrors };

  const all = scenariosOf(plan);
  const selected = only ? all.find((scenario) => scenario.id === only) : undefined;
  if (only && !selected) throw new Error(`plangraph: unknown scenario "${only}"`);
  const base = schedule(plan, all[0]);
  const out: ScenarioReport[] = [];
  for (const sc of selected ? [selected] : all) {
    const s = sc === all[0] ? base : schedule(plan, sc);
    const l = ledger(plan, s);
    const findings = lintSchedule(plan, s, l);
    let trough = l.cash[0] ?? plan.openingCash ?? 0;
    let troughMonth = 0;
    for (let m = 1; m < l.cash.length; m++) {
      if (l.cash[m] < trough) {
        trough = l.cash[m];
        troughMonth = m;
      }
    }
    const unlocks = table<string | null>();
    for (const [id, month] of Object.entries(l.unlocks)) unlocks[id] = month === null ? null : monthLabel(plan.calendar, month);
    out.push({
      scenario: sc,
      schedule: s,
      ledger: l,
      headcountByYearEnd: atFundingYearEnd(l.headcount, cal, years),
      preFunding: {
        cost: beforeFunding(l.cost, cal),
        revenue: beforeFunding(l.revenue, cal),
        funding: beforeFunding(l.funding, cal),
      },
      costByYear: byFundingYear(l.cost, cal, years),
      revenueByYear: byFundingYear(l.revenue, cal, years),
      fundingByYear: byFundingYear(l.funding, cal, years),
      trailing: {
        cost: afterFundingYears(l.cost, cal),
        revenue: afterFundingYears(l.revenue, cal),
        funding: afterFundingYears(l.funding, cal),
      },
      externalFteMonths: sumRange(s.external, 0, s.external.length),
      cashTrough: { usd: trough, month: monthLabel(cal, troughMonth) },
      unlocks,
      slips: slips(base, s),
      overloads: overloads(s).map((o) => ({ seat: o.seat, months: o.months.length, peak: o.peak, first: monthLabel(plan.calendar, o.months[0]) })),
      findings,
      counts: countBy(findings),
    });
  }
  return { plan: plan.name, years, planFindings, scenarios: out, errors: planErrors + out.reduce((n, r) => n + r.counts.error, 0) };
}
