// Reading a plan from data. Plans are plain JSON so an agent or a person can write one
// without a build step. Parsing checks shape and reports every problem with its path; the
// harness then checks meaning.

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Basis, Plan } from "./model.js";

type Problem = string;

const BASES: Basis[] = ["D", "A", "M"];

export function parsePlan(input: unknown): Plan {
  const problems: Problem[] = [];
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  const str = (x: unknown) => typeof x === "string" && x.length > 0;
  const arr = (x: unknown): x is unknown[] => Array.isArray(x);
  const need = (ok: boolean, path: string, what: string) => {
    if (!ok) problems.push(`${path}: ${what}`);
  };
  const basis = (x: unknown, path: string) => need(BASES.includes(x as Basis), path, `basis must be one of ${BASES.join(", ")}`);
  const tagged = (x: unknown, path: string, key: string) => {
    need(isObj(x), path, "must be an object");
    if (!isObj(x)) return;
    need(key === "units" ? arr(x.units) && (x.units as unknown[]).every(num) : num(x[key]), `${path}.${key}`, key === "units" ? "must be an array of numbers" : "must be a number");
    basis(x.basis, `${path}.basis`);
    need(typeof x.note === "string", `${path}.note`, "must be a string");
  };

  need(isObj(input), "plan", "must be an object");
  if (!isObj(input)) throw new Error(`plangraph: ${problems.join("; ")}`);
  const p = input;

  need(str(p.name), "plan.name", "must be a non-empty string");
  need(isObj(p.calendar), "plan.calendar", "must be an object");
  if (isObj(p.calendar)) {
    const c = p.calendar;
    need(num(c.startYear), "plan.calendar.startYear", "must be a number");
    need(num(c.startMonth) && (c.startMonth as number) >= 1 && (c.startMonth as number) <= 12, "plan.calendar.startMonth", "must be 1..12");
    need(num(c.horizonMonths) && (c.horizonMonths as number) >= 1, "plan.calendar.horizonMonths", "must be a positive number");
    need(num(c.fundingYearStartMonth) && (c.fundingYearStartMonth as number) >= 0, "plan.calendar.fundingYearStartMonth", "must be a month index");
  }
  need(arr(p.circles) && (p.circles as unknown[]).every(str), "plan.circles", "must be an array of circle names");
  need(isObj(p.escalation) && num((p.escalation as Record<string, unknown>).rate), "plan.escalation", "must be { rate, basis }");
  if (isObj(p.escalation)) basis(p.escalation.basis, "plan.escalation.basis");

  const list = (key: string) => {
    need(arr(p[key]), `plan.${key}`, "must be an array");
    return arr(p[key]) ? (p[key] as unknown[]) : [];
  };

  list("seats").forEach((s, i) => {
    const path = `plan.seats[${i}]`;
    if (!isObj(s)) return need(false, path, "must be an object");
    need(str(s.id), `${path}.id`, "must be a non-empty string");
    need(str(s.title), `${path}.title`, "must be a non-empty string");
    need(num(s.loadedAnnual) && (s.loadedAnnual as number) >= 0, `${path}.loadedAnnual`, "must be a non-negative number");
    basis(s.costBasis, `${path}.costBasis`);
    need(arr(s.hireMonths) && (s.hireMonths as unknown[]).every(num), `${path}.hireMonths`, "must be an array of month indices");
    need(num(s.capacityFte), `${path}.capacityFte`, "must be a number");
    need(s.fallback === null || s.fallback === "external" || str(s.fallback), `${path}.fallback`, 'must be a seat id, "external", or null');
  });

  list("items").forEach((it, i) => {
    const path = `plan.items[${i}]`;
    if (!isObj(it)) return need(false, path, "must be an object");
    need(str(it.id), `${path}.id`, "must be a non-empty string");
    need(str(it.lane), `${path}.lane`, "must be a non-empty string");
    need(str(it.label), `${path}.label`, "must be a non-empty string");
    need(str(it.circle), `${path}.circle`, "must be a circle name");
    need(num(it.earliest), `${path}.earliest`, "must be a month index");
    need(num(it.duration), `${path}.duration`, "must be a number of months");
    need(typeof it.standing === "boolean", `${path}.standing`, "must be a boolean");
    need(typeof it.underway === "boolean", `${path}.underway`, "must be a boolean");
    need(arr(it.predecessors), `${path}.predecessors`, "must be an array");
    if (arr(it.predecessors)) it.predecessors.forEach((pr, j) => need(isObj(pr) && str(pr.id) && (pr.lag === undefined || num(pr.lag)), `${path}.predecessors[${j}]`, "must be { id, lag? }"));
    need(arr(it.demands), `${path}.demands`, "must be an array");
    if (arr(it.demands)) it.demands.forEach((d, j) => {
      need(isObj(d) && str(d.seat) && num(d.fte), `${path}.demands[${j}]`, "must be { seat, fte, basis }");
      if (isObj(d)) basis(d.basis, `${path}.demands[${j}].basis`);
    });
    if (it.burnPerMonth !== undefined) tagged(it.burnPerMonth, `${path}.burnPerMonth`, "usd");
  });

  list("streams").forEach((st, i) => {
    const path = `plan.streams[${i}]`;
    if (!isObj(st)) return need(false, path, "must be an object");
    need(str(st.id), `${path}.id`, "must be a non-empty string");
    need(str(st.label), `${path}.label`, "must be a non-empty string");
    need(str(st.unlockedBy), `${path}.unlockedBy`, "must be an item id");
    need(str(st.unit), `${path}.unit`, "must be a non-empty string");
    tagged(st.price, `${path}.price`, "usd");
    tagged(st.volumeByYear, `${path}.volumeByYear`, "units");
    need(num(st.rampMonths) && (st.rampMonths as number) >= 0, `${path}.rampMonths`, "must be a non-negative number");
  });

  list("funding").forEach((f, i) => {
    const path = `plan.funding[${i}]`;
    if (!isObj(f)) return need(false, path, "must be an object");
    need(str(f.id), `${path}.id`, "must be a non-empty string");
    need(str(f.label), `${path}.label`, "must be a non-empty string");
    need(arr(f.byMonth) && (f.byMonth as unknown[]).every(num), `${path}.byMonth`, "must be an array of numbers");
    basis(f.basis, `${path}.basis`);
    need(typeof f.counted === "boolean", `${path}.counted`, "must be a boolean");
  });

  list("nonLabor").forEach((n, i) => {
    const path = `plan.nonLabor[${i}]`;
    if (!isObj(n)) return need(false, path, "must be an object");
    need(str(n.id), `${path}.id`, "must be a non-empty string");
    need(arr(n.byYear) && (n.byYear as unknown[]).every(num), `${path}.byYear`, "must be an array of numbers");
    basis(n.basis, `${path}.basis`);
  });

  if (p.scenarios !== undefined) {
    need(arr(p.scenarios), "plan.scenarios", "must be an array");
    if (arr(p.scenarios)) p.scenarios.forEach((sc, i) => {
      const path = `plan.scenarios[${i}]`;
      need(isObj(sc) && str(sc.id) && str(sc.name) && typeof sc.level === "boolean", path, "must be { id, name, gist, level, ... }");
    });
  }

  if (problems.length) throw new Error(`plangraph: the plan does not parse:\n  ${problems.join("\n  ")}`);
  return p as unknown as Plan;
}

/** Read a plan from a .json, .yaml or .yml file. YAML is for people (comments carry provenance); JSON is the interchange. */
export function loadPlanFile(path: string): Plan {
  const text = readFileSync(path, "utf8");
  const data = /\.ya?ml$/i.test(path) ? parseYaml(text) : JSON.parse(text);
  return parsePlan(data);
}
