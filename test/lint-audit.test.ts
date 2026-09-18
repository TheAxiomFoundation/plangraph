import { describe, expect, it } from "vitest";
import {
  AS_PLANNED,
  ledger,
  lintSchedule,
  report,
  schedule,
  type Finding,
  type Plan,
  type SeatDef,
  type WorkItem,
} from "../src/index";

const role = (id: string, over: Partial<SeatDef> = {}): SeatDef => ({
  id,
  title: id,
  loadedAnnual: 0,
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
  owner: "x",
  earliest: 0,
  duration: 1,
  standing: false,
  predecessors: [],
  demands: [{ seat: "x", fte: 1, basis: "A" }],
  underway: false,
  ...over,
});

const fixture = (over: Partial<Plan> = {}): Plan => ({
  name: "lint audit fixture",
  calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
  circles: ["core"],
  escalation: { rate: 0, basis: "A" },
  seats: [role("x")],
  items: [],
  streams: [],
  funding: [],
  nonLabor: [],
  scenarios: [AS_PLANNED],
  ...over,
});

const findings = (plan: Plan): Finding[] => {
  const result = schedule(plan, AS_PLANNED);
  return lintSchedule(plan, result, ledger(plan, result));
};

const finding = (plan: Plan, code: string, subject?: string): Finding | undefined =>
  findings(plan).find((item) => item.code === code && (subject === undefined || item.subject === subject));

describe("defensive lint audit", () => {
  it("D8 uses actual capacity for W102 and states the measured utilization", () => {
    const idlePlan = (fte: number): Plan =>
      fixture({
        calendar: { startYear: 2027, startMonth: 1, horizonMonths: 6, fundingYearStartMonth: 0 },
        seats: [role("x", { capacityFte: 0.5, hireMonths: [1] })],
        items: [work("light", { earliest: 1, standing: true, demands: [{ seat: "x", fte, basis: "A" }] })],
      });

    const sixteenPercent = idlePlan(0.08);
    const sixteenSchedule = schedule(sixteenPercent, AS_PLANNED);
    expect(sixteenSchedule.loads[0].demand[1] / sixteenSchedule.loads[0].capacity[1]).toBeCloseTo(0.16, 12);
    expect(finding(sixteenPercent, "W102")).toBeUndefined();
    expect(finding({ ...sixteenPercent, lint: { idleLoadShare: 0.2 } }, "W102")).toBeDefined();

    const eightPercent = idlePlan(0.04);
    const warning = finding(eightPercent, "W102");
    expect(warning).toBeDefined();
    expect(warning!.message).toMatch(/8(?:\.0+)?%/);
    expect(finding({ ...eightPercent, lint: { idleMonths: 6 } }, "W102")).toBeUndefined();
  });

  it("D8 triggers W101 on a material two-month peak and honors both overload thresholds", () => {
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 4, fundingYearStartMonth: 0 },
      seats: [role("x")],
      items: [work("surge", { duration: 2, demands: [{ seat: "x", fte: 10, basis: "A" }] })],
    });

    const warning = finding(plan, "W101", "x");
    expect(warning).toBeDefined();
    expect(warning!.message).toMatch(/2 months/);
    expect(warning!.message).toMatch(/peak \+9(?:\.0+)? FTE/);
    expect(finding({ ...plan, lint: { overloadMonths: 3, overloadPeakFte: 10 } }, "W101")).toBeUndefined();
    expect(finding({ ...plan, lint: { overloadMonths: 2, overloadPeakFte: 10 } }, "W101")).toBeDefined();
  });

  it("A3 reports a two-month +0.8 overload left on a terminal fallback:null seat", () => {
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 4, fundingYearStartMonth: 0 },
      seats: [role("x", { hireMonths: [2], fallback: null })],
      items: [work("early", { duration: 2, demands: [{ seat: "x", fte: 0.8, basis: "A" }] })],
    });
    const result = schedule(plan, AS_PLANNED);
    const load = result.loads[0];

    expect(load.demand).toEqual([0.8, 0.8, 0, 0]);
    expect(load.capacity).toEqual([0, 0, 1, 1]);
    const warning = lintSchedule(plan, result, ledger(plan, result)).find((item) => item.code === "W101");
    expect(warning).toBeDefined();
    expect(warning!.message).toMatch(/2 months/);
    expect(warning!.message).toMatch(/peak \+0\.80 FTE/);
  });

  it("D8 uses the explicit owner for W109 regardless of demand order", () => {
    const widePlan = (reverse: boolean): Plan =>
      fixture({
        calendar: { startYear: 2027, startMonth: 1, horizonMonths: 4, fundingYearStartMonth: 0 },
        seats: [role("owner", { capacityFte: 10 }), role("helper", { capacityFte: 10 })],
        items: Array.from({ length: 4 }, (_, index) => {
          const demands = [
            { seat: "helper", fte: 0.1, basis: "A" as const },
            { seat: "owner", fte: 0.1, basis: "A" as const },
          ];
          return work(`item-${index}`, {
            owner: "owner",
            duration: 2,
            demands: reverse ? demands.reverse() : demands,
          });
        }),
      });

    const forward = findings(widePlan(false)).filter((item) => item.code === "W109");
    const reversed = findings(widePlan(true)).filter((item) => item.code === "W109");

    expect(forward).toEqual(reversed);
    expect(forward).toEqual([expect.objectContaining({ subject: "owner", message: expect.stringMatching(/owns 4 items/) })]);
    expect(finding({ ...widePlan(false), lint: { wideOwnerItems: 5 } }, "W109")).toBeUndefined();
  });

  it("A3 excludes 13.2 external FTE-months from W115 and reports them", () => {
    const plan = fixture({
      circles: ["core", "later"],
      seats: [role("vendor", { hireMonths: [12], capacityFte: 2, fallback: "external" })],
      items: [
        work("outsourced", {
          circle: "later",
          owner: "vendor",
          duration: 12,
          demands: [{ seat: "vendor", fte: 1.1, basis: "A" }],
        }),
      ],
    });

    const result = report(plan).scenarios[0];
    expect(result.externalFteMonths).toBeCloseTo(13.2, 12);
    expect(result.schedule.external.reduce((total, value) => total + value, 0)).toBeCloseTo(13.2, 12);
    expect(result.findings.some((item) => item.code === "W115")).toBe(false);
  });

  it("D8 counts internal last-circle bookings for W115 and honors its threshold", () => {
    const plan = fixture({
      circles: ["core", "later"],
      seats: [role("x", { capacityFte: 2 })],
      items: [work("internal", { circle: "later", duration: 12, demands: [{ seat: "x", fte: 1.1, basis: "A" }] })],
    });

    const warning = finding(plan, "W115", "later");
    expect(warning).toBeDefined();
    expect(warning!.message).toMatch(/13\.2 internal FTE-months/);
    expect(finding({ ...plan, lint: { lastCircleFteMonths: 14 } }, "W115")).toBeUndefined();
  });

  it("D8 does not call fully internal principal demand fallback load", () => {
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 4, fundingYearStartMonth: 0 },
      seats: [role("principal", { hireMonths: [0, 0], capacityFte: 1, fallback: null })],
      items: [
        work("owned", {
          owner: "principal",
          duration: 2,
          demands: [{ seat: "principal", fte: 2, basis: "A" }],
        }),
      ],
    });

    expect(finding(plan, "W116", "principal")).toBeUndefined();
  });

  it("D8 warns when a principal is above threshold on fallback load and states its share", () => {
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 4, fundingYearStartMonth: 0 },
      seats: [
        role("principal", { fallback: null }),
        role("worker", { hireMonths: [2], fallback: "principal" }),
      ],
      items: [
        work("bridge", {
          owner: "principal",
          duration: 2,
          demands: [
            { seat: "principal", fte: 1, basis: "A" },
            { seat: "worker", fte: 1, basis: "A" },
          ],
        }),
      ],
    });

    const warning = finding(plan, "W116", "principal");
    expect(warning).toBeDefined();
    expect(warning!.message).toMatch(/50(?:\.0+)?%/);
    expect(warning!.message).toMatch(/fallback/i);
    expect(finding({ ...plan, lint: { principalLoad: 2 } }, "W116", "principal")).toBeUndefined();
  });

  it("A10 uses configured late-owner, slip, assumed-revenue, and reference thresholds", () => {
    const lateOwner = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
      seats: [role("principal"), role("worker", { hireMonths: [6], fallback: "principal" })],
      items: [work("delegated", { owner: "worker", demands: [{ seat: "worker", fte: 0.1, basis: "A" }] })],
    });
    expect(finding(lateOwner, "W103", "delegated")).toBeDefined();
    expect(finding({ ...lateOwner, lint: { lateOwnerMonths: 7 } }, "W103", "delegated")).toBeUndefined();

    const slipped = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 8, fundingYearStartMonth: 0 },
      seats: [role("x")],
      items: [
        work("first", { duration: 3, demands: [{ seat: "x", fte: 0.1, basis: "A" }] }),
        work("second", {
          predecessors: [{ id: "first" }],
          demands: [{ seat: "x", fte: 0.1, basis: "A" }],
        }),
      ],
    });
    expect(finding(slipped, "W104", "second")).toBeDefined();
    expect(finding({ ...slipped, lint: { slipMonths: 4 } }, "W104", "second")).toBeUndefined();

    const assumedRevenue = fixture({
      items: [work("unlock", { demands: [{ seat: "x", fte: 0.1, basis: "A" }] })],
      streams: [
        {
          id: "sales",
          label: "Sales",
          unlockedBy: "unlock",
          unit: "sale",
          price: { usd: 10, basis: "A", note: "audit fixture" },
          volumeByYear: { units: [12], basis: "A", note: "audit fixture" },
          rampMonths: 0,
        },
      ],
    });
    expect(finding(assumedRevenue, "W106")).toBeDefined();
    expect(finding({ ...assumedRevenue, lint: { assumedRevenueShare: 1 } }, "W106")).toBeUndefined();

    const reference = fixture({
      reference: { headcountByYear: [1], gross: 1, nonLaborShare: [0, 1], note: "audit reference" },
    });
    expect(finding(reference, "W111")).toBeDefined();
    expect(finding({ ...reference, lint: { referenceCostTolerance: 1 } }, "W111")).toBeUndefined();
  });
});
