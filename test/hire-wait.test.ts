import { describe, expect, it } from "vitest";
import { AS_PLANNED, LEVELED, ledger, lintAll, schedule, type Plan, type Scenario, type SeatDef, type WorkItem } from "../src/index";

// Leveling waits for two different things, and the binding says which. A seat that is hired but
// full is a capacity binding: "no room on X". A seat nobody is hired to yet is a hire binding:
// the item waits for the hire, and pulling the hire forward is what moves it. The two used to
// print the same "no room" text, which pointed a reader at the seat's workload when the
// answer was its hire date.

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
  duration: 3,
  standing: false,
  predecessors: [],
  demands: [{ seat: "x", fte: 1, basis: "A" }],
  underway: false,
  ...over,
});

const fixture = (over: Partial<Plan> = {}): Plan => ({
  name: "hire-wait fixture",
  calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
  circles: ["core"],
  seats: [role("x")],
  items: [],
  streams: [],
  funding: [],
  nonLabor: [],
  escalation: { rate: 0, basis: "A" },
  ...over,
});

const at = (plan: Plan, id: string, scenario: Scenario = LEVELED) => schedule(plan, scenario).items.find((s) => s.item.id === id)!;

const w104 = (plan: Plan, id: string, scenario: Scenario = LEVELED) => {
  const s = schedule(plan, scenario);
  return lintAll(plan, s, ledger(plan, s)).find((f) => f.code === "W104" && f.subject === id);
};

describe("an item that waits for a hire", () => {
  it("names the hire when the seat it needs has nobody yet, and says when the hire lands", () => {
    // The founding CTO arrives in month 6; leadership absorbs once hired, but an item it owns
    // cannot land on the empty seat.
    const plan = fixture({
      seats: [role("cto", { title: "CTO", unlevelled: true, hireMonths: [6] })],
      items: [work("arch", { label: "Architecture", demands: [{ seat: "cto", fte: 0.5, basis: "A" }] })],
    });
    expect(at(plan, "arch")).toMatchObject({ start: 6, end: 9, binding: { kind: "hire", seat: "cto", carrier: "cto" } });
    expect(w104(plan, "arch")).toMatchObject({
      message: '"Architecture" starts 6 months after its declared 2027-01: waits for the CTO hire in 2027-07.',
      hint: "Pull the CTO hire forward, or declare the start later.",
    });
    // As planned nothing waits: the load sits on the empty seat and W103 says so.
    expect(at(plan, "arch", AS_PLANNED)).toMatchObject({ start: 0, binding: { kind: "declared" } });
  });

  it("does the same on a seat leveling always waits for", () => {
    const plan = fixture({ seats: [role("ops", { title: "Operations", hireMonths: [4] })], items: [work("run", { demands: [{ seat: "ops", fte: 1, basis: "A" }] })] });
    expect(at(plan, "run")).toMatchObject({ start: 4, binding: { kind: "hire", seat: "ops", carrier: "ops" } });
    expect(w104(plan, "run")!.message).toBe('"run" starts 4 months after its declared 2027-01: waits for the Operations hire in 2027-05.');
  });

  it("keeps a full seat a capacity binding, even when the start is the month a second hire lands", () => {
    // x has one person from month 0 and a second from month 4; busy fills the first until then.
    const plan = fixture({
      seats: [role("x", { hireMonths: [0, 4] })],
      items: [work("busy", { priority: -1, duration: 12 }), work("more", { duration: 2 })],
    });
    expect(at(plan, "more")).toMatchObject({ start: 4, binding: { kind: "capacity", seat: "x", carrier: "x" } });
    expect(w104(plan, "more")!.message).toBe('"more" starts 4 months after its declared 2027-01: no room on x.');
  });

  it("names the fallback's hire when the seat's work waits on an empty fallback", () => {
    // Writer w has no hire inside the horizon and falls back to the lead, who arrives in month 5.
    const plan = fixture({
      seats: [role("w", { title: "Writer", hireMonths: [12], fallback: "lead" }), role("lead", { title: "Lead", hireMonths: [5] })],
      items: [work("draft", { demands: [{ seat: "w", fte: 0.5, basis: "A" }] })],
    });
    const s = at(plan, "draft");
    expect(s).toMatchObject({ start: 5, binding: { kind: "hire", seat: "w", carrier: "lead" } });
    expect(s.carriers).toEqual([{ seat: "w", carrier: "lead", fte: 0.5 }]);
    expect(w104(plan, "draft")).toMatchObject({
      message: '"draft" starts 5 months after its declared 2027-01: waits for the Lead hire in 2027-06 to carry Writer\'s work.',
      hint: "Pull the Lead hire forward, or declare the start later.",
    });
    // Hired but full, the lead is a capacity binding again.
    const full = fixture({
      seats: [role("w", { title: "Writer", hireMonths: [12], fallback: "lead" }), role("lead", { title: "Lead" })],
      items: [work("keep", { priority: -1, duration: 5, demands: [{ seat: "lead", fte: 1, basis: "A" }] }), work("draft", { demands: [{ seat: "w", fte: 0.5, basis: "A" }] })],
    });
    expect(at(full, "draft")).toMatchObject({ start: 5, binding: { kind: "capacity", seat: "w", carrier: "lead" } });
  });

  it("names the seat's own hire when the seat is hired before its empty fallback", () => {
    const plan = fixture({
      seats: [role("w", { title: "Writer", hireMonths: [3], fallback: "lead" }), role("lead", { title: "Lead", hireMonths: [9] })],
      items: [work("draft", { demands: [{ seat: "w", fte: 0.5, basis: "A" }] })],
    });
    expect(at(plan, "draft")).toMatchObject({ start: 3, binding: { kind: "hire", seat: "w", carrier: "lead" } });
    expect(w104(plan, "draft")!.message).toBe('"draft" starts 3 months after its declared 2027-01: waits for the Writer hire in 2027-04.');
  });

  it("names the hire when the run asks nothing of the seat until later, and the month the hire lands", () => {
    // A six-month build that needs the engineer only from its fourth month: it starts in month
    // 3 so that its first engineer month is the hire's.
    const plan = fixture({
      seats: [role("eng", { title: "Engineer", hireMonths: [6] })],
      items: [work("build", { label: "Build", duration: 6, demands: [{ seat: "eng", fte: 1, profile: [0, 1], basis: "A" }] })],
    });
    expect(at(plan, "build")).toMatchObject({ start: 3, end: 9, binding: { kind: "hire", seat: "eng", carrier: "eng" } });
    expect(w104(plan, "build")!.message).toBe('"Build" starts 3 months after its declared 2027-01: waits for the Engineer hire in 2027-07.');
    const never = fixture({ seats: [role("eng", { title: "Engineer", hireMonths: [12] })], items: plan.items });
    expect(at(never, "build")).toMatchObject({ beyond: true, binding: { kind: "hire", seat: "eng", carrier: "eng" } });
    expect(w104(never, "build")!.message).toBe('"Build" does not fit inside the horizon: this scenario does not hire Engineer inside the horizon.');
  });

  it("does not call it a hire when standing work asks for the empty seat only in the horizon's last month", () => {
    // From month 0 the run's second quarter reaches month 3, the last, on a seat nobody fills;
    // from month 1 the run ends before its second quarter, so it fits with no hire at all.
    const plan = fixture({
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 4, fundingYearStartMonth: 0 },
      seats: [role("s0", { hireMonths: [4] })],
      items: [work("keep", { standing: true, demands: [{ seat: "s0", fte: 1, profile: [0, 1], basis: "A" }] })],
    });
    expect(at(plan, "keep")).toMatchObject({ start: 1, binding: { kind: "capacity", seat: "s0", carrier: "s0" } });
  });

  it("calls standing work a hire wait when its seat is never hired inside the horizon", () => {
    // Every start is refused, the last one in the horizon's only remaining month: no later start
    // exists to drop it, so the wait is for a hire that never comes.
    const plan = fixture({
      seats: [role("cto", { title: "CTO", unlevelled: true, hireMonths: [20] })],
      items: [work("ops", { label: "Ops", standing: true, demands: [{ seat: "cto", fte: 0.5, basis: "A" }] })],
    });
    expect(at(plan, "ops")).toMatchObject({ beyond: true, binding: { kind: "hire", seat: "cto", carrier: "cto" } });
    expect(w104(plan, "ops")).toMatchObject({
      message: '"Ops" does not fit inside the horizon: this scenario does not hire CTO inside the horizon.',
      hint: "Hire CTO inside the horizon, or drop the item.",
    });
  });

  it("does not call it a hire when the item asks nothing of the empty role that month", () => {
    // Underway work already sits on c, which nobody fills until month 4. a's first quarter asks
    // nothing of c; what keeps it out is c's other load, so the binding is capacity.
    const plan = fixture({
      seats: [role("c", { hireMonths: [4] })],
      items: [
        work("u", { underway: true, standing: true, demands: [{ seat: "c", fte: 1, basis: "A" }] }),
        work("a", { duration: 6, demands: [{ seat: "c", fte: 1, profile: [0, 1], basis: "A" }] }),
      ],
    });
    expect(at(plan, "a")).toMatchObject({ beyond: true, binding: { kind: "capacity", seat: "c", carrier: "c" } });
  });
});

describe("an item that waits for a hire that comes too late", () => {
  it("says the seat is not hired until after the last month its run could start", () => {
    // Four months of work, a twelve-month horizon: the run must start by month 8, and the CTO
    // arrives in month 10.
    const plan = fixture({
      seats: [role("cto", { title: "CTO", unlevelled: true, hireMonths: [10] })],
      items: [work("arch", { label: "Architecture", duration: 4, demands: [{ seat: "cto", fte: 0.5, basis: "A" }] })],
    });
    expect(at(plan, "arch")).toMatchObject({ beyond: true, binding: { kind: "hire", seat: "cto", carrier: "cto" } });
    expect(w104(plan, "arch")).toMatchObject({
      message: '"Architecture" does not fit inside the horizon: CTO is not hired until 2027-11, after the last month its run could start.',
      hint: "Hire CTO earlier, with room for this item, or drop the item.",
    });
  });

  it("says the scenario does not hire the seat when it never does", () => {
    const plan = fixture({
      seats: [role("cto", { title: "CTO", unlevelled: true, hireMonths: [4] })],
      items: [work("arch", { label: "Architecture", demands: [{ seat: "cto", fte: 0.5, basis: "A" }] })],
    });
    const scenario: Scenario = { ...LEVELED, id: "no-cto", dropSeats: ["cto"] };
    expect(at(plan, "arch", scenario)).toMatchObject({ beyond: true, binding: { kind: "hire", seat: "cto", carrier: "cto" } });
    expect(w104(plan, "arch", scenario)).toMatchObject({
      message: '"Architecture" does not fit inside the horizon: this scenario does not hire CTO inside the horizon.',
      hint: "Hire CTO inside the horizon, or drop the item.",
    });
  });

  it("follows the fallback chain: nobody carrying the seat's work arrives in time, or at all", () => {
    const seats = (lead: number[]) => [role("w", { title: "Writer", hireMonths: [12], fallback: "lead" }), role("lead", { title: "Lead", hireMonths: lead })];
    const items = [work("draft", { duration: 4, demands: [{ seat: "w", fte: 0.5, basis: "A" }] })];
    const late = fixture({ seats: seats([10]), items });
    expect(at(late, "draft")).toMatchObject({ beyond: true, binding: { kind: "hire", seat: "w", carrier: "lead" } });
    expect(w104(late, "draft")).toMatchObject({
      message: '"draft" does not fit inside the horizon: nobody is hired to carry Writer\'s work until 2027-11, after the last month its run could start.',
      hint: "Hire Lead earlier, with room for this item, or drop the item.",
    });
    const never = fixture({ seats: seats([12]), items });
    expect(w104(never, "draft")!.message).toBe('"draft" does not fit inside the horizon: this scenario hires nobody to carry Writer\'s work inside the horizon.');
  });

  it("stays a capacity binding when the seat is hired but full through the last possible start", () => {
    const plan = fixture({ items: [work("busy", { priority: -1, duration: 12 }), work("more", { duration: 2 })] });
    expect(at(plan, "more")).toMatchObject({ beyond: true, binding: { kind: "capacity", seat: "x", carrier: "x" } });
    expect(w104(plan, "more")!.message).toBe('"more" does not fit inside the horizon: leveling found no start with room for it; the last seat without room was x.');
  });
});
