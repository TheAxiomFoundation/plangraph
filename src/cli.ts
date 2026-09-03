#!/usr/bin/env node
// plangraph check <plan.json> [--scenario id] [--json]
//
// Schedules every scenario the plan carries (or the two defaults), prints the aggregates and
// the findings, and exits non-zero on errors. Run under `bun --watch` for feedback on save.

import { monthLabel, scenariosOf } from "./model.js";
import { loadPlanFile } from "./node.js";
import { PlanParseError } from "./parse.js";
import { report } from "./report.js";

const args = process.argv.slice(2);
const cmd = args[0];
const file = args[1];
const json = args.includes("--json");
const scenarioIndex = args.indexOf("--scenario");
const scenarioValue = scenarioIndex >= 0 ? args[scenarioIndex + 1] : undefined;

const oneLine = (value: unknown): string => {
  const message = value instanceof Error ? value.message : String(value);
  return message.replace(/\s+/g, " ").trim() || "unknown error";
};

const quit = (code: 1 | 2): never => {
  process.exit(code);
  throw new Error("unreachable");
};

const fail = (message: string, code: 1 | 2): never => {
  console.error(message);
  return quit(code);
};

const errorLine = (error: unknown): string => {
  const message = oneLine(error);
  return message.startsWith("plangraph:") ? message : `plangraph: ${message}`;
};

if (cmd !== "check" || !file || file.startsWith("--")) fail("usage: plangraph check <plan.json> [--scenario id] [--json]", 2);
if (scenarioIndex >= 0 && (!scenarioValue || scenarioValue.startsWith("--"))) fail("plangraph: --scenario requires an id", 2);
const only = scenarioIndex >= 0 ? scenarioValue : undefined;

const plan = (() => {
  try {
    return loadPlanFile(file);
  } catch (e) {
    if (e instanceof PlanParseError) {
      for (const problem of e.problems) console.error(`plangraph: ${oneLine(problem)}`);
      return quit(1);
    }
    return fail(errorLine(e), 1);
  }
})();

if (only && !scenariosOf(plan).some((scenario) => scenario.id === only)) {
  fail(`plangraph: unknown scenario ${JSON.stringify(only)}`, 2);
}

const r = (() => {
  try {
    return report(plan, only);
  } catch (e) {
    return fail(errorLine(e), 1);
  }
})();

const planErrors = r.planFindings.filter((finding) => finding.severity === "error");
if (planErrors.length) {
  for (const finding of planErrors) console.error(`plangraph: ${oneLine(`${finding.code} ${finding.subject} ${finding.message}`)}`);
  quit(1);
}

const M = (n: number) => (n / 1e6).toFixed(2).padStart(7);
const row = (label: string, xs: number[]) =>
  `  ${label.padEnd(24)}${xs.map(M).join(" ")}   | ${r.years}y ${(xs.reduce((a, b) => a + b, 0) / 1e6).toFixed(2)}`;

if (json) {
  const out = {
    plan: r.plan,
    years: r.years,
    errors: r.errors,
    planFindings: r.planFindings,
    scenarios: r.scenarios.map((s) => ({
      scenario: s.scenario.id,
      headcountByYearEnd: s.headcountByYearEnd,
      preFunding: s.preFunding,
      costByYear: s.costByYear,
      revenueByYear: s.revenueByYear,
      fundingByYear: s.fundingByYear,
      trailing: s.trailing,
      externalFteMonths: s.externalFteMonths,
      cashTrough: s.cashTrough,
      unlocks: s.unlocks,
      slips: s.slips,
      overloads: s.overloads,
      items: s.schedule.items.map((it) => ({
        id: it.item.id,
        start: it.beyond ? null : monthLabel(plan.calendar, it.start),
        end: it.beyond ? null : monthLabel(plan.calendar, it.end - 1),
        beyond: it.beyond,
        binding: it.binding,
      })),
      findings: s.findings,
    })),
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(r.errors ? 1 : 0);
}

const H = plan.calendar.horizonMonths;
const seats = plan.seats.reduce((n, s) => n + s.hireMonths.length, 0);
console.log(
  `plangraph · ${r.plan} · ${plan.items.length} items · ${plan.seats.length} roles (${seats} seats) · ${plan.streams.length} streams · ${plan.funding.length} funding lines · ${monthLabel(plan.calendar, 0)} → ${monthLabel(plan.calendar, H - 1)}`,
);
const yearHead = Array.from({ length: r.years }, (_, k) => `Y${k + 1}`.padStart(7)).join(" ");
for (const s of r.scenarios) {
  console.log(`\n▸ ${s.scenario.name} — ${s.scenario.gist}`);
  console.log(`  ${"".padEnd(24)}${yearHead}`);
  console.log(`  ${"Headcount at year end".padEnd(24)}${s.headcountByYearEnd.map((h) => String(h).padStart(7)).join(" ")}`);
  console.log(row("Cost ($M)", s.costByYear));
  console.log(row("Revenue", s.revenueByYear));
  console.log(row("Funding counted", s.fundingByYear));
  console.log(`  ${"External FTE-months".padEnd(24)}${s.externalFteMonths.toFixed(2)}`);
  console.log(`  ${"Cash trough".padEnd(24)}${(s.cashTrough.usd / 1e6).toFixed(2)}M in ${s.cashTrough.month}`);
  console.log(`  ${"Unlocks".padEnd(24)}${Object.entries(s.unlocks).map(([k, v]) => `${k} ${v ?? "never"}`).join(" · ") || "no streams"}`);
  const top = s.slips.slice(0, 8).map((x) => `${x.label} ${x.beyond ? "beyond horizon" : `+${x.months}`}`).join(" · ");
  console.log(`  ${"Slips vs baseline".padEnd(24)}${s.slips.length ? top : "none"}${s.slips.length > 8 ? ` · +${s.slips.length - 8} more` : ""}`);
  console.log(`  ${"Over capacity".padEnd(24)}${s.overloads.length ? s.overloads.slice(0, 5).map((o) => `${o.seat} ${o.months} mo (peak +${o.peak.toFixed(2)})`).join(" · ") : "none"}`);
  console.log(`  ${"Findings".padEnd(24)}${s.counts.error} errors · ${s.counts.warn} warnings · ${s.counts.info} info`);
  for (const f of s.findings.filter((x) => x.severity !== "info")) {
    console.log(`    ${f.code} ${f.subject.padEnd(12)} ${f.message}`);
    console.log(`         ${"".padEnd(12)} → ${f.hint}`);
  }
  for (const f of s.findings.filter((x) => x.severity === "info")) console.log(`    ${f.code} ${f.subject.padEnd(12)} ${f.message}`);
}
console.log(r.errors ? `\n✗ ${r.errors} error(s)` : "\n✓ no errors");
process.exit(r.errors ? 1 : 0);
