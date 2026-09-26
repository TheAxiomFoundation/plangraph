import { describe, expect, it } from "vitest";
import {
  AS_PLANNED,
  LEVELED,
  hireMonthlyCost,
  ledger,
  lintAll,
  lintPlan,
  overloads,
  schedule,
  slips,
  type Plan,
  type SeatDef,
  type WorkItem,
} from "../src/index";

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
  duration: 1,
  standing: false,
  predecessors: [],
  demands: [{ seat: "x", fte: 1, basis: "A" }],
  underway: false,
  ...over,
});

const fixture = (over: Partial<Plan> = {}): Plan => ({
  name: "schedule audit fixture",
  calendar: { startYear: 2027, startMonth: 1, horizonMonths: 6, fundingYearStartMonth: 0 },
  circles: ["core"],
  seats: [role("x")],
  items: [],
  streams: [],
  funding: [],
  nonLabor: [],
  escalation: { rate: 0, basis: "A" },
  ...over,
});

const scheduled = (plan: Plan, id: string, scenario = LEVELED) =>
  schedule(plan, scenario).items.find((item) => item.item.id === id)!;

describe("defensive schedule audit", () => {
  it("D1 requires a finite item to fit its whole run inside H=4", () => {
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 4, fundingYearStartMonth: 0 },
      items: [
        work("a", { duration: 3 }),
        work("b", { duration: 3 }),
      ],
    });

    const result = schedule(plan, LEVELED);
    const b = result.items.find((item) => item.item.id === "b")!;

    // From months 0 and 1 the run would fit the horizon but x is full; from 2 on it would not.
    expect(b).toMatchObject({
      start: 4,
      end: 4,
      duration: 0,
      beyond: true,
      binding: { kind: "capacity", seat: "x", carrier: "x" },
      carriers: [],
    });
    expect(result.loads.find((load) => load.seat === "x")!.demand).toEqual([1, 1, 1, 0]);
    expect(result.bookings.filter((booking) => booking.item === "b")).toEqual([]);
  });

  it("A1 applies the whole-run horizon invariant to underway finite work", () => {
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 4, fundingYearStartMonth: 0 },
      items: [work("underway", { earliest: 2, duration: 3, underway: true })],
    });

    const result = schedule(plan, AS_PLANNED);

    expect(result.items[0]).toMatchObject({
      start: 4,
      end: 4,
      duration: 0,
      beyond: true,
      binding: { kind: "horizon" },
      carriers: [],
    });
    expect(result.loads[0].demand).toEqual([0, 0, 0, 0]);
    expect(result.bookings).toEqual([]);
  });

  it("D2 aggregates engineer and founder demands by their monthly carrier", () => {
    const plan = fixture({
      seats: [
        role("founder"),
        role("eng", { hireMonths: [2], fallback: "founder" }),
      ],
      items: [
        work("build", {
          owner: "eng",
          demands: [
            { seat: "eng", fte: 0.6, basis: "A" },
            { seat: "founder", fte: 0.6, basis: "A" },
          ],
        }),
      ],
    });

    const result = schedule(plan, LEVELED);

    expect(result.items[0].start).toBe(2);
    expect(result.loads.find((load) => load.seat === "founder")!.demand).toEqual([0, 0, 0.6, 0, 0, 0]);
    expect(result.loads.find((load) => load.seat === "eng")!.demand).toEqual([0, 0, 0.6, 0, 0, 0]);
    expect(overloads(result)).toEqual([]);
  });

  it("D2 rejects duplicate demands for the same seat on one item", () => {
    const plan = fixture({
      items: [
        work("duplicate", {
          demands: [
            { seat: "x", fte: 0.6, basis: "A" },
            { seat: "x", fte: 0.6, basis: "A" },
          ],
        }),
      ],
    });

    expect(lintPlan(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "E004", severity: "error", subject: "duplicate" }),
      ]),
    );
  });

  it("D3 follows a ten-role fallback chain all the way to external", () => {
    const seats = Array.from({ length: 10 }, (_, index) =>
      role(`s${index}`, {
        hireMonths: [1],
        fallback: index === 9 ? "external" : `s${index + 1}`,
      }),
    );
    const plan = fixture({
      seats,
      items: [work("chain", { demands: [{ seat: "s0", fte: 1, basis: "A" }] })],
    });

    const result = schedule(plan, LEVELED);

    expect(result.items[0]).toMatchObject({
      start: 0,
      end: 1,
      beyond: false,
      carriers: [{ seat: "s0", carrier: "external", fte: 1 }],
    });
    expect(result.external).toEqual([1, 0, 0, 0, 0, 0]);
  });

  it("D3 uses the chosen all-or-nothing partial-staffing policy and waits for the second hire at month 4", () => {
    const plan = fixture({
      seats: [role("x", { hireMonths: [0, 4], fallback: "external" })],
      items: [work("large", { demands: [{ seat: "x", fte: 1.5, basis: "A" }] })],
    });

    const result = schedule(plan, LEVELED);

    expect(result.items[0].start).toBe(4);
    expect(result.items[0].carriers).toEqual([{ seat: "x", carrier: "x", fte: 1.5 }]);
    expect(result.external).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("A5 computes a delayed standing item's duration from its scheduled start", () => {
    const plan = fixture({
      seats: [role("x", { capacityFte: 2 })],
      items: [
        work("predecessor", { duration: 3 }),
        work("standing", {
          duration: 1,
          standing: true,
          predecessors: [{ id: "predecessor" }],
        }),
      ],
    });

    const standing = scheduled(plan, "standing", AS_PLANNED);

    expect(standing).toMatchObject({ start: 3, end: 6, duration: 3, beyond: false });
    expect(standing.duration).toBe(standing.end - standing.start);
  });

  it("A5 gives standing work pushed to H no carriers or bookings", () => {
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 3, fundingYearStartMonth: 0 },
      items: [
        work("a-busy", { duration: 3 }),
        work("z-standing", { standing: true }),
      ],
    });

    const result = schedule(plan, LEVELED);
    const standing = result.items.find((item) => item.item.id === "z-standing")!;

    // Standing work never overshoots the horizon, so what kept it out is the full seat.
    expect(standing).toMatchObject({
      start: 3,
      end: 3,
      duration: 0,
      beyond: true,
      binding: { kind: "capacity", seat: "x", carrier: "x" },
      carriers: [],
    });
    expect(result.bookings.filter((booking) => booking.item === "z-standing")).toEqual([]);
    expect(result.loads[0].demand).toEqual([1, 1, 1]);
  });

  it("A5 chooses the same coincident predecessor binding after predecessor permutation", () => {
    const make = (predecessors: WorkItem["predecessors"]): Plan =>
      fixture({
        seats: [role("x", { capacityFte: 3 })],
        items: [
          work("a", { duration: 2, demands: [{ seat: "x", fte: 0.1, basis: "A" }] }),
          work("b", { duration: 2, demands: [{ seat: "x", fte: 0.1, basis: "A" }] }),
          work("successor", {
            predecessors,
            demands: [{ seat: "x", fte: 0.1, basis: "A" }],
          }),
        ],
      });

    const left = scheduled(make([{ id: "b" }, { id: "a" }]), "successor", AS_PLANNED);
    const right = scheduled(make([{ id: "a" }, { id: "b" }]), "successor", AS_PLANNED);

    expect(left.start).toBe(2);
    expect(right.start).toBe(2);
    expect(left.binding).toEqual({ kind: "predecessor", id: "a" });
    expect(right.binding).toEqual(left.binding);
  });

  it("A5 chooses the same equal-shortfall binding after demand permutation", () => {
    const xy = [
      { seat: "x", fte: 1, basis: "A" as const },
      { seat: "y", fte: 1, basis: "A" as const },
    ];
    // Both seats hired, and both full in month 0 with another item's work.
    const full = (demands: WorkItem["demands"]): Plan =>
      fixture({
        seats: [role("x"), role("y")],
        items: [work("busy", { priority: -1, duration: 1, demands: xy }), work("both", { owner: "x", demands })],
      });
    // Nobody hired to either seat until month 1.
    const unhired = (demands: WorkItem["demands"]): Plan =>
      fixture({
        seats: [role("x", { hireMonths: [1] }), role("y", { hireMonths: [1] })],
        items: [work("both", { owner: "x", demands })],
      });

    for (const [make, kind] of [[full, "capacity"], [unhired, "hire"]] as const) {
      const left = scheduled(make(xy), "both");
      const right = scheduled(make([...xy].reverse()), "both");
      expect(left.start).toBe(1);
      expect(right.start).toBe(1);
      expect(left.binding).toEqual({ kind, seat: "x", carrier: "x" });
      expect(right.binding).toEqual(left.binding);
    }
  });

  it("A5 reports H minus baseline start and beyond only on the transition", () => {
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 4, fundingYearStartMonth: 0 },
      items: [work("late", { earliest: 1 })],
    });
    const baseline = schedule(plan, AS_PLANNED);
    const delayed = schedule(plan, {
      id: "delayed",
      name: "Delayed",
      gist: "The only hire moves to the horizon.",
      level: true,
      hireDelay: { x: 4 },
    });

    // The run fits the horizon from months 1 to 3, but x is not hired until month 4.
    expect(slips(baseline, delayed)).toEqual([
      {
        id: "late",
        label: "late",
        months: 3,
        beyond: true,
        binding: { kind: "hire", seat: "x", carrier: "x" },
      },
    ]);
    expect(slips(delayed, baseline)[0]).toMatchObject({ months: -3, beyond: false });
  });

  it("A5 preserves per-demand carriers and fixes only fallback load when own and fallback work mix", () => {
    const plan = fixture({
      seats: [
        role("founder", { capacityFte: 2 }),
        role("eng", { hireMonths: [2], fallback: "founder" }),
      ],
      items: [
        work("mixed", {
          duration: 2,
          owner: "founder",
          demands: [
            { seat: "founder", fte: 0.4, basis: "A" },
            { seat: "eng", fte: 0.6, basis: "A" },
          ],
        }),
      ],
    });

    const result = schedule(plan, AS_PLANNED);
    const founder = result.loads.find((load) => load.seat === "founder")!;

    expect(result.items[0].carriers).toEqual([
      { seat: "founder", carrier: "founder", fte: 0.4 },
      { seat: "eng", carrier: "founder", fte: 0.6 },
    ]);
    expect(founder.demand).toEqual([1, 1, 0, 0, 0, 0]);
    expect(founder.fixed).toEqual([0.6, 0.6, 0, 0, 0, 0]);
    expect(result.bookings).toHaveLength(4);
    expect(result.bookings).toEqual(
      expect.arrayContaining([
        { item: "mixed", circle: "core", month: 0, seat: "founder", carrier: "founder", fte: 0.4 },
        { item: "mixed", circle: "core", month: 0, seat: "eng", carrier: "founder", fte: 0.6 },
        { item: "mixed", circle: "core", month: 1, seat: "founder", carrier: "founder", fte: 0.4 },
        { item: "mixed", circle: "core", month: 1, seat: "eng", carrier: "founder", fte: 0.6 },
      ]),
    );
  });

  it("rejects a non-finite scaled demand instead of returning a corrupt schedule", () => {
    const plan = fixture({
      items: [work("huge", { demands: [{ seat: "x", fte: Number.MAX_VALUE, basis: "A" }] })],
    });
    expect(() =>
      schedule(plan, {
        id: "overflow",
        name: "Overflow",
        gist: "Stress numeric closure.",
        level: false,
        effortScale: Number.MAX_VALUE,
      }),
    ).toThrow(/non-finite demand/);
  });
});

describe("defensive revenue audit", () => {
  it("D6 preserves the exact ramp totals and standing-start revenue vector", () => {
    const rampPlan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 25, fundingYearStartMonth: 0 },
      items: [work("unlock", { demands: [{ seat: "x", fte: 0.1, basis: "A" }] })],
      streams: [
        {
          id: "ramp",
          label: "Ramp",
          unlockedBy: "unlock",
          unit: "units",
          price: { usd: 10, basis: "A", note: "audit price" },
          volumeByYear: { units: [120, 240], basis: "A", note: "audit volume" },
          rampMonths: 3,
        },
      ],
    });
    const ramp = ledger(rampPlan, schedule(rampPlan, AS_PLANNED)).revenueByStream.ramp;

    expect(ramp.slice(0, 5)).toEqual([0, 33.33333333333333, 66.66666666666666, 100, 100]);
    expect(ramp.slice(1, 13).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1_100, 10);
    expect(ramp.slice(13, 25).reduce((sum, value) => sum + value, 0)).toBe(2_400);

    const standingPlan = fixture({
      items: [
        work("standing", {
          earliest: 2,
          standing: true,
          demands: [{ seat: "x", fte: 0.1, basis: "A" }],
        }),
      ],
      streams: [
        {
          id: "standing-revenue",
          label: "Standing revenue",
          unlockedBy: "standing",
          unit: "units",
          price: { usd: 10, basis: "A", note: "audit price" },
          volumeByYear: { units: [120], basis: "A", note: "audit volume" },
          rampMonths: 0,
        },
      ],
    });
    const standing = ledger(standingPlan, schedule(standingPlan, AS_PLANNED));

    expect(standing.unlocks["standing-revenue"]).toBe(2);
    expect(standing.revenueByStream["standing-revenue"]).toEqual([0, 0, 100, 100, 100, 100]);
  });
});

describe("dropSeats and unlevelled", () => {
  it("drops a role from a scenario: no hires, no cost, demand on the fallback, and W103 says so", async () => {
    const { AS_PLANNED, ledger, lintAll, parsePlan, schedule } = await import("../src/index");
    const plan = parsePlan({
      name: "drop",
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
      circles: ["a"],
      escalation: { rate: 0, basis: "A" },
      seats: [
        { id: "lead", title: "Lead", loadedAnnual: 120_000, costBasis: "A", hireMonths: [0], capacityFte: 1, fallback: null },
        { id: "extra", title: "Extra", loadedAnnual: 90_000, costBasis: "A", hireMonths: [2], capacityFte: 1, fallback: "lead" },
      ],
      items: [{ id: "w", lane: "l", label: "Work", circle: "a", earliest: 0, duration: 12, standing: false, underway: false, predecessors: [], demands: [{ seat: "lead", fte: 0.5, basis: "A" }, { seat: "extra", fte: 0.5, basis: "A" }] }],
      streams: [], funding: [], nonLabor: [],
      scenarios: [AS_PLANNED, { id: "slice", name: "Slice", gist: "without the extra seat", level: false, dropSeats: ["extra"] }],
    });
    const full = schedule(plan, plan.scenarios![0]);
    const slice = schedule(plan, plan.scenarios![1]);
    expect(slice.hires.extra).toEqual([]);
    expect(slice.loads.find((l) => l.seat === "extra")!.capacity.every((c) => c === 0)).toBe(true);
    expect(slice.loads.find((l) => l.seat === "lead")!.demand[5]).toBeCloseTo(1, 9);
    expect(full.loads.find((l) => l.seat === "lead")!.demand[5]).toBeCloseTo(0.5, 9);
    expect(ledger(plan, slice).labor[5]).toBeCloseTo(10_000, 6);
    const w103 = lintAll(plan, slice, ledger(plan, slice)).filter((f) => f.code === "W103");
    expect(w103).toHaveLength(1);
    expect(w103[0].message).toMatch(/never hires; Lead carries/);
    expect(() => parsePlan({ ...plan, scenarios: [{ id: "bad", name: "b", gist: "", level: false, dropSeats: ["nope"] }] })).toThrow(/dropSeats\[0\]/);
  });

  it("never waits for room on an unlevelled seat; the overload is reported instead", async () => {
    const { LEVELED, lintAll, ledger, parsePlan, schedule } = await import("../src/index");
    const plan = parsePlan({
      name: "leadership",
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
      circles: ["a"],
      escalation: { rate: 0, basis: "A" },
      seats: [
        { id: "ceo", title: "CEO", loadedAnnual: 200_000, costBasis: "A", hireMonths: [0], capacityFte: 1, fallback: null, unlevelled: true },
        { id: "eng", title: "Engineer", loadedAnnual: 100_000, costBasis: "A", hireMonths: [0], capacityFte: 1, fallback: "ceo" },
      ],
      items: [
        { id: "a", lane: "l", label: "A", circle: "a", earliest: 0, duration: 6, standing: false, underway: false, predecessors: [], demands: [{ seat: "ceo", fte: 1, basis: "A" }] },
        { id: "b", lane: "l", label: "B", circle: "a", earliest: 0, duration: 6, standing: false, underway: false, predecessors: [], demands: [{ seat: "ceo", fte: 1, basis: "A" }] },
        { id: "c", lane: "l", label: "C", circle: "a", earliest: 0, duration: 6, standing: false, underway: false, predecessors: [], demands: [{ seat: "eng", fte: 1, basis: "A" }] },
        { id: "d", lane: "l", label: "D", circle: "a", earliest: 0, duration: 6, standing: false, underway: false, predecessors: [], demands: [{ seat: "eng", fte: 1, basis: "A" }] },
      ],
      streams: [], funding: [], nonLabor: [], scenarios: [LEVELED],
    });
    const s = schedule(plan, LEVELED);
    const start = (id: string) => s.items.find((i) => i.item.id === id)!.start;
    expect(start("a")).toBe(0);
    expect(start("b")).toBe(0); // the CEO absorbs; b is not pushed
    expect(start("d")).toBe(6); // the engineer is levelled
    const w101 = lintAll(plan, s, ledger(plan, s)).filter((f) => f.code === "W101" && f.subject === "ceo");
    expect(w101).toHaveLength(1);
    expect(() => parsePlan({ ...plan, seats: [{ ...plan.seats[0], unlevelled: "yes" }, plan.seats[1]] })).toThrow(/unlevelled/);
  });
});

describe("the binding of work leveling pushes beyond the horizon", () => {
  const w104 = (plan: Plan, id: string) => {
    const s = schedule(plan, LEVELED);
    return lintAll(plan, s, ledger(plan, s)).find((f) => f.code === "W104" && f.subject === id);
  };

  it("names the seat, not the horizon, when the run would fit but for capacity", () => {
    // a holds x for months 0-4. b's three months would fit the horizon from any start up to
    // month 3, but x is full until month 5.
    const plan = fixture({ items: [work("a", { duration: 5 }), work("b", { duration: 3 })] });
    expect(scheduled(plan, "b")).toMatchObject({ beyond: true, binding: { kind: "capacity", seat: "x", carrier: "x" } });
    expect(w104(plan, "b")!.message).toBe('"b" does not fit inside the horizon: leveling found no start with room for it; the last seat without room was x.');
    expect(scheduled(plan, "b", AS_PLANNED)).toMatchObject({ start: 0, beyond: false, binding: { kind: "declared" } });
  });

  it("names the horizon when the run is longer than the months left, whether or not its seat is full", () => {
    // late and spare start at month 4 and need three months, with two left. x is still full in
    // month 4; y is free throughout. b, taken first, is kept out by x.
    const plan = fixture({
      seats: [role("x"), role("y")],
      items: [
        work("a", { duration: 5 }),
        work("b", { duration: 3 }),
        work("late", { earliest: 4, duration: 3 }),
        work("spare", { earliest: 4, duration: 3, demands: [{ seat: "y", fte: 0.1, basis: "A" }] }),
      ],
    });
    expect(scheduled(plan, "b")).toMatchObject({ beyond: true, binding: { kind: "capacity", seat: "x", carrier: "x" } });
    for (const id of ["late", "spare"]) {
      expect(scheduled(plan, id)).toMatchObject({ beyond: true, binding: { kind: "horizon" } });
      expect(w104(plan, id)!.message).toBe(`"${id}" does not fit inside the horizon: its run would extend past the horizon.`);
    }
  });

  it("names the last seat that had no room when different seats block different months", () => {
    // x is full in months 0-1 and y in months 2-5; c needs both for two months. y had room
    // for a start at month 0, but x did not, and y is the last seat found full.
    const plan = fixture({
      seats: [role("x"), role("y")],
      items: [
        work("a", { priority: -2, duration: 2 }),
        work("b", { priority: -1, earliest: 2, duration: 4, demands: [{ seat: "y", fte: 1, basis: "A" }] }),
        work("c", { duration: 2, demands: [{ seat: "x", fte: 1, basis: "A" }, { seat: "y", fte: 1, basis: "A" }] }),
      ],
    });
    expect(scheduled(plan, "c")).toMatchObject({ beyond: true, binding: { kind: "capacity", seat: "y", carrier: "y" } });
    expect(w104(plan, "c")!.message).toBe('"c" does not fit inside the horizon: leveling found no start with room for it; the last seat without room was y.');
  });

  it("names the last seat that had no room for work leveling delays inside the horizon", () => {
    // The same seats over eight months, with y full only in months 2-3: c fails on x from
    // months 0 and 1, on y from months 2 and 3, and fits from month 4.
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 8, fundingYearStartMonth: 0 },
      seats: [role("x"), role("y")],
      items: [
        work("a", { priority: -2, duration: 2 }),
        work("b", { priority: -1, earliest: 2, duration: 2, demands: [{ seat: "y", fte: 1, basis: "A" }] }),
        work("c", { duration: 2, demands: [{ seat: "x", fte: 1, basis: "A" }, { seat: "y", fte: 1, basis: "A" }] }),
      ],
    });
    expect(scheduled(plan, "c")).toMatchObject({ start: 4, end: 6, beyond: false, binding: { kind: "capacity", seat: "y", carrier: "y" } });
  });

  it("names the carrier that is full when the seat asked for falls back to it", () => {
    const plan = fixture({
      seats: [role("x"), role("w", { title: "Writer", hireMonths: [6], fallback: "x" })],
      items: [work("a", { priority: -1, duration: 6 }), work("b", { duration: 2, demands: [{ seat: "w", fte: 1, basis: "A" }] })],
    });
    expect(scheduled(plan, "b")).toMatchObject({ beyond: true, binding: { kind: "capacity", seat: "w", carrier: "x" } });
    expect(w104(plan, "b")!.message).toMatch(/the last seat without room was x\.$/);
  });

  it("chooses the same seat whatever the order of the demands", () => {
    const make = (demands: WorkItem["demands"]): Plan =>
      fixture({ seats: [role("x", { hireMonths: [6] }), role("y", { hireMonths: [6] })], items: [work("both", { owner: "y", demands })] });
    const xy = [
      { seat: "x", fte: 1, basis: "A" as const },
      { seat: "y", fte: 1, basis: "A" as const },
    ];
    const left = scheduled(make(xy), "both");
    const right = scheduled(make([...xy].reverse()), "both");
    // Neither seat is hired inside the horizon, so the wait is for a hire, not for room.
    expect(left).toMatchObject({ beyond: true, binding: { kind: "hire", seat: "x", carrier: "x" } });
    expect(right.binding).toEqual(left.binding);
  });

  it("gives standing work the seat full in the last month, and a delayed start its own duration", () => {
    // Standing work never overshoots the horizon, so leveling ends on the seat's last month.
    const shut = fixture({ items: [work("busy", { duration: 6 }), work("z", { standing: true })] });
    expect(scheduled(shut, "z")).toMatchObject({ beyond: true, binding: { kind: "capacity", seat: "x", carrier: "x" } });
    expect(w104(shut, "z")!.message).toBe('"z" does not fit inside the horizon: leveling found no start with room for it; the last seat without room was x.');

    const delayed = scheduled(fixture({ items: [work("busy", { duration: 2 }), work("z", { standing: true })] }), "z");
    expect(delayed).toMatchObject({ start: 2, end: 6, duration: 4, beyond: false, binding: { kind: "capacity", seat: "x", carrier: "x" } });
  });
});

describe("demand profiles", () => {
  it("books FTE by quarter of the item's run, the last value holding, and parses the shape", async () => {
    const { AS_PLANNED, demandAt, parsePlan, schedule } = await import("../src/index");
    const plan = parsePlan({
      name: "profile",
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
      circles: ["a"],
      escalation: { rate: 0, basis: "A" },
      seats: [{ id: "x", title: "X", loadedAnnual: 120_000, costBasis: "A", hireMonths: [0], capacityFte: 1, fallback: null }],
      items: [{ id: "w", lane: "l", label: "Work", circle: "a", earliest: 2, duration: 9, standing: false, underway: false, predecessors: [], demands: [{ seat: "x", fte: 0.5, profile: [0.8, 0.2], basis: "A" }] }],
      streams: [], funding: [], nonLabor: [], scenarios: [AS_PLANNED],
    });
    const s = schedule(plan, AS_PLANNED);
    const load = s.loads[0].demand;
    expect(load.slice(2, 5)).toEqual([0.8, 0.8, 0.8]);
    expect(load.slice(5, 11)).toEqual([0.2, 0.2, 0.2, 0.2, 0.2, 0.2]);
    expect(load[1]).toBe(0);
    expect(demandAt(plan.items[0].demands[0], 0)).toBe(0.8);
    expect(demandAt(plan.items[0].demands[0], 40)).toBe(0.2);
    expect(() => parsePlan({ ...plan, items: [{ ...plan.items[0], demands: [{ ...plan.items[0].demands[0], profile: [] }] }] })).toThrow(/profile/);
  });

  it("W103 reports a seat carrying its own work before it exists", () => {
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
      seats: [role("x", { hireMonths: [6] })],
      items: [work("a", { duration: 12 })],
    });
    const s = schedule(plan, AS_PLANNED);
    const found = lintAll(plan, s, ledger(plan, s)).filter((f) => f.code === "W103");
    expect(found.map((f) => f.subject)).toEqual(["a"]);
    expect(found[0].message).toMatch(/arrives 6 months later, and nobody is hired to carry its 1.00 FTE/);
  });

  it("costs a pooled role per hire, keeps the index through drops and per-hire delays", () => {
    const plan = fixture({
      seats: [role("x", { hireMonths: [0, 0, 2], loadedAnnualByHire: [[12_000], [24_000], null] })],
      items: [work("a", { duration: 6, demands: [{ seat: "x", fte: 1, basis: "A" }] })],
    });
    const s = schedule(plan, AS_PLANNED);
    const l = ledger(plan, s);
    expect(l.labor[0]).toBeCloseTo(3_000, 9); // 12k + 24k; the third hire is not yet on payroll
    expect(l.labor[2]).toBeCloseTo(4_000, 9); // + the role's own 12k rate
    const dropped = schedule(plan, { ...AS_PLANNED, id: "d", dropHires: { x: [0] } });
    expect(dropped.hires.x).toEqual([0, 2]);
    expect(dropped.hireIndex.x).toEqual([1, 2]);
    expect(ledger(plan, dropped).labor[0]).toBeCloseTo(2_000, 9); // the 24k hire, not the 12k one
    const delayed = schedule(plan, { ...AS_PLANNED, id: "p", hireDelay: { x: [3, 0, -2] } });
    expect(delayed.hires.x).toEqual([3, 0, 0]);
    expect(delayed.hireIndex.x).toEqual([0, 1, 2]);
    expect(delayed.loads[0].capacity.slice(0, 4)).toEqual([2, 2, 2, 3]);
  });

  it("an unhired leadership seat cannot absorb: its item waits for the hire when leveling", () => {
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
      seats: [role("cto", { hireMonths: [4], unlevelled: true })],
      items: [work("a", { duration: 2, demands: [{ seat: "cto", fte: 0.3, basis: "A" }] })],
    });
    expect(scheduled(plan, "a", AS_PLANNED).start).toBe(0); // as planned: reported, not moved
    const leveled = scheduled(plan, "a", LEVELED);
    expect(leveled.start).toBe(4);
    expect(leveled.binding).toEqual({ kind: "hire", seat: "cto", carrier: "cto" });
    // A contribution from the unhired seat does not block an item someone else owns.
    const helped = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
      seats: [role("x"), role("cto", { hireMonths: [4], unlevelled: true })],
      items: [work("a", { duration: 2, demands: [{ seat: "x", fte: 0.5, basis: "A" }, { seat: "cto", fte: 0.05, basis: "A" }] })],
    });
    expect(scheduled(helped, "a", LEVELED).start).toBe(0);
    // Once the seat exists it absorbs any overload.
    const busy = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
      seats: [role("cto", { hireMonths: [0], unlevelled: true })],
      items: [work("a", { duration: 2, demands: [{ seat: "cto", fte: 3, basis: "A" }] })],
    });
    expect(scheduled(busy, "a", LEVELED).start).toBe(0);
  });

  it("a dropped item books nothing, warns nothing, and its dependents never arrive", () => {
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 6, fundingYearStartMonth: 0 },
      items: [work("a", { duration: 2 }), work("b", { duration: 2, predecessors: [{ id: "a" }] })],
    });
    const s = schedule(plan, { ...AS_PLANNED, id: "d", dropItems: ["a"] });
    const a = s.items.find((it) => it.item.id === "a")!;
    expect(a.dropped).toBe(true);
    expect(a.binding).toEqual({ kind: "dropped" });
    expect(s.bookings.filter((b) => b.item === "a")).toEqual([]);
    expect(s.items.find((it) => it.item.id === "b")!.beyond).toBe(true);
    const findings = lintAll(plan, s, ledger(plan, s));
    expect(findings.filter((f) => f.subject === "a")).toEqual([]);
  });

  it("a dropped item sits at the horizon and is never a slip, whichever month the baseline started it", () => {
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
      items: [
        work("p", { duration: 3 }),
        work("a", { predecessors: [{ id: "p" }] }), // pushed by p: baseline start 3, declared 0
        work("q", { earliest: 5 }), // baseline start is its declared month
      ],
    });
    const base = schedule(plan, AS_PLANNED);
    const s = schedule(plan, { ...AS_PLANNED, id: "d", dropItems: ["a", "q"] });
    expect(scheduled(plan, "a", AS_PLANNED).start).toBe(3);
    expect(scheduled(plan, "q", AS_PLANNED).start).toBe(5);
    for (const id of ["a", "q"]) {
      expect(s.items.find((it) => it.item.id === id)).toMatchObject({
        start: 12,
        end: 12,
        duration: 0,
        beyond: true,
        dropped: true,
        binding: { kind: "dropped" },
        carriers: [],
      });
    }
    expect(slips(base, s)).toEqual([]);
    // Dropped in the baseline and present in the other schedule: added, not moved.
    expect(slips(s, base)).toEqual([]);
  });

  it("a dependent of a dropped item still slips beyond the horizon", () => {
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
      items: [work("p", { duration: 3 }), work("a", { predecessors: [{ id: "p" }] }), work("b", { predecessors: [{ id: "a" }] })],
    });
    const base = schedule(plan, AS_PLANNED);
    const s = schedule(plan, { ...AS_PLANNED, id: "d", dropItems: ["a"] });
    expect(slips(base, s)).toEqual([
      { id: "b", label: "b", months: 12 - 4, beyond: true, binding: { kind: "predecessor", id: "a" } },
    ]);
  });

  it("W104 says a dependent of a dropped item never starts, not that capacity is short; W108 keeps the stream", () => {
    const stream = (id: string, unlockedBy: string) => ({
      id,
      label: id,
      unlockedBy,
      unit: "units",
      price: { usd: 10, basis: "A" as const, note: "audit price" },
      volumeByYear: { units: [120], basis: "A" as const, note: "audit volume" },
      rampMonths: 0,
    });
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
      items: [
        work("a"),
        work("b", { predecessors: [{ id: "a" }] }),
        work("c", { predecessors: [{ id: "b" }] }),
        work("long", { duration: 20 }),
        work("after", { predecessors: [{ id: "long" }] }),
      ],
      streams: [stream("from-a", "a"), stream("from-c", "c"), stream("from-long", "long")],
    });
    const s = schedule(plan, { ...AS_PLANNED, id: "d", dropItems: ["a"] });
    const findings = lintAll(plan, s, ledger(plan, s));
    const w104 = (id: string) => findings.find((f) => f.code === "W104" && f.subject === id)!;
    const w108 = (id: string) => findings.find((f) => f.code === "W108" && f.subject === id)!;

    expect(findings.filter((f) => f.subject === "a")).toEqual([]);
    expect(w104("b")).toMatchObject({
      severity: "warn",
      message: '"b" never starts: this scenario drops "a", which it depends on.',
      hint: 'Drop "b" from the scenario as well, or keep "a".',
    });
    expect(w104("c")).toMatchObject({
      severity: "warn",
      message: '"c" never starts: this scenario drops "a", which it depends on through "b".',
      hint: 'Drop "c" from the scenario as well, or keep "a".',
    });
    expect(w108("from-a").hint).toBe('Its item "a" is dropped in this scenario.');
    expect(w108("from-c").hint).toBe('Its item "c" never starts: this scenario drops "a", which it depends on.');

    // An item beyond the horizon for any other reason keeps the capacity wording.
    expect(w104("long")).toMatchObject({
      message: '"long" does not fit inside the horizon: its run would extend past the horizon.',
      hint: "Lower the effort assumption, add a seat, or drop the item.",
    });
    expect(w104("after").message).toBe('"after" does not fit inside the horizon: "long" never finishes.');
    expect(w108("from-long").hint).toBe('Its item "long" does not finish by 2027-12.');
    // One W104 per item, and none for the dropped item: no second, contradictory finding.
    expect(findings.filter((f) => f.code === "W104").map((f) => f.subject)).toEqual(["b", "c", "long", "after"]);
  });

  it("W104 and W108 name every drop upstream, whichever predecessor sorts first, and anything else that does not fit", () => {
    const stream = (id: string, unlockedBy: string) => ({
      id,
      label: id,
      unlockedBy,
      unit: "units",
      price: { usd: 10, basis: "A" as const, note: "audit price" },
      volumeByYear: { units: [120], basis: "A" as const, note: "audit volume" },
      rampMonths: 0,
    });
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
      items: [
        work("a", { label: "Pilot A" }),
        work("z", { label: "Pilot Z" }),
        work("long", { label: "Long build", duration: 20 }),
        work("long2", { label: "Second long build", duration: 15 }),
        work("w1", { label: "W1", predecessors: [{ id: "a" }, { id: "long" }] }), // the drop sorts first
        work("w2", { label: "W2", predecessors: [{ id: "long" }, { id: "z" }] }), // the drop sorts last
        work("w3", { label: "W3", predecessors: [{ id: "a" }, { id: "z" }] }), // two drops
        work("w4", { label: "W4", predecessors: [{ id: "w1" }, { id: "w3" }] }), // a diamond onto both drops
        work("w5", { label: "W5", predecessors: [{ id: "long2" }, { id: "a" }, { id: "long" }] }), // declared out of id order
        work("after", { label: "After", predecessors: [{ id: "long" }] }), // no drop upstream
      ],
      streams: [stream("from-w2", "w2"), stream("from-w3", "w3")],
    });
    const s = schedule(plan, { ...AS_PLANNED, id: "d", dropItems: ["a", "z"] });
    expect(s.items.find((it) => it.item.id === "w2")!.binding).toEqual({ kind: "predecessor", id: "long" });
    const findings = lintAll(plan, s, ledger(plan, s));

    // Labels in the message, ids in the hint (dropItems takes ids).
    expect(findings.filter((f) => f.code === "W104").map(({ subject, message, hint }) => ({ subject, message, hint }))).toEqual([
      {
        subject: "long",
        message: '"Long build" does not fit inside the horizon: its run would extend past the horizon.',
        hint: "Lower the effort assumption, add a seat, or drop the item.",
      },
      {
        subject: "long2",
        message: '"Second long build" does not fit inside the horizon: its run would extend past the horizon.',
        hint: "Lower the effort assumption, add a seat, or drop the item.",
      },
      {
        subject: "w1",
        message: '"W1" never starts: this scenario drops "Pilot A", which it depends on, and "Long build" does not fit inside the horizon.',
        hint: 'Drop "w1" from the scenario as well, or keep "a" and fit "long" inside the horizon.',
      },
      {
        subject: "w2",
        message: '"W2" never starts: this scenario drops "Pilot Z", which it depends on, and "Long build" does not fit inside the horizon.',
        hint: 'Drop "w2" from the scenario as well, or keep "z" and fit "long" inside the horizon.',
      },
      {
        subject: "w3",
        message: '"W3" never starts: this scenario drops "Pilot A" and "Pilot Z", which it depends on.',
        hint: 'Drop "w3" from the scenario as well, or keep "a" and "z".',
      },
      {
        subject: "w4",
        message: '"W4" never starts: this scenario drops "Pilot A" and "Pilot Z", which it depends on, and "Long build" does not fit inside the horizon.',
        hint: 'Drop "w4" from the scenario as well, or keep "a" and "z" and fit "long" inside the horizon.',
      },
      {
        subject: "w5",
        message: '"W5" never starts: this scenario drops "Pilot A", which it depends on, and "Long build" and "Second long build" do not fit inside the horizon.',
        hint: 'Drop "w5" from the scenario as well, or keep "a" and fit "long" and "long2" inside the horizon.',
      },
      {
        subject: "after",
        message: '"After" does not fit inside the horizon: "Long build" never finishes.',
        hint: "Lower the effort assumption, add a seat, or drop the item.",
      },
    ]);
    const w108 = (id: string) => findings.find((f) => f.code === "W108" && f.subject === id)!;
    expect(w108("from-w2").hint).toBe('Its item "w2" never starts: this scenario drops "z", which it depends on, and "long" does not fit inside the horizon.');
    expect(w108("from-w3").hint).toBe('Its item "w3" never starts: this scenario drops "a" and "z", which it depends on.');
  });

  it("W104 and W108 trace through a drop to what would still hold it if kept, unless it is underway", () => {
    const stream = (id: string, unlockedBy: string) => ({
      id,
      label: id,
      unlockedBy,
      unit: "units",
      price: { usd: 10, basis: "A" as const, note: "audit price" },
      volumeByYear: { units: [120], basis: "A" as const, note: "audit volume" },
      rampMonths: 0,
    });
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
      items: [
        work("pilot", { label: "Pilot" }),
        work("phase2", { label: "Phase 2", predecessors: [{ id: "pilot" }] }),
        work("rollout", { label: "Rollout", predecessors: [{ id: "phase2" }] }), // a drop behind a drop
        work("setup", { label: "Setup" }),
        work("big", { label: "Big build", duration: 20, predecessors: [{ id: "setup" }] }),
        work("mid", { label: "Mid", predecessors: [{ id: "big" }] }),
        work("after", { label: "After", predecessors: [{ id: "mid" }] }), // an item that does not fit, behind a drop
        work("legacy", { label: "Legacy", duration: 2, underway: true, predecessors: [{ id: "big" }] }),
        work("user", { label: "User", predecessors: [{ id: "legacy" }] }), // kept, underway work waits for nothing
        work("run", { label: "Run", duration: 20, underway: true }),
        work("tail", { label: "Tail", predecessors: [{ id: "run" }, { id: "pilot" }] }),
        work("a-wrap", { label: "A wrap", predecessors: [{ id: "pilot" }] }),
        work("direct", { label: "Direct", predecessors: [{ id: "pilot" }, { id: "a-wrap" }] }), // binding "a-wrap", drop also direct
        work("indirect", { label: "Indirect", predecessors: [{ id: "a-wrap" }] }),
      ],
      streams: [stream("from-phase2", "phase2"), stream("from-rollout", "rollout"), stream("from-after", "after")],
    });
    const s = schedule(plan, { ...AS_PLANNED, id: "d", dropItems: ["pilot", "phase2", "mid", "legacy"] });
    expect(s.items.find((it) => it.item.id === "direct")!.binding).toEqual({ kind: "predecessor", id: "a-wrap" });
    const findings = lintAll(plan, s, ledger(plan, s));

    expect(findings.filter((f) => f.code === "W104").map(({ subject, message, hint }) => ({ subject, message, hint }))).toEqual([
      {
        subject: "rollout",
        message: '"Rollout" never starts: this scenario drops "Phase 2" and "Pilot", which it depends on.',
        hint: 'Drop "rollout" from the scenario as well, or keep "phase2" and "pilot".',
      },
      {
        subject: "big",
        message: '"Big build" does not fit inside the horizon: its run would extend past the horizon.',
        hint: "Lower the effort assumption, add a seat, or drop the item.",
      },
      {
        subject: "after",
        message: '"After" never starts: this scenario drops "Mid", which it depends on, and "Big build" does not fit inside the horizon.',
        hint: 'Drop "after" from the scenario as well, or keep "mid" and fit "big" inside the horizon.',
      },
      {
        subject: "user",
        message: '"User" never starts: this scenario drops "Legacy", which it depends on.',
        hint: 'Drop "user" from the scenario as well, or keep "legacy".',
      },
      {
        subject: "run",
        message: '"Run" does not fit inside the horizon: its run would extend past the horizon.',
        hint: "Lower the effort assumption, add a seat, or drop the item.",
      },
      {
        subject: "tail",
        message: '"Tail" never starts: this scenario drops "Pilot", which it depends on, and "Run" does not fit inside the horizon.',
        hint: 'Drop "tail" from the scenario as well, or keep "pilot" and fit "run" inside the horizon.',
      },
      {
        subject: "a-wrap",
        message: '"A wrap" never starts: this scenario drops "Pilot", which it depends on.',
        hint: 'Drop "a-wrap" from the scenario as well, or keep "pilot".',
      },
      {
        subject: "direct",
        message: '"Direct" never starts: this scenario drops "Pilot", which it depends on.',
        hint: 'Drop "direct" from the scenario as well, or keep "pilot".',
      },
      {
        subject: "indirect",
        message: '"Indirect" never starts: this scenario drops "Pilot", which it depends on through "A wrap".',
        hint: 'Drop "indirect" from the scenario as well, or keep "pilot".',
      },
    ]);
    const w108 = (id: string) => findings.find((f) => f.code === "W108" && f.subject === id)!;
    expect(w108("from-phase2").hint).toBe('Its item "phase2" is dropped in this scenario.');
    expect(w108("from-rollout").hint).toBe('Its item "rollout" never starts: this scenario drops "phase2" and "pilot", which it depends on.');
    expect(w108("from-after").hint).toBe('Its item "after" never starts: this scenario drops "mid", which it depends on, and "big" does not fit inside the horizon.');
  });

  it("priority books ahead of the id order inside a circle", () => {
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 6, fundingYearStartMonth: 0 },
      items: [work("a", { duration: 2 }), work("b", { duration: 2, priority: -1 })],
    });
    expect(scheduled(plan, "b").start).toBe(0);
    expect(scheduled(plan, "a").start).toBe(2);
  });

  it("levelOn owner: a contributor's full seat does not hold the item; the owner's does", () => {
    const seats = [role("x"), role("y", { hireMonths: [6] })];
    const items = [work("a", { duration: 2, demands: [{ seat: "x", fte: 1, basis: "A" }, { seat: "y", fte: 0.1, basis: "A" }] })];
    const all = fixture({ calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 }, seats, items });
    expect(scheduled(all, "a", LEVELED).start).toBe(6);
    const owner = fixture({ ...all, levelOn: "owner" });
    expect(scheduled(owner, "a", LEVELED).start).toBe(0);
    const ownerLate = fixture({ ...all, levelOn: "owner", seats: [role("x", { hireMonths: [3] }), role("y")] });
    expect(scheduled(ownerLate, "a", LEVELED).start).toBe(3);
  });
});

const year = { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 };

describe("an unlevelled seat with a seat fallback", () => {
  const seats = (fallback: SeatDef["fallback"]) => [role("x"), role("y"), role("cto", { hireMonths: [4], unlevelled: true, fallback })];
  const busy = (duration: number) => work("busy", { duration });

  it("holds an item it owns for room on the fallback, not for its hire", () => {
    const owned = work("owned", { duration: 2, demands: [{ seat: "cto", fte: 0.5, basis: "A" }] });
    const plan = fixture({ calendar: year, seats: seats("x"), items: [busy(2), owned] });
    const leveled = scheduled(plan, "owned");
    expect(leveled.start).toBe(2);
    expect(leveled.binding).toEqual({ kind: "capacity", seat: "cto", carrier: "x" });
    expect(leveled.carriers).toEqual([{ seat: "cto", carrier: "x", fte: 0.5 }]);
    // With room on the fallback it starts at once, four months before the hire.
    expect(scheduled(fixture({ calendar: year, seats: seats("x"), items: [owned] }), "owned").start).toBe(0);
    // With no fallback the same item waits for the hire.
    expect(scheduled(fixture({ calendar: year, seats: seats(null), items: [busy(2), owned] }), "owned").start).toBe(4);
  });

  it("levels its contribution to another seat's item on the fallback until the hire", () => {
    const helped = work("helped", {
      duration: 2,
      owner: "y",
      demands: [
        { seat: "y", fte: 0.5, basis: "A" },
        { seat: "cto", fte: 0.2, basis: "A" },
      ],
    });
    const plan = fixture({ calendar: year, seats: seats("x"), items: [busy(2), helped] });
    const leveled = scheduled(plan, "helped");
    expect(leveled.start).toBe(2);
    expect(leveled.binding).toEqual({ kind: "capacity", seat: "cto", carrier: "x" });
    // From its hire the seat carries its own contribution, so a fallback busy past month 4 holds
    // the item only until then...
    expect(scheduled(fixture({ calendar: year, seats: seats("x"), items: [busy(6), helped] }), "helped").start).toBe(4);
    // ...even when the hired seat is full: once hired it absorbs rather than levels.
    const full = work("full", { earliest: 4, duration: 2, priority: -1, demands: [{ seat: "cto", fte: 1, basis: "A" }] });
    expect(scheduled(fixture({ calendar: year, seats: seats("x"), items: [full, busy(6), helped] }), "helped").start).toBe(4);
    // With no fallback the contribution is unstaffed and holds nothing.
    expect(scheduled(fixture({ calendar: year, seats: seats(null), items: [busy(2), helped] }), "helped").start).toBe(0);
  });
});

describe("levelOn owner", () => {
  it("binds an unlevelled owner only before its first hire", () => {
    const own = (id: string, fte: number) => work(id, { duration: 2, demands: [{ seat: "cto", fte, basis: "A" }] });
    const plan = (hireMonths: number[], items: WorkItem[]) =>
      fixture({ calendar: year, levelOn: "owner", seats: [role("cto", { hireMonths, unlevelled: true })], items });
    const a = scheduled(plan([4], [own("a", 0.3)]), "a");
    expect(a.start).toBe(4);
    expect(a.binding).toEqual({ kind: "capacity", seat: "cto", carrier: "cto" });
    // From its first hire it absorbs: two full-time items held for the hire both start there,
    // and the overload is reported rather than leveled.
    const s = schedule(plan([4], [own("a", 1), own("b", 1)]), LEVELED);
    expect(s.items.map((it) => it.start)).toEqual([4, 4]);
    expect(overloads(s)).toEqual([{ seat: "cto", months: [4, 5], peak: 1 }]);
    // A second hire still to come holds nothing.
    expect(schedule(plan([4, 8], [own("a", 1), own("b", 1), own("c", 1)]), LEVELED).items.map((it) => it.start)).toEqual([4, 4, 4]);
  });

  it("binds a contributor's demand that falls back onto the owner's seat", () => {
    const items = [
      work("task", {
        duration: 2,
        owner: "x",
        demands: [
          { seat: "x", fte: 0.6, basis: "A" },
          { seat: "aide", fte: 0.6, basis: "A" },
        ],
      }),
    ];
    const plan = fixture({ calendar: year, levelOn: "owner", seats: [role("x"), role("aide", { hireMonths: [4], fallback: "x" })], items });
    const task = scheduled(plan, "task");
    expect(task.start).toBe(4);
    // What binds is the owner's carrier; the contributor's id sorts first, so the binding names its seat.
    expect(task.binding).toEqual({ kind: "capacity", seat: "aide", carrier: "x" });
    // Without the fallback, aide's demand stays on its own empty seat, a contributor, and holds nothing.
    expect(scheduled(fixture({ calendar: year, levelOn: "owner", seats: [role("x"), role("aide", { hireMonths: [4] })], items }), "task").start).toBe(0);
  });

  it("does not bind the owner's own demand while a fallback carries it", () => {
    const seats = [role("x"), role("y", { hireMonths: [4], fallback: "x" })];
    const items = [work("busy", { duration: 2 }), work("owned", { duration: 2, demands: [{ seat: "y", fte: 0.5, basis: "A" }] })];
    const plan = fixture({ calendar: year, levelOn: "owner", seats, items });
    const owned = scheduled(plan, "owned");
    expect(owned.start).toBe(0);
    expect(owned.carriers).toEqual([{ seat: "y", carrier: "x", fte: 0.5 }]);
    expect(overloads(schedule(plan, LEVELED))).toEqual([{ seat: "x", months: [0, 1], peak: 0.5 }]);
    // Leveling on every seat waits for room on the fallback instead.
    expect(scheduled(fixture({ calendar: year, seats, items }), "owned").start).toBe(2);
  });

  it("lists a contributor overload below the W101 thresholds in overloads without W101", () => {
    const plan = (duration: number) =>
      fixture({
        calendar: year,
        levelOn: "owner",
        seats: [role("x"), role("y")],
        items: [
          work("load", { duration, demands: [{ seat: "y", fte: 1, basis: "A" }] }),
          work("task", {
            duration,
            owner: "x",
            demands: [
              { seat: "x", fte: 0.5, basis: "A" },
              { seat: "y", fte: 0.2, basis: "A" },
            ],
          }),
        ],
      });
    const w101 = (p: Plan) => {
      const s = schedule(p, LEVELED);
      return lintAll(p, s, ledger(p, s)).filter((f) => f.code === "W101");
    };
    const short = plan(2);
    expect(scheduled(short, "task").start).toBe(0);
    const [overload, ...rest] = overloads(schedule(short, LEVELED));
    expect(rest).toEqual([]);
    expect(overload).toMatchObject({ seat: "y", months: [0, 1] });
    expect(overload.peak).toBeCloseTo(0.2, 12);
    expect(w101(short)).toEqual([]); // two months, +0.2 FTE: under both default thresholds
    expect(w101(plan(3)).map((f) => f.subject)).toEqual(["y"]); // a third month reaches overloadMonths
  });
});

describe("booking order", () => {
  it("moves no start by priority when the scenario does not level", () => {
    const items = (priority?: number) => [work("a", { duration: 2 }), work("b", { duration: 2, priority })];
    const plain = schedule(fixture({ items: items() }), AS_PLANNED);
    expect(plain.items.map((it) => it.start)).toEqual([0, 0]);
    expect(plain.loads[0].demand).toEqual([2, 2, 0, 0, 0, 0]);
    // Booked ahead of a (-1) or behind it (1), b starts with it: only leveling moves work.
    // (The bookings list still comes out in priority order.)
    for (const priority of [-1, 1]) {
      const prioritized = schedule(fixture({ items: items(priority) }), AS_PLANNED);
      expect(prioritized.items.map((it) => [it.start, it.end, it.binding])).toEqual(plain.items.map((it) => [it.start, it.end, it.binding]));
      expect(prioritized.loads).toEqual(plain.loads);
    }
    // The same priority decides the order once the scenario levels.
    expect(scheduled(fixture({ items: items(-1) }), "a").start).toBe(2);
  });

  it("books an earlier circle ahead of a later circle's lower priority", () => {
    const plan = fixture({
      circles: ["core", "later"],
      items: [work("a", { duration: 2, circle: "later", priority: -10 }), work("b", { duration: 2, priority: 10 })],
    });
    expect(scheduled(plan, "b").start).toBe(0);
    const a = scheduled(plan, "a");
    expect(a.start).toBe(2);
    expect(a.binding).toEqual({ kind: "capacity", seat: "x", carrier: "x" });
  });

  it("takes a successor's predecessors in id order, whatever their priority", () => {
    const predecessors = [work("pa", { duration: 2, priority: 5 }), work("pb", { duration: 2, priority: -5 })];
    const alone = fixture({ items: predecessors });
    expect([scheduled(alone, "pa").start, scheduled(alone, "pb").start]).toEqual([2, 0]);
    // A higher-priority successor pulls its predecessors in ahead of it, by id: pa first.
    const pulled = fixture({ items: [...predecessors, work("s", { priority: -10, predecessors: [{ id: "pb" }, { id: "pa" }] })] });
    expect([scheduled(pulled, "pa").start, scheduled(pulled, "pb").start]).toEqual([0, 2]);
    const s = scheduled(pulled, "s");
    expect(s.start).toBe(4);
    expect(s.binding).toEqual({ kind: "predecessor", id: "pb" });
  });
});

describe("dropItems", () => {
  it("runs an underway dependent of a dropped item and takes a standing one beyond", () => {
    const plan = fixture({
      seats: [role("x", { capacityFte: 3 })],
      items: [
        work("a", { duration: 2 }),
        work("u", { earliest: 1, duration: 2, underway: true, predecessors: [{ id: "a" }] }),
        work("st", { standing: true, predecessors: [{ id: "a" }] }),
      ],
    });
    expect(scheduled(plan, "st", AS_PLANNED).start).toBe(2); // with a, st starts when a ends
    for (const level of [false, true]) {
      const s = schedule(plan, { ...AS_PLANNED, id: "drop", level, dropItems: ["a"] });
      const byId = (id: string) => s.items.find((it) => it.item.id === id)!;
      expect(byId("u")).toMatchObject({ start: 1, end: 3, duration: 2, beyond: false, binding: { kind: "underway" } });
      expect(s.bookings.filter((b) => b.item === "u").map((b) => b.month)).toEqual([1, 2]);
      expect(byId("st")).toMatchObject({ start: 6, end: 6, duration: 0, beyond: true, binding: { kind: "predecessor", id: "a" }, carriers: [] });
      expect(byId("st").dropped).toBeUndefined();
      expect(s.bookings.filter((b) => b.item === "st")).toEqual([]);
    }
  });
});

describe("loadedAnnualByHire", () => {
  it("uses year 1 before the funding year opens and escalates only the role's rate", () => {
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 30, fundingYearStartMonth: 3 },
      escalation: { rate: 0.1, basis: "A" },
      seats: [role("x", { hireMonths: [0, 0], loadedAnnualByHire: [[6_000, 24_000], null] })],
    });
    const seat = plan.seats[0];
    const labor = ledger(plan, schedule(plan, AS_PLANNED)).labor;
    // Months 0-2 precede funding year 1 (months 3-14) and cost the same as it: the hire's own
    // year-1 value, not the role's 12,000, and the role's unescalated rate for the null hire.
    for (const m of [0, 2, 3, 14]) {
      expect(hireMonthlyCost(plan, seat, 0, m)).toBeCloseTo(500, 9);
      expect(hireMonthlyCost(plan, seat, 1, m)).toBeCloseTo(1_000, 9);
      expect(labor[m]).toBeCloseTo(1_500, 9);
    }
    // Year 2: the hire's own second value, unescalated; the null hire at the role's rate escalated once.
    expect(hireMonthlyCost(plan, seat, 0, 15)).toBeCloseTo(2_000, 9);
    expect(hireMonthlyCost(plan, seat, 1, 15)).toBeCloseTo(1_100, 9);
    expect(labor[15]).toBeCloseTo(3_100, 9);
    // Year 3: the hire's schedule holds its last value, still unescalated; the role's rate escalates again.
    expect(hireMonthlyCost(plan, seat, 0, 27)).toBeCloseTo(2_000, 9);
    expect(hireMonthlyCost(plan, seat, 1, 27)).toBeCloseTo(1_210, 9);
    expect(labor[27]).toBeCloseTo(3_210, 9);
  });
});
