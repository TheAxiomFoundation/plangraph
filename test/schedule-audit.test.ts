import { describe, expect, it } from "vitest";
import {
  AS_PLANNED,
  LEVELED,
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

    expect(b).toMatchObject({
      start: 4,
      end: 4,
      duration: 0,
      beyond: true,
      binding: { kind: "horizon" },
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

    expect(standing).toMatchObject({
      start: 3,
      end: 3,
      duration: 0,
      beyond: true,
      binding: { kind: "horizon" },
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

  it("A5 chooses the same equal-shortfall capacity binding after demand permutation", () => {
    const make = (demands: WorkItem["demands"]): Plan =>
      fixture({
        seats: [role("x", { hireMonths: [1] }), role("y", { hireMonths: [1] })],
        items: [work("both", { owner: "x", demands })],
      });
    const xy = [
      { seat: "x", fte: 1, basis: "A" as const },
      { seat: "y", fte: 1, basis: "A" as const },
    ];

    const left = scheduled(make(xy), "both");
    const right = scheduled(make([...xy].reverse()), "both");

    expect(left.start).toBe(1);
    expect(right.start).toBe(1);
    expect(left.binding).toEqual({ kind: "capacity", seat: "x", carrier: "x" });
    expect(right.binding).toEqual(left.binding);
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

    expect(slips(baseline, delayed)).toEqual([
      {
        id: "late",
        label: "late",
        months: 3,
        beyond: true,
        binding: { kind: "horizon" },
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
    expect(leveled.binding).toEqual({ kind: "capacity", seat: "cto", carrier: "cto" });
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

  it("priority books ahead of the id order inside a circle", () => {
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 6, fundingYearStartMonth: 0 },
      items: [work("a", { duration: 2 }), work("b", { duration: 2, priority: -1 })],
    });
    expect(scheduled(plan, "b").start).toBe(0);
    expect(scheduled(plan, "a").start).toBe(2);
  });
});
