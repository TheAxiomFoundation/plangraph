import { describe, expect, it } from "vitest";
import {
  AS_PLANNED,
  LEVELED,
  lintSubstitutions,
  report,
  schedule,
  tightenedFrom,
  tightens,
  type Plan,
  type Scenario,
  type SeatDef,
  type WorkItem,
} from "../src/index";

// Leveling is a serial heuristic, so it is not monotone: a scenario that only takes room away
// can still start some item earlier, because work it delays leaves room that the item takes
// (the timing anomalies of list scheduling). W117 says so on the tighter scenario, so a reader
// comparing the two does not credit a delay with a gain.

const role = (id: string, over: Partial<SeatDef> = {}): SeatDef => ({
  id,
  title: id,
  loadedAnnual: 12_000,
  costBasis: "A",
  hireMonths: [0],
  capacityFte: 1,
  fallback: null,
  ...over,
});

const work = (id: string, earliest: number, duration: number, fte: number, over: Partial<WorkItem> = {}): WorkItem => ({
  id,
  lane: "lane",
  label: id,
  circle: "core",
  earliest,
  duration,
  standing: false,
  predecessors: [],
  demands: [{ seat: "s0", fte, basis: "A" }],
  underway: false,
  ...over,
});

const fixture = (over: Partial<Plan> = {}): Plan => ({
  name: "substitution fixture",
  calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
  circles: ["core"],
  seats: [role("s0")],
  items: [],
  streams: [],
  funding: [],
  nonLabor: [],
  escalation: { rate: 0, basis: "A" },
  ...over,
});

const scenario = (id: string, over: Partial<Scenario> = {}): Scenario => ({ id, name: id, gist: "", level: true, ...over });

/** The hire of s0 (two FTE) moved one month later lets b start three months sooner. */
const hirePlan = (): Plan =>
  fixture({
    calendar: { startYear: 2027, startMonth: 1, horizonMonths: 15, fundingYearStartMonth: 0 },
    seats: [role("s0", { hireMonths: [6], capacityFte: 2 })],
    items: [work("a", 8, 4, 0.3), work("b", 9, 3, 0.25), work("c", 1, 1, 1.5), work("d", 0, 5, 1)],
  });

describe("tightens: one scenario takes room away from another and gives none back", () => {
  const plan = fixture({
    seats: [role("s0", { hireMonths: [0, 4] }), role("fb", { hireMonths: [2, 6], fallback: "s0" }), role("ext", { hireMonths: [3], fallback: "external" })],
    items: [work("a", 0, 2, 1), work("b", 0, 2, 1)],
  });
  const base = scenario("base");

  it("counts leveling, more effort, longer runs and the same dropped items as tighter", () => {
    expect(tightens(plan, AS_PLANNED, LEVELED)).toBe(true);
    expect(tightens(plan, LEVELED, AS_PLANNED)).toBe(false);
    expect(tightens(plan, base, scenario("more", { effortScale: 1.2 }))).toBe(true);
    expect(tightens(plan, base, scenario("less", { effortScale: 0.9 }))).toBe(false);
    expect(tightens(plan, base, scenario("longer", { durationScale: 1.5 }))).toBe(true);
    expect(tightens(plan, base, scenario("shorter", { durationScale: 0.75 }))).toBe(false);
    expect(tightens(plan, scenario("x", { dropItems: ["a"] }), scenario("y", { dropItems: ["a"] }))).toBe(true);
    // Dropping an item frees its room and strands its dependents: neither tighter nor looser.
    expect(tightens(plan, base, scenario("drop", { dropItems: ["a"] }))).toBe(false);
    expect(tightens(plan, scenario("drop", { dropItems: ["a"] }), base)).toBe(false);
  });

  it("ignores what does not touch the schedule", () => {
    const money = scenario("money", { volumeScale: 0.5, countFunding: { none: false } });
    expect(tightens(plan, base, money) && tightens(plan, money, base)).toBe(true);
  });

  it("counts a later or dropped hire on a role that falls back to nobody", () => {
    expect(tightens(plan, base, scenario("late", { hireDelay: { s0: 2 } }))).toBe(true);
    expect(tightens(plan, base, scenario("one", { dropHires: { s0: [1] } }))).toBe(true);
    expect(tightens(plan, base, scenario("gone", { dropSeats: ["s0"] }))).toBe(true);
    expect(tightens(plan, base, scenario("early", { hireDelay: { s0: [0, -1] } }))).toBe(false);
  });

  it("counts a later hire on a role with a fallback only when its first hire stays put", () => {
    // Before its first hire, a role's work goes to its fallback, which may have more room, and
    // "external" has no limit; after it, all of it stays on the role.
    expect(tightens(plan, base, scenario("second", { hireDelay: { fb: [0, 3] } }))).toBe(true);
    expect(tightens(plan, base, scenario("first", { hireDelay: { fb: [1, 0] } }))).toBe(false);
    expect(tightens(plan, base, scenario("ext-late", { hireDelay: { ext: 1 } }))).toBe(false);
    expect(tightens(plan, base, scenario("ext-gone", { dropSeats: ["ext"] }))).toBe(false);
  });

  it("compares each scenario with the nearest ones it tightens, one per schedule", () => {
    const more = scenario("more", { effortScale: 1.2 });
    const most = scenario("most", { effortScale: 1.2, hireDelay: { s0: 2 } });
    const money = scenario("money", { volumeScale: 0.5 });
    const all = [AS_PLANNED, base, money, more, most];
    expect(tightenedFrom(plan, all, most).map((s) => s.id)).toEqual(["more"]);
    // base and money schedule alike: the first listed stands for both.
    expect(tightenedFrom(plan, all, more).map((s) => s.id)).toEqual(["base"]);
    expect(tightenedFrom(plan, all, base).map((s) => s.id)).toEqual(["as-planned"]);
    expect(tightenedFrom(plan, all, money).map((s) => s.id)).toEqual(["as-planned"]);
    expect(tightenedFrom(plan, all, AS_PLANNED)).toEqual([]);
  });
});

describe("W117: an item that starts earlier in a scenario that only tightens another", () => {
  it("names the item, both starts, and the load that left the seat it waited for", () => {
    const plan = hirePlan();
    const looser = scenario("lv", { name: "Leveled" });
    const tighter = scenario("late", { name: "Hire a month later", hireDelay: { s0: 1 } });
    // Hiring later holds d back a month; c, which waited behind d, lands a month later too, and
    // b, which waited for c's month, takes months 9-11 at once.
    const starts = (sc: Scenario) => Object.fromEntries(schedule(plan, sc).items.map((x) => [x.item.id, x.start]));
    expect(starts(looser)).toEqual({ a: 8, b: 12, c: 11, d: 6 });
    expect(starts(tighter)).toEqual({ a: 8, b: 9, c: 12, d: 7 });
    expect(lintSubstitutions(plan, schedule(plan, tighter), schedule(plan, looser))).toEqual([
      {
        code: "W117",
        severity: "info",
        subject: "b",
        message: '"b" starts 3 months earlier here (2027-10) than under "Leveled" (2028-01), though this scenario only tightens that one.',
        hint: 'Under "Leveled" it waited for room on s0; here "c" put less there from 2027-10 to 2027-12. Leveling is a serial heuristic: work a tighter scenario delays can leave room that this item takes. Read the move as a side effect of the scenario, not a gain.',
      },
    ]);
  });

  it("fires on more effort too, and says when an item it waited for ends earlier", () => {
    // Effort 0.9 lets b squeeze into month 0 beside a, which leaves no room for c; at full effort
    // b moves to month 1 and c takes months 0-1. e follows c.
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 6, fundingYearStartMonth: 0 },
      items: [work("a", 0, 1, 0.3), work("b", 0, 1, 0.75), work("c", 0, 2, 0.1), work("e", 0, 1, 0.1, { predecessors: [{ id: "c" }] })],
    });
    const looser = scenario("light", { name: "Lighter", effortScale: 0.9 });
    const found = lintSubstitutions(plan, schedule(plan, LEVELED), schedule(plan, looser));
    expect(found.map((f) => [f.subject, f.message])).toEqual([
      ["c", '"c" starts 1 month earlier here (2027-01) than under "Lighter" (2027-02), though this scenario only tightens that one.'],
      ["e", '"e" starts 1 month earlier here (2027-03) than under "Lighter" (2027-04), though this scenario only tightens that one.'],
    ]);
    expect(found[0].hint).toMatch(/^Under "Lighter" it waited for room on s0; here "b" put less there in 2027-01\. /);
    expect(found[1].hint).toMatch(/^Under "Lighter" it waited for "c", which ends earlier here\. /);
  });

  it("appears in the tighter scenario's report, also when only that scenario is reported", () => {
    const plan: Plan = { ...hirePlan(), scenarios: [scenario("lv", { name: "Leveled" }), scenario("late", { name: "Hire a month later", hireDelay: { s0: 1 } })] };
    const full = report(plan);
    expect(full.scenarios[0].findings.filter((f) => f.code === "W117")).toEqual([]);
    const late = full.scenarios[1];
    expect(late.findings.filter((f) => f.code === "W117").map((f) => f.subject)).toEqual(["b"]);
    expect(late.counts.info).toBe(late.findings.filter((f) => f.severity === "info").length);
    expect(report(plan, "late").scenarios[0].findings.filter((f) => f.code === "W117")).toEqual(late.findings.filter((f) => f.code === "W117"));
  });

  it("stays silent as planned, where a tighter scenario never starts anything earlier", () => {
    const plan: Plan = { ...hirePlan(), scenarios: [AS_PLANNED, scenario("late", { level: false, hireDelay: { s0: 1 } })] };
    expect(report(plan).scenarios.flatMap((s) => s.findings).filter((f) => f.code === "W117")).toEqual([]);
  });

  it("stays silent between scenarios neither of which only tightens the other", () => {
    // Later hire but less effort: the pair says nothing about which change moved what.
    const plan: Plan = { ...hirePlan(), scenarios: [scenario("lv"), scenario("mixed", { hireDelay: { s0: 1 }, effortScale: 0.9 })] };
    expect(report(plan).scenarios.flatMap((s) => s.findings).filter((f) => f.code === "W117")).toEqual([]);
  });

  it("says an item fits inside the horizon only in the tighter scenario", () => {
    // In the looser scenario z, taken last, finds no room before the horizon. In the tighter one
    // the long item that filled s0 waits for h's later hire and then no longer fits at all, so
    // z has s0 to itself.
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 6, fundingYearStartMonth: 0 },
      seats: [role("s0"), role("h", { hireMonths: [0] })],
      items: [
        work("long", 0, 5, 1, { demands: [{ seat: "s0", fte: 1, basis: "A" }, { seat: "h", fte: 0.5, basis: "A" }] }),
        work("z", 0, 2, 1, { priority: 1 }),
      ],
    });
    const looser = scenario("lv", { name: "Leveled" });
    const tighter = scenario("late-h", { name: "H later", hireDelay: { h: 2 } });
    expect(schedule(plan, looser).items.map((x) => x.beyond)).toEqual([false, true]);
    const found = lintSubstitutions(plan, schedule(plan, tighter), schedule(plan, looser));
    expect(found.map((f) => f.message)).toEqual(['"z" fits inside the horizon here, from 2027-01, but not under "Leveled", though this scenario only tightens that one.']);
  });
});
