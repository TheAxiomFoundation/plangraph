import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AS_PLANNED, LEVELED, schedule, type Plan, type Scenario, type SeatDef, type WorkItem } from "../src/index";
import {
  BROAD,
  FALLBACKS,
  PLAIN,
  arbRawPlan,
  arbRawScenario,
  buildPlan,
  buildScenario,
  compactPlan,
  compactScenario,
  scheduleLine,
  type GenOpts,
  type RawPlan,
  type RawScenario,
} from "./property/arbitraries";
import { RELAX, later } from "./property/relaxations";
import { Admission, TIMEOUT, expectCoverage, holds } from "./property/run";

// P3, monotonicity AS PLANNED: relaxing an input (more staff, sooner; less work; fewer
// dependencies) never makes any item start later, and never newly puts an item beyond the
// horizon. As planned, a start is the latest of the declared month and the predecessors'
// readiness (README "Scheduling"); hires, capacity and effort never enter it, and durations
// only shrink under these relaxations, so the property holds by construction. It is here as a
// guard: a change that let staffing leak into as-planned starts would break it.
//
// LEVELED schedules are NOT monotone, and nothing promises they are: the README says the
// scheduler "is a serial heuristic, not an optimizer". Leveling books items one at a time in
// priority order, so a relaxation that lets an earlier item start sooner can take the room a
// later item was using: the list-scheduling anomalies Graham described for multiprocessor
// scheduling. At the suite's default seed, fast-check finds a leveled counterexample of one
// to six items for every relaxation below within 3000 runs (with an external fallback, even
// hiring earlier can push an item out: fallback is all-or-nothing). The last test records a
// three-item case, so the suite states the non-guarantee rather than implying one.

const FAMILIES: [string, GenOpts][] = [["PLAIN", PLAIN], ["FALLBACKS", FALLBACKS], ["BROAD", BROAD]];

/** Check one relaxation as planned over every generator family; returns how many runs moved some item earlier. */
function asPlannedMonotone(name: string): { runs: number; earlier: number } {
  const relax = RELAX[name];
  let runs = 0;
  let earlier = 0;
  for (const [family, gen] of FAMILIES) {
    const admission = new Admission();
    const build = ([rp, rs, a, b]: [RawPlan, RawScenario, number, number]) => {
      const plan = buildPlan(rp);
      const sc = buildScenario(plan, rs);
      return { plan, sc, change: relax(plan, sc, a, b) };
    };
    const result = holds(
      fc.tuple(arbRawPlan(gen), arbRawScenario({ level: false, overrides: family === "BROAD" }), fc.nat(7), fc.nat(7)),
      (raw) => {
        const { plan, sc, change } = build(raw);
        admission.admit(plan, sc);
        fc.pre(change !== null);
        admission.admit(change!.plan, change!.sc);
        const before = schedule(plan, sc);
        const after = schedule(change!.plan, change!.sc);
        if (later(after, before).length) earlier++;
        return later(before, after).length === 0;
      },
      (raw) => {
        const { plan, sc, change } = build(raw);
        const before = schedule(plan, sc);
        const after = schedule(change!.plan, change!.sc);
        return [
          `family:   ${family}`,
          `plan:     ${JSON.stringify(compactPlan(plan))}`,
          `scenario: ${JSON.stringify(compactScenario(sc))}`,
          `relax:    ${change!.what}`,
          `before:   ${scheduleLine(before)}`,
          `after:    ${scheduleLine(after)}`,
          `later:    ${later(before, after).join("; ")}`,
        ].join("\n");
      },
      { maxSkipsPerRun: 1000 },
    );
    admission.expectFewSkipped();
    runs += result.numRuns;
  }
  return { runs, earlier };
}

describe("P3 monotonicity as planned: a relaxation never makes an item later or newly beyond the horizon", () => {
  // Relaxations that cannot move an as-planned start at all: staffing and effort never enter it.
  for (const name of ["hire earlier", "add a hire", "scale effort down", "halve one demand", "add capacity", "drop an item nothing depends on"]) {
    it(`after "${name}", no item starts later or newly falls beyond the horizon`, () => {
      asPlannedMonotone(name);
    }, TIMEOUT);
  }
  // Relaxations of time and dependencies, which do move starts earlier, so the check is not
  // vacuous: each floor is about a third of the share of runs that moved an item earlier.
  const floors: Record<string, number> = { "scale durations down": 0.1, "shorten one item": 0.05, "remove an edge": 0.15 };
  for (const [name, floor] of Object.entries(floors)) {
    it(`after "${name}", no item starts later or newly falls beyond the horizon`, () => {
      const { runs, earlier } = asPlannedMonotone(name);
      expectCoverage(`an item that "${name}" moved earlier`, earlier, runs, floor);
    }, TIMEOUT);
  }
});

describe("P3 does not hold for leveled schedules, and is not promised", () => {
  it("scaling effort down by 10% makes a leveled plan finish a month later (a list-scheduling anomaly)", () => {
    // One seat of capacity 1; a 0.3, b 0.75 for a month each, c 0.1 for two months.
    // Before: a takes month 0; b would make 1.05 there, so it moves to month 1; c fits months
    // 0-1 beside them (0.4, then 0.85). After x0.9: b (0.675) now fits month 0 beside a (0.945),
    // which leaves no room for c (1.035), so c moves to months 1-2 and the plan ends a month later.
    const seat: SeatDef = { id: "s0", title: "s0", loadedAnnual: 0, costBasis: "A", hireMonths: [0], capacityFte: 1, fallback: null };
    const work = (id: string, fte: number, duration: number): WorkItem => ({
      id, lane: "l", label: id, circle: "c0", earliest: 0, duration, standing: false, underway: false, predecessors: [],
      demands: [{ seat: "s0", fte, basis: "A" }],
    });
    const plan: Plan = {
      name: "effort anomaly",
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 4, fundingYearStartMonth: 0 },
      circles: ["c0"],
      seats: [seat],
      items: [work("a", 0.3, 1), work("b", 0.75, 1), work("c", 0.1, 2)],
      streams: [], funding: [], nonLabor: [],
      escalation: { rate: 0, basis: "A" },
    };
    const runs = (sc: Scenario) => Object.fromEntries(schedule(plan, sc).items.map((s) => [s.item.id, [s.start, s.end]]));
    const end = (sc: Scenario) => Math.max(...schedule(plan, sc).items.map((s) => s.end));

    expect(runs(LEVELED)).toEqual({ a: [0, 1], b: [1, 2], c: [0, 2] });
    expect(runs({ ...LEVELED, effortScale: 0.9 })).toEqual({ a: [0, 1], b: [0, 1], c: [1, 3] });
    expect(end(LEVELED)).toBe(2);
    expect(end({ ...LEVELED, effortScale: 0.9 })).toBe(3);
    // As planned, the same relaxation moves nothing.
    expect(runs(AS_PLANNED)).toEqual(runs({ ...AS_PLANNED, effortScale: 0.9 }));
  });
});
