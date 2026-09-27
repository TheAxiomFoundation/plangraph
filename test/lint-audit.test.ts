import { describe, expect, it } from "vitest";
import {
  AS_PLANNED,
  LEVELED,
  ledger,
  lintSchedule,
  report,
  schedule,
  type Finding,
  type Plan,
  type Scenario,
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

describe("a sum at a threshold, and the figure it prints, do not depend on the order it was added in", () => {
  // Priorities set the booking order, so each fixture is tried in every order of its items (or of
  // its seats, streams and lines). Each test first shows that the order moves the sum, or the
  // figure toFixed or Math.round made of it.
  const permutations = <T>(xs: T[]): T[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, k) => permutations([...xs.slice(0, k), ...xs.slice(k + 1)]).map((rest) => [x, ...rest]));
  const ORDERS = permutations([0, 1, 2]);
  const distinct = (values: number[]): number[] => [...new Set(values)].sort((a, b) => a - b);
  /** One item per [seat, FTE], booked in `order`. */
  const booked = (order: number[], demands: Array<[string, number]>, over: Partial<WorkItem> = {}): WorkItem[] =>
    demands.map(([seat, fte], k) => work(`i${k}`, { owner: seat, priority: order[k], demands: [{ seat, fte, basis: "A" }], ...over }));
  /** The messages a code gives across plans, each once; undefined where it gives none. */
  const messages = (plans: Plan[], code: string): Array<string | undefined> => [...new Set(plans.map((plan) => finding(plan, code)?.message))];
  const total = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
  const moneyOf = (plan: Plan) => ledger(plan, schedule(plan, AS_PLANNED));
  const salaried = (annuals: number[]): SeatDef[] => annuals.map((loadedAnnual, k) => role(`s${k}`, { loadedAnnual }));

  it("W102: a new hire at exactly the policy's share is not idle, whichever item books first", () => {
    // The case from the underway-first review: x, hired in month 1, carries 0.01 + 0.01 + 0.08 FTE.
    // Booked small first the load is 0.1; with the 0.08 first it is 0.09999999999999999.
    const make = (order: number[], lint: Plan["lint"] = {}): Plan =>
      fixture({ seats: [role("x", { hireMonths: [1] })], items: booked(order, [["x", 0.01], ["x", 0.01], ["x", 0.08]], { earliest: 1, standing: true }), lint });
    expect(distinct(ORDERS.map((o) => schedule(make(o), AS_PLANNED).loads[0].demand[1]))).toEqual([0.09999999999999999, 0.1]);
    expect(messages(ORDERS.map((o) => make(o)), "W102")).toEqual([undefined]);
    expect(messages(ORDERS.map((o) => make(o, { idleLoadShare: 0.11 })), "W102")).toEqual(["x hired 2027-02 peaks at 10% load for its first 11 months."]);

    // As the reviewer drew it, with the 0.08 underway. Here a, b and u book in id order, so the load
    // is 0.1 with or without the slack; the case guards the order in which underway work books first.
    const drawn = fixture({
      seats: [role("x", { hireMonths: [1] })],
      items: [
        work("a", { earliest: 1, standing: true, demands: [{ seat: "x", fte: 0.01, basis: "A" }] }),
        work("b", { earliest: 1, standing: true, demands: [{ seat: "x", fte: 0.01, basis: "A" }] }),
        work("u", { earliest: 1, standing: true, underway: true, demands: [{ seat: "x", fte: 0.08, basis: "A" }] }),
      ],
    });
    expect(finding(drawn, "W102")).toBeUndefined();
  });

  it("W102: the share it states rounds the same in every order", () => {
    // 0.0248 + 0.0165 + 0.0352 is 7.65% of the seat: 7.6% in some orders and 7.7% in others under toFixed.
    const make = (order: number[]): Plan =>
      fixture({ seats: [role("x", { hireMonths: [1] })], items: booked(order, [["x", 0.0248], ["x", 0.0165], ["x", 0.0352]], { earliest: 1, standing: true }) });
    const shares = ORDERS.map((o) => schedule(make(o), AS_PLANNED).loads[0].demand[1] * 100);
    expect(new Set(shares.map((share) => share.toFixed(1)))).toEqual(new Set(["7.6", "7.7"]));
    expect(messages(ORDERS.map((o) => make(o)), "W102")).toEqual(["x hired 2027-02 peaks at 7.7% load for its first 11 months."]);
  });

  it("W101: a peak at exactly the policy warns, and the peak it states rounds the same, in every order", () => {
    // 0.023 + 0.472 + 0.63 on one seat is 1.125 or 1.1249999999999998: +0.13 or +0.12 FTE under toFixed.
    const make = (order: number[], overloadPeakFte = 0.1): Plan =>
      fixture({ items: booked(order, [["x", 0.023], ["x", 0.472], ["x", 0.63]]), lint: { overloadPeakFte } });
    const peaks = ORDERS.map((o) => {
      const load = schedule(make(o), AS_PLANNED).loads[0];
      return load.demand[0] - load.capacity[0];
    });
    expect(new Set(peaks.map((peak) => peak.toFixed(2)))).toEqual(new Set(["0.12", "0.13"]));
    expect(messages(ORDERS.map((o) => make(o)), "W101")).toEqual(["x is over capacity in 1 months (peak +0.13 FTE), first in 2027-01."]);
    // A peak at exactly the policy's FTE warns in every order.
    expect(messages(ORDERS.map((o) => make(o, 0.125)), "W101")).toEqual(["x is over capacity in 1 months (peak +0.13 FTE), first in 2027-01."]);
  });

  it("W115: last-circle load at exactly the policy does not fire, and the load it states rounds the same, in every order", () => {
    // 0.157 FTE for 11 months, 0.218 for 11 and 3.3 for 3 come to 14.025 FTE-months. Added up in
    // booking order they are 14.024999999999999 or 14.025000000000002, which toFixed shows as 14.02 or 14.03.
    const durations = [11, 11, 3];
    const make = (order: number[], lint: Plan["lint"] = {}): Plan =>
      fixture({
        circles: ["core", "later"],
        seats: [role("x", { capacityFte: 4 })],
        items: booked(order, [["x", 0.157], ["x", 0.218], ["x", 3.3]], { circle: "later" }).map((it, k) => ({ ...it, duration: durations[k] })),
        lint,
      });
    const sums = ORDERS.map((o) => total(schedule(make(o), AS_PLANNED).bookings.map((b) => b.fte)));
    expect(distinct(sums)).toEqual([14.024999999999999, 14.025000000000002]);
    expect(new Set(sums.map((sum) => sum.toFixed(2)))).toEqual(new Set(["14.02", "14.03"]));
    expect(messages(ORDERS.map((o) => make(o, { lastCircleFteMonths: 14.025 })), "W115")).toEqual([undefined]);
    expect(messages(ORDERS.map((o) => make(o)), "W115")).toEqual(["14.03 internal FTE-months go to work in the last circle (later)."]);
  });

  it("W116: a principal at exactly the policy's load does not warn, and the load it states rounds the same, in every order", () => {
    // p carries its own item and, until w is hired, two of w's. 0.106 + 0.5 + 0.894 is 1.5 or
    // 1.5000000000000002 by order; 0.288 + 0.465 + 0.772 is 1.525 or 1.5250000000000001, which
    // toFixed shows as 1.52 or 1.53.
    const make = (order: number[], [a, b, c]: number[]): Plan =>
      fixture({ seats: [role("p"), role("w", { hireMonths: [6], fallback: "p" })], items: booked(order, [["w", a], ["p", b], ["w", c]]) });
    const loads = (ftes: number[]) => ORDERS.map((o) => schedule(make(o, ftes), AS_PLANNED).loads[0].demand[0]);
    expect(distinct(loads([0.106, 0.5, 0.894]))).toEqual([1.5, 1.5000000000000002]);
    expect(messages(ORDERS.map((o) => make(o, [0.106, 0.5, 0.894])), "W116")).toEqual([undefined]);
    expect(new Set(loads([0.288, 0.465, 0.772]).map((load) => load.toFixed(2)))).toEqual(new Set(["1.52", "1.53"]));
    expect(messages(ORDERS.map((o) => make(o, [0.288, 0.465, 0.772])), "W116")).toEqual([
      "p carries 1.53 FTE of demand in 2027-01; 69.5% is fallback for unfilled seats.",
    ]);
  });

  it("W116: of two months with the same load, the first is named, in every order", () => {
    // 1.5 in one month and 1.5000000000000002 in the other is the same load: the first month is named.
    const ftes: Array<[string, number]> = [["w", 0.106], ["p", 0.5], ["w", 0.894]];
    const make = (first: number[], second: number[]): Plan =>
      fixture({
        seats: [role("p"), role("w", { hireMonths: [6], fallback: "p" })],
        items: [...booked(first, ftes), ...booked(second, ftes, { earliest: 1 }).map((it) => ({ ...it, id: `e${it.id}` }))],
        lint: { principalLoad: 1.4 },
      });
    const plans = ORDERS.flatMap((first) => ORDERS.map((second) => make(first, second)));
    expect(distinct(plans.map((plan) => schedule(plan, AS_PLANNED).loads[0].demand[1]))).toEqual([1.5, 1.5000000000000002]);
    expect(messages(plans, "W116")).toEqual(["p carries 1.50 FTE of demand in 2027-01; 66.7% is fallback for unfilled seats."]);
  });

  it("W105: cash that ends exactly at zero is not negative, and the trough it states rounds the same, in every order of seats", () => {
    // 691,000 + 307,000 + 237,000 of salary and no funding leave cash at -1.235M: -1.23M in some
    // orders of seats and -1.24M in others under toFixed.
    const plans = permutations(salaried([691_000, 307_000, 237_000])).map((seats) => fixture({ seats }));
    expect(new Set(plans.map((plan) => (moneyOf(plan).cash[11] / 1e6).toFixed(2)))).toEqual(new Set(["-1.23", "-1.24"]));
    expect(messages(plans, "W105")).toEqual(["Cash turns negative in 2027-01; trough -1.24M."]);

    // Opening cash of exactly a year of 393,000 + 344,000 + 620,000 ends at zero: a hair below it in
    // some orders of seats.
    const spent = permutations(salaried([393_000, 344_000, 620_000])).map((seats) => fixture({ seats, openingCash: 1_357_000 }));
    expect(spent.some((plan) => moneyOf(plan).cash[11] < 0)).toBe(true);
    expect(messages(spent, "W105")).toEqual([undefined]);
  });

  it("W106: a share at exactly the policy does not fire, and the share it states rounds the same, in every order of streams", () => {
    // 25 + 136 of 200 units a year are assumed: 80.5% of revenue, 80% or 81% under Math.round.
    const stream = (id: string, units: number, basis: "A" | "M"): Plan["streams"][number] => ({
      id,
      label: id,
      unlockedBy: "unlock",
      unit: "unit",
      price: { usd: 100, basis: "A", note: "audit fixture" },
      volumeByYear: { units: [units], basis, note: "audit fixture" },
      rampMonths: 0,
    });
    const make = (lint: Plan["lint"] = {}): Plan[] =>
      permutations([stream("a1", 25, "A"), stream("a2", 136, "A"), stream("m", 39, "M")]).map((streams) => fixture({ items: [work("unlock")], streams, lint }));
    const plans = make();
    const shares = plans.map((plan) => {
      const l = moneyOf(plan);
      const assumed = plan.streams.filter((st) => st.volumeByYear.basis === "A").reduce((n, st) => n + total(l.revenueByStream[st.id]), 0);
      return Math.round((assumed / total(l.revenue)) * 100);
    });
    expect(distinct(shares)).toEqual([80, 81]);
    expect(messages(plans, "W106")).toEqual(["81% of revenue over 1 years rests on assumed volumes."]);
    expect(messages(make({ assumedRevenueShare: 0.805 }), "W106")).toEqual([undefined]);
  });

  it("W111: a gap at exactly the tolerance is not flagged, and the gap it states rounds the same, in every order of seats", () => {
    // 86,000 + 18,000 + 19,000 against a 120,000 reference is 2.5% over: 2% or 3% under Math.round.
    const make = (referenceCostTolerance: number): Plan[] =>
      permutations(salaried([86_000, 18_000, 19_000])).map((seats) =>
        fixture({ seats, reference: { headcountByYear: [3], gross: 120_000, nonLaborShare: [0, 1], note: "audit reference" }, lint: { referenceCostTolerance } }),
      );
    const plans = make(0.02);
    expect(distinct(plans.map((plan) => Math.round((total(moneyOf(plan).cost) / 120_000 - 1) * 100)))).toEqual([2, 3]);
    expect(messages(plans, "W111")).toEqual(["1-year cost 0.1M is 3% off the reference 0.1M."]);
    expect(messages(make(0.025), "W111")).toEqual([undefined]);
  });

  it("W112: a share at exactly the reference bound is not flagged, and the share it states rounds the same, in every order of seats and lines", () => {
    // 574,000 + 221,000 of non-labor against 81,000 + 10,000 + 114,000 of salary is 79.5% of cost:
    // 79% or 80% under Math.round.
    const line = (id: string, usd: number): Plan["nonLabor"][number] => ({ id, label: id, byYear: [usd], basis: "A", note: "audit fixture" });
    const make = (nonLaborShare: [number, number]): Plan[] =>
      permutations(salaried([81_000, 10_000, 114_000])).flatMap((seats) =>
        permutations([line("n0", 574_000), line("n1", 221_000)]).map((nonLabor) =>
          fixture({ seats, nonLabor, reference: { headcountByYear: [3], gross: 1_000_000, nonLaborShare, note: "audit reference" } }),
        ),
      );
    const plans = make([0, 0.5]);
    const shares = plans.map((plan) => {
      const l = moneyOf(plan);
      return Math.round((total(l.nonLabor) / total(l.cost)) * 100);
    });
    expect(distinct(shares)).toEqual([79, 80]);
    expect(messages(plans, "W112")).toEqual(["Non-labor is 80% of cost over 1 years."]);
    // Every order lands a hair under 79.5%, so the bound is pinned from both sides.
    expect(messages(make([0.795, 0.795]), "W112")).toEqual([undefined]);
  });
});

describe("figures a finding states round half away from zero", () => {
  // 0.145 and 1.45 are stored just under themselves, so toFixed shows 0.14 and 1.4.
  const late = (principalHires: number[], workerHires: number[]): Plan =>
    fixture({
      seats: [role("principal", { hireMonths: principalHires }), role("worker", { hireMonths: workerHires, fallback: "principal" })],
      items: [work("delegated", { owner: "worker", demands: [{ seat: "worker", fte: 0.145, basis: "A" }] })],
    });

  it("W103 states 0.145 FTE as 0.15 on each of its branches", () => {
    expect([(0.145).toFixed(2), (1.45).toFixed(1)]).toEqual(["0.14", "1.4"]);
    expect(finding(late([0], [6]), "W103")!.message).toBe('"delegated" starts 2027-01 but worker arrives 6 months later; principal carries 0.15 FTE meanwhile.');
    expect(finding(late([9], [6]), "W103")!.message).toBe(
      '"delegated" starts 2027-01 but worker arrives 6 months later, and nobody is hired to carry its 0.15 FTE: the load sits on the empty role principal.',
    );
    expect(finding(late([0], []), "W103")!.message).toBe('"delegated" asks for worker, which this scenario never hires; principal carries its 0.15 FTE.');
    expect(finding(late([], []), "W103")!.message).toBe(
      '"delegated" asks for worker, which this scenario never hires; nobody is hired to carry its 0.15 FTE: the load sits on the empty role principal.',
    );
  });

  it("W111 states 1.45M of cost and of reference as 1.5M", () => {
    const reference = (gross: number): Plan["reference"] => ({ headcountByYear: [1], gross, nonLaborShare: [0, 1], note: "audit reference" });
    expect(finding(fixture({ seats: [role("x", { loadedAnnual: 1_450_000 })], reference: reference(1_000_000) }), "W111")!.message).toBe(
      "1-year cost 1.5M is 45% off the reference 1.0M.",
    );
    expect(finding(fixture({ seats: [role("x", { loadedAnnual: 1_000_000 })], reference: reference(1_450_000) }), "W111")!.message).toBe(
      "1-year cost 1.0M is -31% off the reference 1.5M.",
    );
  });
});

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

  it("W102 exempts a hire by its declared month, not the month a scenario moves it to", () => {
    // One engineer, idle until work arrives in month 6.
    const plan = (x: Partial<SeatDef>): Plan =>
      fixture({ seats: [role("x", x)], items: [work("later", { earliest: 6, duration: 3 })] });
    const w102 = (p: Plan, over: Partial<Scenario>): Finding[] => {
      const s = schedule(p, { ...AS_PLANNED, id: "moved", ...over });
      return lintSchedule(p, s, ledger(p, s)).filter((f) => f.code === "W102");
    };

    // A hire declared in month 2 is checked where it lands, including month 0 when pulled
    // forward, clamped or not.
    expect(w102(plan({ hireMonths: [2] }), {}).map((f) => f.message)).toEqual(["x hired 2027-03 peaks at 0% load for its first 4 months."]);
    expect(w102(plan({ hireMonths: [2] }), { hireDelay: { x: -2 } }).map((f) => f.message)).toEqual(["x hired 2027-01 peaks at 0% load for its first 6 months."]);
    expect(w102(plan({ hireMonths: [2] }), { hireDelay: { x: -5 } }).map((f) => f.message)).toEqual(["x hired 2027-01 peaks at 0% load for its first 6 months."]);

    // A hire declared in month 0 is in place before the plan, even when a delay moves it,
    // and exempts only itself: a later hire in the same role is still checked.
    expect(w102(plan({ hireMonths: [0] }), {})).toEqual([]);
    expect(w102(plan({ hireMonths: [0] }), { hireDelay: { x: 3 } })).toEqual([]);
    expect(w102(plan({ hireMonths: [0, 2] }), {}).map((f) => f.message)).toEqual(["x hired 2027-03 peaks at 0% load for its first 4 months."]);

    // After a dropped hire, the declared month comes through hireIndex, not the position.
    expect(w102(plan({ hireMonths: [0, 5] }), { dropHires: { x: [0] }, hireDelay: { x: [0, -5] } }).map((f) => f.message)).toEqual([
      "x hired 2027-01 peaks at 0% load for its first 6 months.",
    ]);
    expect(w102(plan({ hireMonths: [5, 0] }), { dropHires: { x: [0] } })).toEqual([]);

    // A schedule without hireIndex cannot match hires to declarations, so it falls back to the
    // month each hire lands rather than pairing a kept hire with a dropped one's month.
    const dropped = plan({ hireMonths: [0, 2] });
    const s = schedule(dropped, { ...AS_PLANNED, id: "moved", dropHires: { x: [0] } });
    const unindexed = { ...s, hireIndex: undefined } as unknown as typeof s;
    expect(lintSchedule(dropped, unindexed, ledger(dropped, s)).filter((f) => f.code === "W102").map((f) => f.message)).toEqual([
      "x hired 2027-03 peaks at 0% load for its first 4 months.",
    ]);
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

describe("W101 under leveling names the load leveling does not wait for", () => {
  const leveled = (plan: Plan): Finding[] => {
    const result = schedule(plan, LEVELED);
    return lintSchedule(plan, result, ledger(plan, result));
  };
  const advice = " Add a seat, narrow the mandate, or lower the effort assumption.";

  it("names underway load under levelOn all, since leveling waits for room for the rest, fallback load included", () => {
    // u1 and u2 are underway and book first; together they put x over in months 0-3. carried
    // asks for w, never hired, whose work falls back to x: it waits for room on x.
    const plan = fixture({
      seats: [role("x"), role("w", { hireMonths: [12], fallback: "x" })],
      items: [
        work("u1", { priority: -1, underway: true, duration: 4 }),
        work("u2", { priority: -1, underway: true, duration: 4 }),
        work("carried", { owner: "w", duration: 2, demands: [{ seat: "w", fte: 1, basis: "A" }] }),
        work("planned", { duration: 4 }),
      ],
    });
    const result = schedule(plan, LEVELED);
    expect(result.items.find((it) => it.item.id === "carried")).toMatchObject({ start: 4, binding: { kind: "capacity", seat: "w", carrier: "x" } });
    expect(leveled(plan).find((f) => f.code === "W101" && f.subject === "x")!.hint).toBe(
      "Leveling waits for room on this seat for all but underway work, so underway load is what puts it over." + advice,
    );
    expect(finding(plan, "W101", "x")!.hint).toBe("Run a leveled scenario to see what slides, or narrow this seat's portfolio.");
    const planned = { ...plan, items: plan.items.filter((it) => !it.underway) };
    expect(leveled(planned).find((f) => f.code === "W101")).toBeUndefined();
  });

  it("names levelOn owner when a seat is over capacity on work it does not own", () => {
    // y books its own item first; x's item then asks y for 0.6 more.
    const plan = fixture({
      seats: [role("x"), role("y")],
      items: [
        work("own", { owner: "y", priority: -1, duration: 4, demands: [{ seat: "y", fte: 1, basis: "A" }] }),
        work("help", { duration: 4, demands: [{ seat: "x", fte: 1, basis: "A" }, { seat: "y", fte: 0.6, basis: "A" }] }),
      ],
    });
    expect(leveled(plan).find((f) => f.code === "W101")).toBeUndefined(); // every seat binds: help waits
    const warning = leveled({ ...plan, levelOn: "owner" }).find((f) => f.code === "W101" && f.subject === "y");
    expect(warning!.hint).toBe(
      "Under levelOn owner, leveling waits for room on this seat only for items it owns and never for underway work, so underway load or work on items it does not own is what puts it over." +
        advice,
    );
  });

  it("says a leadership seat absorbs once hired, and holds only its own items for the hire, under either levelOn", () => {
    const hint = "Leveling does not wait for room on a leadership seat, only for the hire of one with no fallback on an item it owns, so its overload is reported here instead." + advice;
    const items = ["a", "b"].map((id) => work(id, { owner: "ceo", duration: 4, demands: [{ seat: "ceo", fte: 1, basis: "A" }] }));
    for (const levelOn of ["all", "owner"] as const) {
      const inPlace = fixture({ levelOn, seats: [role("ceo", { unlevelled: true })], items });
      expect(leveled(inPlace).find((f) => f.code === "W101" && f.subject === "ceo")!.hint).toBe(hint);

      // Hired in month 3: both items wait for the hire, then overlap on the seat.
      const hired = fixture({ levelOn, seats: [role("ceo", { unlevelled: true, hireMonths: [3] })], items });
      const found = leveled(hired);
      expect(found.find((f) => f.code === "W101" && f.subject === "ceo")!.hint).toBe(hint);
      expect(found.find((f) => f.code === "W104" && f.subject === "a")!.message).toBe('"a" starts 3 months after its declared 2027-01: waits for the ceo hire in 2027-04.');
    }
  });
});

describe("thresholds on sums do not flip with the order they were added", () => {
  // Booked 0.1, 0.2, 0.3 the load is 0.6000000000000001; booked 0.3, 0.2, 0.1 it is 0.6.
  // Priorities set the booking order, so every permutation is tried.
  const ORDERS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const tenths = (order: number[], seat: string, over: Partial<WorkItem> = {}, prefix = "d"): WorkItem[] =>
    [0.1, 0.2, 0.3].map((fte, k) => work(`${prefix}${k}`, { owner: seat, priority: order[k], demands: [{ seat, fte, basis: "A" }], ...over }));
  const distinct = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);

  it("W116: a principal at exactly the policy's load does not warn, in any order", () => {
    const make = (order: number[], principalLoad: number): Plan =>
      fixture({
        seats: [role("principal"), role("worker", { hireMonths: [6], fallback: "principal" })],
        items: tenths(order, "worker"),
        lint: { principalLoad },
      });
    expect(distinct(ORDERS.map((o) => schedule(make(o, 0.6), AS_PLANNED).loads[0].demand[0]))).toEqual([0.6, 0.6000000000000001]);
    for (const o of ORDERS) expect(finding(make(o, 0.6), "W116")).toBeUndefined();
    for (const o of ORDERS) expect(finding(make(o, 0.59), "W116")).toBeDefined();
  });

  it("W116: of two months with the same load, the first is named, in any order", () => {
    const make = (first: number[], second: number[]): Plan =>
      fixture({
        seats: [role("principal"), role("worker", { hireMonths: [6], fallback: "principal" })],
        items: [...tenths(first, "worker"), ...tenths(second, "worker", { earliest: 1 }, "e")],
        lint: { principalLoad: 0.59 },
      });
    const messages = ORDERS.flatMap((first) => ORDERS.map((second) => finding(make(first, second), "W116")!.message));
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toMatch(/0\.60 FTE of demand in 2027-01/);
  });

  it("W115: last-circle load at exactly the policy does not warn, in any order", () => {
    const make = (order: number[], lastCircleFteMonths: number): Plan =>
      fixture({ circles: ["core", "later"], items: tenths(order, "x", { circle: "later" }), lint: { lastCircleFteMonths } });
    const sums = ORDERS.map((o) => schedule(make(o, 0.6), AS_PLANNED).bookings.reduce((n, b) => n + b.fte, 0));
    expect(distinct(sums)).toEqual([0.6, 0.6000000000000001]);
    for (const o of ORDERS) expect(finding(make(o, 0.6), "W115")).toBeUndefined();
    for (const o of ORDERS) expect(finding(make(o, 0.59), "W115")).toBeDefined();
  });

  it("W101: a peak at exactly the policy's FTE warns, in any order", () => {
    const make = (order: number[], overloadPeakFte: number): Plan =>
      fixture({ seats: [role("x", { capacityFte: 0.2 })], items: tenths(order, "x"), lint: { overloadPeakFte, overloadMonths: 99 } });
    const peaks = ORDERS.map((o) => {
      const s = schedule(make(o, 0.4), AS_PLANNED);
      return s.loads[0].demand[0] - s.loads[0].capacity[0];
    });
    expect(distinct(peaks)).toEqual([0.39999999999999997, 0.4000000000000001]);
    for (const o of ORDERS) expect(finding(make(o, 0.4), "W101")).toBeDefined();
    for (const o of ORDERS) expect(finding(make(o, 0.41), "W101")).toBeUndefined();
  });

  it("W102: a hire at exactly the policy's share is not idle, in any order", () => {
    const make = (order: number[], idleLoadShare: number): Plan =>
      fixture({
        seats: [role("x", { hireMonths: [1], capacityFte: 6 })],
        items: tenths(order, "x", { earliest: 1, standing: true }),
        lint: { idleLoadShare },
      });
    const shares = ORDERS.map((o) => {
      const s = schedule(make(o, 0.1), AS_PLANNED);
      return s.loads[0].demand[1] / s.loads[0].capacity[1];
    });
    expect(distinct(shares)).toEqual([0.09999999999999999, 0.10000000000000002]);
    for (const o of ORDERS) expect(finding(make(o, 0.1), "W102")).toBeUndefined();
    for (const o of ORDERS) expect(finding(make(o, 0.11), "W102")).toBeDefined();
  });

  const permutations = <T,>(xs: T[]): T[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, k) => permutations([...xs.slice(0, k), ...xs.slice(k + 1)]).map((rest) => [x, ...rest]));
  const cost = (plan: Plan): number => {
    const result = schedule(plan, AS_PLANNED);
    return ledger(plan, result).cost.reduce((a, b) => a + b, 0);
  };
  const salaried = (annuals: number[]): SeatDef[] => annuals.map((loadedAnnual, k) => role(`s${k}`, { loadedAnnual }));

  it("W106: revenue at exactly the policy's assumed share does not warn, in any order of streams", () => {
    // 24 of 30 units a year are assumed: exactly 80% of revenue. Summed by month, the share
    // lands on 80% in some orders of streams and a hair above it in others.
    const stream = (id: string, units: number, basis: "A" | "M"): Plan["streams"][number] => ({
      id,
      label: id,
      unlockedBy: "unlock",
      unit: "unit",
      price: { usd: 100, basis: "A", note: "audit fixture" },
      volumeByYear: { units: [units], basis, note: "audit fixture" },
      rampMonths: 0,
    });
    const make = (units: [number, number, number]): Plan[] =>
      permutations([stream("a1", units[0], "A"), stream("a2", units[1], "A"), stream("m", units[2], "M")]).map((streams) =>
        fixture({ items: [work("unlock")], streams }),
      );
    const shares = make([10, 14, 6]).map((plan) => {
      const l = ledger(plan, schedule(plan, AS_PLANNED));
      const total = l.revenue.reduce((a, b) => a + b, 0);
      return ["a1", "a2"].reduce((n, id) => n + l.revenueByStream[id].reduce((a, b) => a + b, 0), 0) / total;
    });
    expect(distinct(shares).length).toBeGreaterThan(1);
    for (const plan of make([10, 14, 6])) expect(finding(plan, "W106")).toBeUndefined();
    for (const plan of make([10, 14.01, 5.99])) expect(finding(plan, "W106")).toBeDefined();
  });

  it("W111: cost at exactly the reference tolerance is not flagged, in any order of seats", () => {
    // Against a 120,000 reference, 138,000 is exactly 15% over and 102,000 exactly 15% under.
    const make = (annuals: number[]): Plan[] =>
      permutations(salaried(annuals)).map((seats) =>
        fixture({ seats, reference: { headcountByYear: [annuals.length], gross: 120_000, nonLaborShare: [0, 1], note: "audit reference" } }),
      );
    for (const [exact, beyond] of [
      [[80_000, 30_000, 28_000], [80_000, 30_000, 28_100]],
      [[70_000, 30_000, 2_000], [70_000, 30_000, 1_900]],
    ]) {
      expect(distinct(make(exact).map(cost)).length).toBeGreaterThan(1);
      for (const plan of make(exact)) expect(finding(plan, "W111")).toBeUndefined();
      for (const plan of make(beyond)) expect(finding(plan, "W111")).toBeDefined();
    }
  });

  it("W112: a non-labor share at exactly the reference bound is not flagged, in any order of seats and lines", () => {
    // 55,000 of non-labor against 220,000 of labor is exactly 20% of cost, both ends of the range.
    const line = (id: string, usd: number): Plan["nonLabor"][number] => ({ id, label: id, byYear: [usd], basis: "A", note: "audit fixture" });
    const make = (annuals: number[], lines: number[]): Plan[] =>
      permutations(salaried(annuals)).flatMap((seats) =>
        permutations(lines.map((usd, k) => line(`n${k}`, usd))).map((nonLabor) =>
          fixture({ seats, nonLabor, reference: { headcountByYear: [annuals.length], gross: 1, nonLaborShare: [0.2, 0.2], note: "audit reference" } }),
        ),
      );
    expect(distinct(make([100_000, 50_000, 70_000], [25_000, 15_000, 15_000]).map(cost)).length).toBeGreaterThan(1);
    for (const plan of make([100_000, 50_000, 70_000], [25_000, 15_000, 15_000])) expect(finding(plan, "W112")).toBeUndefined();
    for (const plan of make([100_000, 50_000, 70_000], [25_000, 15_000, 15_100])) expect(finding(plan, "W112")).toBeDefined();
    for (const plan of make([100_000, 50_000, 70_000], [25_000, 15_000, 14_900])) expect(finding(plan, "W112")).toBeDefined();
    // One seat and one line: monthly twelfths alone leave cost a hair under 100,000.
    expect(finding(make([80_000], [20_000])[0], "W112")).toBeUndefined();
  });

  it("W105: cash that ends exactly at zero is not negative, in any order of seats", () => {
    // Twelve monthly twelfths of each salary, added seat by seat, can leave cash a hair
    // below zero in some orders of seats.
    const make = (annuals: number[], funded: number): Plan[] =>
      permutations(salaried(annuals)).map((seats) =>
        fixture({ seats, funding: [{ id: "grant", label: "grant", byMonth: [funded], basis: "A", note: "audit fixture", counted: true }] }),
      );
    const ends = (plans: Plan[]) => plans.map((plan) => ledger(plan, schedule(plan, AS_PLANNED)).cash[11]);
    for (const [annuals, funded] of [
      [[80_000, 30_000, 28_000], 138_000],
      [[100_000, 50_000, 70_000], 220_000],
    ] as const) {
      expect(ends(make([...annuals], funded)).some((cash) => cash < 0)).toBe(true);
      for (const plan of make([...annuals], funded)) expect(finding(plan, "W105")).toBeUndefined();
      for (const plan of make([...annuals], funded - 1)) expect(finding(plan, "W105")!.message).toBe("Cash turns negative in 2027-12; trough -0.00M.");
    }
  });
});
