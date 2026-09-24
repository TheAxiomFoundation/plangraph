import { describe, expect, it } from "vitest";
import { AS_PLANNED, LEVELED, ledger, lintAll, overloads, schedule, type Plan, type Scenario, type SeatDef, type WorkItem } from "../src/index";

// Underway work books first (#5), so leveling counts its load; when that load keeps planned
// work out for good, the item goes beyond the horizon and its binding names the seat (#8).
// Either fix alone tells the planner something false about a plan like this one: without
// underway-first, the planned item lands on a seat that ends the month over capacity; without
// the binding fix, W104 blames the horizon for a run that fits it with months to spare.
//
// The shape is the Axiom plan's Researcher in miniature: a standing, underway item holds a
// quarter of the seat from month 1, and a planned item asks for 0.8 of it in its first quarter.

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

const work = (id: string, over: Partial<WorkItem> = {}): WorkItem => ({
  id,
  lane: "lane",
  label: id,
  circle: "core",
  earliest: 0,
  duration: 4,
  standing: false,
  predecessors: [],
  demands: [{ seat: "r", fte: 1, basis: "A" }],
  underway: false,
  ...over,
});

/** A standing, underway hold of 0.25 on r from month 1, and a planned item whose first quarter asks `first` of r. */
const researcher = (first: number): Plan => ({
  name: "researcher",
  calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
  circles: ["core", "later"],
  seats: [role("r", { title: "Researcher" })],
  items: [
    work("hold", { circle: "later", earliest: 1, standing: true, underway: true, demands: [{ seat: "r", fte: 0.25, basis: "A" }] }),
    work("fid", { label: "Fidelity", demands: [{ seat: "r", fte: first, profile: [first, 0.7], basis: "A" }] }),
    work("next", { earliest: 4, duration: 2, predecessors: [{ id: "fid" }], demands: [{ seat: "r", fte: 0.5, basis: "A" }] }),
  ],
  streams: [],
  funding: [],
  nonLabor: [],
  escalation: { rate: 0, basis: "A" },
});

const findings = (plan: Plan, scenario: Scenario) => {
  const s = schedule(plan, scenario);
  return lintAll(plan, s, ledger(plan, s));
};

describe("underway load that keeps planned work out, named by the seat", () => {
  it("sends the planned item beyond the horizon with its dependents, and W104 names the seat, not the horizon", () => {
    const plan = researcher(0.8);
    const s = schedule(plan, LEVELED);
    const at = (id: string) => s.items.find((x) => x.item.id === id)!;
    expect(at("hold")).toMatchObject({ start: 1, end: 12, binding: { kind: "underway" } });
    // 0.25 + 0.8 > 1 in every month of the first quarter of any start from month 1, and a start at
    // month 0 runs into month 1: no start has room, though a four-month run fits the horizon from
    // any start up to month 8.
    expect(at("fid")).toMatchObject({ beyond: true, binding: { kind: "capacity", seat: "r", carrier: "r" } });
    expect(at("next")).toMatchObject({ beyond: true, binding: { kind: "predecessor", id: "fid" } });
    expect(overloads(s)).toEqual([]);

    const w104 = findings(plan, LEVELED).filter((f) => f.code === "W104");
    expect(w104.find((f) => f.subject === "fid")!.message).toBe(
      '"Fidelity" does not fit inside the horizon: leveling found no start with room for it; the last seat without room was Researcher.',
    );
    expect(w104.map((f) => f.message).join("\n")).not.toMatch(/extend past the horizon/);
  });

  it("as planned, reports the same over-commitment instead of enforcing it", () => {
    const plan = researcher(0.8);
    const s = schedule(plan, AS_PLANNED);
    expect(s.items.find((x) => x.item.id === "fid")).toMatchObject({ start: 0, end: 4, beyond: false });
    expect(overloads(s)).toEqual([{ seat: "r", months: [1, 2], peak: expect.closeTo(0.05, 12) }]);
  });

  it("fits the planned item at once when its first quarter leaves room for the hold", () => {
    // 0.25 + 0.75 is exactly the seat's capacity.
    const plan = researcher(0.75);
    const s = schedule(plan, LEVELED);
    expect(s.items.find((x) => x.item.id === "fid")).toMatchObject({ start: 0, end: 4, beyond: false, binding: { kind: "declared" } });
    expect(s.items.find((x) => x.item.id === "next")).toMatchObject({ start: 4, end: 6, beyond: false });
    expect(overloads(s)).toEqual([]);
    expect(findings(plan, LEVELED).filter((f) => f.code === "W104")).toEqual([]);
  });
});
