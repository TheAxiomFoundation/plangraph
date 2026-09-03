// Reading a plan from data. Plans are plain JSON or YAML so an agent or a person can write one
// without a build step. This module never touches the filesystem; loadPlanFile lives in node.ts. Parsing establishes the complete runtime shape and reports every
// problem with its path; the harness then checks graph-wide meaning.

import { parse as parseYaml } from "yaml";
import type { Basis, Plan } from "./model.js";

const BASES: Basis[] = ["D", "A", "M"];

export class PlanParseError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`plangraph: the plan does not parse:\n  ${problems.join("\n  ")}`);
    this.name = "PlanParseError";
    this.problems = problems;
  }
}

export function parsePlan(input: unknown): Plan {
  const problems: string[] = [];
  const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
  const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  const integer = (x: unknown): x is number => finite(x) && Number.isSafeInteger(x);
  const nonEmptyString = (x: unknown): x is string => typeof x === "string" && x.length > 0;
  const arr = (x: unknown): x is unknown[] => Array.isArray(x);
  const need = (ok: boolean, path: string, what: string) => {
    if (!ok) problems.push(`${path}: ${what}`);
  };
  const basis = (x: unknown, path: string) => need(BASES.includes(x as Basis), path, `must be one of ${BASES.join(", ")}`);
  const requiredString = (x: unknown, path: string, nonEmpty = false) =>
    need(typeof x === "string" && (!nonEmpty || x.length > 0), path, nonEmpty ? "must be a non-empty string" : "must be a string");
  const numberArray = (
    x: unknown,
    path: string,
    options: { nonEmpty?: boolean; integer?: boolean; min?: number } = {},
  ) => {
    need(arr(x), path, "must be an array");
    if (!arr(x)) return;
    if (options.nonEmpty) need(x.length > 0, path, "must be non-empty");
    for (let i = 0; i < x.length; i++) {
      const value = x[i];
      const rightKind = options.integer ? integer(value) : finite(value);
      const aboveMin = options.min === undefined || (finite(value) && value >= options.min);
      const kind = options.integer ? "a safe integer" : "a finite number";
      need(rightKind && aboveMin, `${path}[${i}]`, options.min === undefined ? `must be ${kind}` : `must be ${kind} >= ${options.min}`);
    }
  };
  const taggedNumber = (x: unknown, path: string, key: string) => {
    need(isObj(x), path, "must be an object");
    if (!isObj(x)) return;
    need(finite(x[key]), `${path}.${key}`, "must be a finite number");
    basis(x.basis, `${path}.basis`);
    requiredString(x.note, `${path}.note`);
  };

  need(isObj(input), "plan", "must be an object");
  if (!isObj(input)) throw new PlanParseError(problems);
  const p = input;

  requiredString(p.name, "plan.name", true);
  need(isObj(p.calendar), "plan.calendar", "must be an object");
  let horizon: number | undefined;
  if (isObj(p.calendar)) {
    const c = p.calendar;
    need(integer(c.startYear), "plan.calendar.startYear", "must be an integer");
    need(integer(c.startMonth) && c.startMonth >= 1 && c.startMonth <= 12, "plan.calendar.startMonth", "must be an integer from 1 through 12");
    need(
      integer(c.horizonMonths) && c.horizonMonths >= 1 && c.horizonMonths <= 0xffff_ffff,
      "plan.calendar.horizonMonths",
      "must be a safe integer from 1 through 4294967295",
    );
    if (integer(c.horizonMonths) && c.horizonMonths >= 1 && c.horizonMonths <= 0xffff_ffff) horizon = c.horizonMonths;
    need(
      integer(c.fundingYearStartMonth) && c.fundingYearStartMonth >= 0 && (horizon === undefined || c.fundingYearStartMonth < horizon),
      "plan.calendar.fundingYearStartMonth",
      "must be an integer inside the horizon",
    );
  }

  need(arr(p.circles), "plan.circles", "must be an array");
  if (arr(p.circles)) Array.from(p.circles).forEach((circle, i) => requiredString(circle, `plan.circles[${i}]`, true));

  need(isObj(p.escalation), "plan.escalation", "must be an object");
  if (isObj(p.escalation)) {
    need(finite(p.escalation.rate), "plan.escalation.rate", "must be a finite number");
    basis(p.escalation.basis, "plan.escalation.basis");
  }

  if (p.openingCash !== undefined) need(finite(p.openingCash), "plan.openingCash", "must be a finite number");

  if (p.reference !== undefined) {
    need(isObj(p.reference), "plan.reference", "must be an object");
    if (isObj(p.reference)) {
      numberArray(p.reference.headcountByYear, "plan.reference.headcountByYear", { nonEmpty: true, integer: true, min: 0 });
      need(finite(p.reference.gross) && p.reference.gross > 0, "plan.reference.gross", "must be a finite number > 0");
      need(arr(p.reference.nonLaborShare) && p.reference.nonLaborShare.length === 2, "plan.reference.nonLaborShare", "must contain exactly [low, high]");
      if (arr(p.reference.nonLaborShare)) {
        Array.from(p.reference.nonLaborShare).forEach((value, i) =>
          need(finite(value) && value >= 0 && value <= 1, `plan.reference.nonLaborShare[${i}]`, "must be a finite number from 0 through 1"),
        );
        if (
          p.reference.nonLaborShare.length === 2 &&
          finite(p.reference.nonLaborShare[0]) &&
          finite(p.reference.nonLaborShare[1])
        ) {
          need(p.reference.nonLaborShare[0] <= p.reference.nonLaborShare[1], "plan.reference.nonLaborShare", "low must be <= high");
        }
      }
      requiredString(p.reference.note, "plan.reference.note");
    }
  }

  const list = (key: string): unknown[] => {
    need(arr(p[key]), `plan.${key}`, "must be an array");
    return arr(p[key]) ? p[key] : [];
  };

  const seats = list("seats");
  Array.from(seats).forEach((seat, i) => {
    const path = `plan.seats[${i}]`;
    if (!isObj(seat)) return need(false, path, "must be an object");
    requiredString(seat.id, `${path}.id`, true);
    need(seat.id !== "external", `${path}.id`, '"external" is reserved for the external-carrier sentinel');
    requiredString(seat.title, `${path}.title`, true);
    need(finite(seat.loadedAnnual) && seat.loadedAnnual >= 0, `${path}.loadedAnnual`, "must be a finite number >= 0");
    if (seat.loadedAnnualByYear !== undefined) numberArray(seat.loadedAnnualByYear, `${path}.loadedAnnualByYear`, { nonEmpty: true, min: 0 });
    basis(seat.costBasis, `${path}.costBasis`);
    numberArray(seat.hireMonths, `${path}.hireMonths`, { integer: true, min: 0 });
    need(finite(seat.capacityFte), `${path}.capacityFte`, "must be a finite number");
    need(seat.fallback === null || seat.fallback === "external" || nonEmptyString(seat.fallback), `${path}.fallback`, 'must be a seat id, "external", or null');
  });

  const items = list("items");
  Array.from(items).forEach((item, i) => {
    const path = `plan.items[${i}]`;
    if (!isObj(item)) return need(false, path, "must be an object");
    requiredString(item.id, `${path}.id`, true);
    requiredString(item.lane, `${path}.lane`, true);
    requiredString(item.label, `${path}.label`);
    requiredString(item.circle, `${path}.circle`, true);
    if (item.owner !== undefined) requiredString(item.owner, `${path}.owner`, true);
    need(integer(item.earliest) && item.earliest >= 0 && (horizon === undefined || item.earliest < horizon), `${path}.earliest`, "must be an integer inside the horizon");
    need(integer(item.duration), `${path}.duration`, "must be an integer");
    need(typeof item.standing === "boolean", `${path}.standing`, "must be a boolean");
    if (item.standing === false) need(integer(item.duration) && item.duration >= 1, `${path}.duration`, "must be an integer >= 1 for non-standing work");
    need(typeof item.underway === "boolean", `${path}.underway`, "must be a boolean");
    need(arr(item.predecessors), `${path}.predecessors`, "must be an array");
    if (arr(item.predecessors)) {
      Array.from(item.predecessors).forEach((predecessor, j) => {
        const predecessorPath = `${path}.predecessors[${j}]`;
        if (!isObj(predecessor)) return need(false, predecessorPath, "must be an object");
        requiredString(predecessor.id, `${predecessorPath}.id`, true);
        if (predecessor.lag !== undefined) need(integer(predecessor.lag) && predecessor.lag >= 0, `${predecessorPath}.lag`, "must be an integer >= 0");
      });
    }
    need(arr(item.demands), `${path}.demands`, "must be an array");
    if (arr(item.demands)) {
      Array.from(item.demands).forEach((demand, j) => {
        const demandPath = `${path}.demands[${j}]`;
        if (!isObj(demand)) return need(false, demandPath, "must be an object");
        requiredString(demand.seat, `${demandPath}.seat`, true);
        need(finite(demand.fte), `${demandPath}.fte`, "must be a finite number");
        basis(demand.basis, `${demandPath}.basis`);
      });
    }
    if (item.burnPerMonth !== undefined) taggedNumber(item.burnPerMonth, `${path}.burnPerMonth`, "usd");
  });

  const streams = list("streams");
  Array.from(streams).forEach((stream, i) => {
    const path = `plan.streams[${i}]`;
    if (!isObj(stream)) return need(false, path, "must be an object");
    requiredString(stream.id, `${path}.id`, true);
    requiredString(stream.label, `${path}.label`);
    requiredString(stream.unlockedBy, `${path}.unlockedBy`, true);
    requiredString(stream.unit, `${path}.unit`, true);
    taggedNumber(stream.price, `${path}.price`, "usd");
    need(isObj(stream.volumeByYear), `${path}.volumeByYear`, "must be an object");
    if (isObj(stream.volumeByYear)) {
      numberArray(stream.volumeByYear.units, `${path}.volumeByYear.units`, { nonEmpty: true, min: 0 });
      basis(stream.volumeByYear.basis, `${path}.volumeByYear.basis`);
      requiredString(stream.volumeByYear.note, `${path}.volumeByYear.note`);
    }
    need(integer(stream.rampMonths) && stream.rampMonths >= 0, `${path}.rampMonths`, "must be an integer >= 0");
  });

  const funding = list("funding");
  Array.from(funding).forEach((line, i) => {
    const path = `plan.funding[${i}]`;
    if (!isObj(line)) return need(false, path, "must be an object");
    requiredString(line.id, `${path}.id`, true);
    requiredString(line.label, `${path}.label`);
    numberArray(line.byMonth, `${path}.byMonth`);
    basis(line.basis, `${path}.basis`);
    requiredString(line.note, `${path}.note`);
    need(typeof line.counted === "boolean", `${path}.counted`, "must be a boolean");
  });

  const nonLabor = list("nonLabor");
  Array.from(nonLabor).forEach((line, i) => {
    const path = `plan.nonLabor[${i}]`;
    if (!isObj(line)) return need(false, path, "must be an object");
    requiredString(line.id, `${path}.id`, true);
    requiredString(line.label, `${path}.label`);
    numberArray(line.byYear, `${path}.byYear`);
    basis(line.basis, `${path}.basis`);
    requiredString(line.note, `${path}.note`);
  });

  if (p.lint !== undefined) {
    need(isObj(p.lint), "plan.lint", "must be an object");
    if (isObj(p.lint)) {
      const integerThresholds = ["overloadMonths", "idleMonths", "lateOwnerMonths", "slipMonths", "wideOwnerItems"];
      for (const key of integerThresholds) {
        if (p.lint[key] !== undefined) need(integer(p.lint[key]) && p.lint[key] >= 0, `plan.lint.${key}`, "must be an integer >= 0");
      }
      for (const key of ["overloadPeakFte", "lastCircleFteMonths", "principalLoad"]) {
        if (p.lint[key] !== undefined) need(finite(p.lint[key]) && p.lint[key] >= 0, `plan.lint.${key}`, "must be a finite number >= 0");
      }
      for (const key of ["idleLoadShare", "assumedRevenueShare", "referenceCostTolerance"]) {
        if (p.lint[key] !== undefined) {
          need(
            finite(p.lint[key]) && p.lint[key] >= 0 && p.lint[key] <= 1,
            `plan.lint.${key}`,
            "must be a finite number from 0 through 1",
          );
        }
      }
    }
  }

  if (p.scenarios !== undefined) {
    need(arr(p.scenarios), "plan.scenarios", "must be an array");
    if (arr(p.scenarios)) {
      const seatIds = new Set(seats.filter(isObj).map((seat) => seat.id).filter(nonEmptyString));
      const fundingIds = new Set(funding.filter(isObj).map((line) => line.id).filter(nonEmptyString));
      Array.from(p.scenarios).forEach((scenario, i) => {
        const path = `plan.scenarios[${i}]`;
        if (!isObj(scenario)) return need(false, path, "must be an object");
        requiredString(scenario.id, `${path}.id`, true);
        requiredString(scenario.name, `${path}.name`, true);
        requiredString(scenario.gist, `${path}.gist`);
        need(typeof scenario.level === "boolean", `${path}.level`, "must be a boolean");
        for (const key of ["volumeScale", "durationScale", "effortScale"]) {
          if (scenario[key] !== undefined) need(finite(scenario[key]) && scenario[key] > 0, `${path}.${key}`, "must be a finite number > 0");
        }
        if (scenario.hireDelay !== undefined) {
          need(isObj(scenario.hireDelay), `${path}.hireDelay`, "must be an object");
          if (isObj(scenario.hireDelay)) {
            for (const key of Object.getOwnPropertyNames(scenario.hireDelay)) {
              need(seatIds.has(key), `${path}.hireDelay.${key}`, "must name a known seat");
              need(integer(scenario.hireDelay[key]), `${path}.hireDelay.${key}`, "must be an integer");
            }
          }
        }
        if (scenario.countFunding !== undefined) {
          need(isObj(scenario.countFunding), `${path}.countFunding`, "must be an object");
          if (isObj(scenario.countFunding)) {
            for (const key of Object.getOwnPropertyNames(scenario.countFunding)) {
              need(fundingIds.has(key), `${path}.countFunding.${key}`, "must name a known funding line");
              need(typeof scenario.countFunding[key] === "boolean", `${path}.countFunding.${key}`, "must be a boolean");
            }
          }
        }
      });
    }
  }

  if (problems.length) throw new PlanParseError(problems);
  return p as unknown as Plan;
}

/** Parse a plan from text. YAML is for people (comments carry provenance); JSON is the interchange. */
export function parsePlanText(text: string, format: "json" | "yaml" = "json"): Plan {
  return parsePlan(format === "yaml" ? parseYaml(text) : JSON.parse(text));
}
