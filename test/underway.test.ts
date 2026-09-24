import { describe, expect, it } from "vitest";
import {
  AS_PLANNED,
  LEVELED,
  ledger,
  lintAll,
  overloads,
  ownerOf,
  schedule,
  type Plan,
  type Scenario,
  type Schedule,
  type SeatDef,
  type WorkItem,
} from "../src/index";
import { loadPlanFile } from "../src/node";

// Underway work is a fact: its start is not a decision, so leveling cannot move it. The
// scheduler books every underway item before any planned item, so wherever leveling waits for
// room it counts underway load, whatever the circles, priorities and ids say.

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
  name: "underway fixture",
  calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
  circles: ["core", "later"],
  seats: [role("x")],
  items: [],
  streams: [],
  funding: [],
  nonLabor: [],
  escalation: { rate: 0, basis: "A" },
  ...over,
});

const starts = (plan: Plan, scenario: Scenario = LEVELED) =>
  Object.fromEntries(schedule(plan, scenario).items.map((s) => [s.item.id, s.beyond ? "beyond" : s.start]));

const at = (s: Schedule, id: string) => s.items.find((x) => x.item.id === id)!;

const underwayIds = (plan: Plan) => new Set(plan.items.filter((i) => i.underway).map((i) => i.id));

/**
 * Bookings of planned work on a carrier whose total demand exceeds its capacity that month.
 * When leveling binds on every seat (levelOn "all", no unlevelled seats), there should be none:
 * every planned booking was placed where the carrier had room for it, after all underway load.
 */
const plannedOnFullSeat = (plan: Plan, s: Schedule) => {
  const underway = underwayIds(plan);
  const loads = new Map(s.loads.map((l) => [l.seat, l]));
  return s.bookings.filter((b) => {
    if (underway.has(b.item) || b.carrier === "external") return false;
    const load = loads.get(b.carrier)!;
    return load.demand[b.month] > load.capacity[b.month] + 1e-9;
  });
};

/** Whether leveling waits for room on a carrier for this item in a month, as fits() decides it. */
const binds = (plan: Plan, s: Schedule, item: WorkItem, carrier: string, m: number) => {
  if (carrier === "external") return false;
  const owner = ownerOf(item);
  const capacity = s.loads.find((l) => l.seat === carrier)!.capacity[m];
  if (plan.seats.find((x) => x.id === carrier)!.unlevelled && (capacity > 0 || carrier !== owner)) return false;
  return plan.levelOn !== "owner" || carrier === owner;
};

/**
 * Carrier-months where a planned item's own load, on top of all underway load there, exceeds
 * capacity on a carrier that leveling binds on for that item. There should be none, whatever
 * levelOn and unlevelled seats say: leveling placed every planned item after all underway load.
 */
const plannedOnUnderway = (plan: Plan, s: Schedule) => {
  const underway = underwayIds(plan);
  const fixedAt = new Map<string, number>();
  const own = new Map<string, number>();
  for (const b of s.bookings) {
    const key = `${b.item}|${b.carrier}|${b.month}`;
    if (underway.has(b.item)) fixedAt.set(`${b.carrier}|${b.month}`, (fixedAt.get(`${b.carrier}|${b.month}`) ?? 0) + b.fte);
    else own.set(key, (own.get(key) ?? 0) + b.fte);
  }
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  return [...own].filter(([key, fte]) => {
    const [id, carrier, month] = key.split("|");
    const m = Number(month);
    if (!binds(plan, s, byId.get(id)!, carrier, m)) return false;
    const capacity = s.loads.find((l) => l.seat === carrier)!.capacity[m];
    return (fixedAt.get(`${carrier}|${m}`) ?? 0) + fte > capacity + 1e-9;
  });
};

/**
 * Whether underway load held back some planned item: its start is bound by capacity on a
 * carrier that holds underway load within the run it was refused, the one from a month earlier.
 * Counted over generated plans so the properties below are not vacuous.
 */
const underwayBound = (plan: Plan, s: Schedule) => {
  const underway = underwayIds(plan);
  const held = new Set(s.bookings.filter((b) => underway.has(b.item)).map((b) => `${b.carrier}|${b.month}`));
  return s.items.some((x) => {
    if (x.item.underway || x.beyond || x.binding.kind !== "capacity") return false;
    const refused = x.start - 1;
    const end = x.item.standing ? s.horizon : Math.min(s.horizon, refused + x.duration);
    for (let m = refused; m < end; m++) if (held.has(`${x.binding.carrier}|${m}`)) return true;
    return false;
  });
};

/** A small deterministic generator, so the property checks are reproducible. */
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** "all": leveling binds on every carrier. "mixed": levelOn owner, unlevelled seats and explicit owners too. */
const randomPlan = (seed: number, mode: "all" | "mixed" = "all"): Plan => {
  const rand = mulberry32(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)];
  const H = 12;
  const seatCount = int(1, 3);
  const seats = Array.from({ length: seatCount }, (_, k) =>
    role(`s${k}`, {
      hireMonths: Array.from({ length: int(1, 2) }, () => pick([0, 0, 0, 2, 5])),
      capacityFte: pick([0.5, 1, 1.5]),
      // Fallbacks point only to later seats, so no chain loops.
      fallback: k + 1 < seatCount && rand() < 0.5 ? `s${int(k + 1, seatCount - 1)}` : pick([null, null, "external"] as const),
      ...(mode === "mixed" && rand() < 0.3 ? { unlevelled: true } : {}),
    }),
  );
  const items: WorkItem[] = [];
  const count = int(2, 7);
  for (let k = 0; k < count; k++) {
    const demandSeats = [...new Set(Array.from({ length: int(1, 2) }, () => `s${int(0, seatCount - 1)}`))];
    const underway = rand() < 0.35;
    items.push(
      work(`i${k}`, {
        circle: pick(["core", "later"]),
        priority: rand() < 0.3 ? pick([-1, 1]) : undefined,
        // Underway work may start late enough that a finite run does not fit the horizon.
        earliest: underway ? int(0, 10) : int(0, 6),
        duration: int(1, 5),
        standing: rand() < 0.1,
        underway,
        predecessors: k > 0 && rand() < 0.4 ? [{ id: `i${int(0, k - 1)}`, lag: pick([0, 0, 1]) }] : [],
        demands: demandSeats.map((seat) => ({
          seat,
          fte: pick([0.2, 0.5, 0.8, 1]),
          ...(rand() < 0.2 ? { profile: [pick([0.3, 1]), pick([0.2, 0.6])] } : {}),
          basis: "A" as const,
        })),
        ...(mode === "mixed" && demandSeats.length > 1 && rand() < 0.5 ? { owner: pick(demandSeats) } : {}),
      }),
    );
  }
  const levelOn = mode === "mixed" && rand() < 0.5 ? { levelOn: "owner" as const } : {};
  return fixture({ calendar: { startYear: 2027, startMonth: 1, horizonMonths: H, fundingYearStartMonth: 0 }, seats, items, ...levelOn });
};

describe("underway work books before planned work", () => {
  it("planned work in an earlier circle waits for underway work on its seat", () => {
    const plan = fixture({ items: [work("m"), work("u", { underway: true, circle: "later" })] });
    const s = schedule(plan, LEVELED);
    expect(at(s, "u")).toMatchObject({ start: 0, end: 3, binding: { kind: "underway" } });
    expect(at(s, "m")).toMatchObject({ start: 3, end: 6, binding: { kind: "capacity", seat: "x", carrier: "x" } });
    expect(s.loads[0].demand).toEqual([1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
    expect(s.loads[0].fixed).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(overloads(s)).toEqual([]);
    expect(lintAll(plan, s, ledger(plan, s)).filter((f) => f.code === "W101")).toEqual([]);
  });

  it("the same holds inside a circle, whatever the ids and declared starts", () => {
    expect(starts(fixture({ items: [work("a"), work("u", { underway: true })] }))).toEqual({ a: 3, u: 0 });
    expect(starts(fixture({ items: [work("m"), work("a-u", { underway: true })] }))).toEqual({ m: 3, "a-u": 0 });
    // Underway from month 1: the planned item cannot start at 0 and run across months 1 and 2.
    expect(starts(fixture({ items: [work("m"), work("u", { underway: true, earliest: 1 })] }))).toEqual({ m: 4, u: 1 });
  });

  it("priority orders planned work only: it cannot put planned work on top of underway work", () => {
    const plan = fixture({ items: [work("m", { priority: -5 }), work("u", { underway: true, circle: "later", priority: 5 })] });
    expect(starts(plan)).toEqual({ m: 3, u: 0 });
    expect(overloads(schedule(plan, LEVELED))).toEqual([]);
  });

  it("standing underway work holds its load to the horizon", () => {
    // u takes half of x for good: m, which needs all of x, never fits; n fits beside u at once.
    const plan = fixture({
      items: [
        work("m"),
        work("u", { underway: true, standing: true, circle: "later", demands: [{ seat: "x", fte: 0.5, basis: "A" }] }),
        work("n", { demands: [{ seat: "x", fte: 0.5, basis: "A" }] }),
      ],
    });
    const s = schedule(plan, LEVELED);
    expect(starts(plan)).toEqual({ m: "beyond", u: 0, n: 0 });
    expect(at(s, "u")).toMatchObject({ start: 0, end: 12, binding: { kind: "underway" } });
    expect(overloads(s)).toEqual([]);
  });

  it("an underway item keeps its start while its planned predecessor books after it, and its successors still wait for it", () => {
    const plan = fixture({
      seats: [role("x"), role("y")],
      items: [
        work("m"),
        work("p", { circle: "later" }),
        work("u", { underway: true, circle: "later", predecessors: [{ id: "p" }] }),
        work("q", { duration: 1, predecessors: [{ id: "u", lag: 1 }], demands: [{ seat: "y", fte: 1, basis: "A" }] }),
      ],
    });
    const s = schedule(plan, LEVELED);
    expect(at(s, "u")).toMatchObject({ start: 0, binding: { kind: "underway" } });
    expect(at(s, "m")).toMatchObject({ start: 3, binding: { kind: "capacity", seat: "x", carrier: "x" } });
    expect(at(s, "p")).toMatchObject({ start: 6, binding: { kind: "capacity", seat: "x", carrier: "x" } });
    // u ends at 3; lag 1 makes q ready at 4, and y has room then.
    expect(at(s, "q")).toMatchObject({ start: 4, binding: { kind: "predecessor", id: "u" } });
    expect(overloads(s)).toEqual([]);
    // As planned, the order moves nothing: the underway item still ignores p, and q follows u.
    expect(starts(plan, AS_PLANNED)).toEqual({ m: 0, p: 0, u: 0, q: 4 });
    // Nor does a dropped predecessor move u.
    expect(starts(plan, { ...LEVELED, id: "without-p", dropItems: ["p"] })).toEqual({ m: 3, p: "beyond", u: 0, q: 4 });
  });

  it("an underway item pulls none of its planned predecessors ahead of work that outranks them", () => {
    // u waits for nothing, so its predecessor p books at p's own rank, after the core item r.
    const seats = [role("x"), role("y")];
    const u = work("u", { underway: true, priority: -1, predecessors: [{ id: "p" }], demands: [{ seat: "y", fte: 1, basis: "A" }] });
    const p = work("p", { circle: "later" });
    const r = work("r");
    expect(starts(fixture({ seats, items: [u, p, r] }))).toEqual({ u: 0, r: 0, p: 3 });
    // A planned successor that outranks p still waits for it, so it still pulls p ahead.
    const s = work("s", { priority: -2, duration: 1, predecessors: [{ id: "p" }], demands: [{ seat: "y", fte: 1, basis: "A" }] });
    expect(starts(fixture({ seats, items: [u, p, r, s] }))).toEqual({ u: 0, p: 0, r: 3, s: 3 });
  });

  it("a planned successor of underway work is not held back by the underway item's predecessors", () => {
    const plan = fixture({
      items: [
        work("m"),
        work("p", { circle: "later" }),
        work("u", { underway: true, circle: "later", predecessors: [{ id: "p" }] }),
        work("q", { duration: 1, predecessors: [{ id: "u", lag: 1 }], demands: [{ seat: "x", fte: 0.1, basis: "A" }] }),
      ],
    });
    const s = schedule(plan, LEVELED);
    expect(at(s, "u")).toMatchObject({ start: 0, binding: { kind: "underway" } });
    expect(at(s, "m")).toMatchObject({ start: 3, binding: { kind: "capacity", seat: "x", carrier: "x" } });
    // q is ready at month 4 (u ends at 3, lag 1); m fills months 4 and 5, so q books at 6,
    // and p, a later-circle item that q never waits for, books after it.
    expect(at(s, "q")).toMatchObject({ start: 6, binding: { kind: "capacity", seat: "x", carrier: "x" } });
    expect(at(s, "p")).toMatchObject({ start: 7, binding: { kind: "capacity", seat: "x", carrier: "x" } });
    expect(overloads(s)).toEqual([]);
  });

  it("leveling sees underway load that a fallback carries", () => {
    const plan = fixture({
      seats: [role("x"), role("y", { hireMonths: [6], fallback: "x" })],
      items: [work("m"), work("u", { underway: true, circle: "later", demands: [{ seat: "y", fte: 1, basis: "A" }] })],
    });
    const s = schedule(plan, LEVELED);
    expect(at(s, "u").carriers).toEqual([{ seat: "y", carrier: "x", fte: 1 }]);
    expect(at(s, "m").start).toBe(3);
    expect(overloads(s)).toEqual([]);
  });

  it("with levelOn owner, underway load on the owner's seat binds and underway load on a contributor's does not", () => {
    const owned = fixture({ levelOn: "owner", items: [work("m"), work("u", { underway: true, circle: "later" })] });
    expect(starts(owned)).toEqual({ m: 3, u: 0 });
    const contributed = fixture({
      levelOn: "owner",
      seats: [role("x"), role("y")],
      items: [
        work("m", { demands: [{ seat: "x", fte: 1, basis: "A" }, { seat: "y", fte: 0.5, basis: "A" }] }),
        work("u", { underway: true, circle: "later", demands: [{ seat: "y", fte: 1, basis: "A" }] }),
      ],
    });
    const s = schedule(contributed, LEVELED);
    expect(at(s, "m").start).toBe(0);
    expect(overloads(s)).toEqual([{ seat: "y", months: [0, 1, 2], peak: 0.5 }]);
  });

  it("an unlevelled seat still absorbs planned work on top of underway work", () => {
    const plan = fixture({
      seats: [role("x", { unlevelled: true })],
      items: [work("m"), work("u", { underway: true, circle: "later" })],
    });
    const s = schedule(plan, LEVELED);
    expect(at(s, "m").start).toBe(0);
    expect(overloads(s)).toEqual([{ seat: "x", months: [0, 1, 2], peak: 1 }]);
  });

  it("underway work that overloads a seat by itself leaves only its own excess", () => {
    const plan = fixture({
      items: [work("m"), work("u", { underway: true, circle: "later", demands: [{ seat: "x", fte: 2, basis: "A" }] })],
    });
    const s = schedule(plan, LEVELED);
    expect(at(s, "m").start).toBe(3);
    expect(overloads(s)).toEqual([{ seat: "x", months: [0, 1, 2], peak: 1 }]);
    const w101 = lintAll(plan, s, ledger(plan, s)).filter((f) => f.code === "W101");
    expect(w101).toHaveLength(1);
    expect(w101[0].message).toMatch(/over capacity in 3 months \(peak \+1\.00 FTE\)/);
  });

  it("underway work that books nothing holds nothing", () => {
    // Beyond the horizon: u's run (10-12) does not fit, so it books nothing, and m, which would
    // share months 10 and 11 with it, keeps its declared start.
    const beyond = fixture({ items: [work("m", { earliest: 9 }), work("u", { underway: true, circle: "later", earliest: 10 })] });
    expect(starts(beyond)).toEqual({ m: 9, u: "beyond" });
    // Dropped by the scenario: it holds no capacity, and a planned successor never gets it.
    const dropped = fixture({
      items: [work("m"), work("u", { underway: true, circle: "later" }), work("q", { predecessors: [{ id: "u" }], demands: [{ seat: "x", fte: 0.1, basis: "A" }] })],
    });
    expect(starts(dropped, { ...LEVELED, id: "without-u", dropItems: ["u"] })).toEqual({ m: 0, u: "beyond", q: "beyond" });
  });

  it("booking underway work first still refuses a cycle or an unknown predecessor through it", () => {
    const cycle = fixture({
      items: [
        work("p", { predecessors: [{ id: "u" }] }),
        work("u", { underway: true, predecessors: [{ id: "p" }] }),
      ],
    });
    expect(() => schedule(cycle, AS_PLANNED)).toThrow(/dependency cycle/);
    const unknown = fixture({ items: [work("u", { underway: true, predecessors: [{ id: "nope" }] })] });
    expect(() => schedule(unknown, AS_PLANNED)).toThrow(/depends on unknown item "nope"/);
  });

  it("as planned, the booking order moves no start", () => {
    const plan = fixture({ items: [work("m"), work("u", { underway: true, circle: "later" })] });
    const s = schedule(plan, AS_PLANNED);
    expect(Object.fromEntries(s.items.map((x) => [x.item.id, x.start]))).toEqual({ m: 0, u: 0 });
    expect(overloads(s)).toEqual([{ seat: "x", months: [0, 1, 2], peak: 1 }]);
  });

  it("the example plan's leveled scenarios put no planned work on a full seat", () => {
    // A guard: the example's one underway item never competed for a seat, so this held before too.
    const plan = loadPlanFile(new URL("../examples/studio.yaml", import.meta.url).pathname);
    for (const scenario of plan.scenarios!.filter((x) => x.level)) {
      const s = schedule(plan, scenario);
      expect(plannedOnFullSeat(plan, s)).toEqual([]);
    }
  });
});

describe("underway-first leveling, over generated plans", () => {
  const seeds = Array.from({ length: 400 }, (_, k) => k + 1);

  it("never books planned work on a carrier over capacity, keeps every underway start, and honors every predecessor", () => {
    let bound = 0;
    let underwayBeyond = 0;
    for (const seed of seeds) {
      const plan = randomPlan(seed);
      const s = schedule(plan, LEVELED);
      expect(plannedOnFullSeat(plan, s), `seed ${seed}`).toEqual([]);
      const byId = new Map(s.items.map((x) => [x.item.id, x]));
      for (const x of s.items) {
        if (x.item.underway) {
          // A fact: the declared start, or beyond when a finite run does not fit.
          if (x.beyond) {
            underwayBeyond++;
            expect(!x.item.standing && x.item.earliest + x.item.duration > s.horizon, `seed ${seed} ${x.item.id}`).toBe(true);
          } else {
            expect(x.start, `seed ${seed} ${x.item.id}`).toBe(x.item.earliest);
          }
          continue;
        }
        if (x.beyond) continue;
        expect(x.start, `seed ${seed} ${x.item.id}`).toBeGreaterThanOrEqual(x.item.earliest);
        for (const p of x.item.predecessors) {
          const pd = byId.get(p.id)!;
          expect(pd.beyond, `seed ${seed} ${x.item.id} after ${p.id}`).toBe(false);
          const ready = (pd.item.standing ? pd.start + 1 : pd.end) + (p.lag ?? 0);
          expect(x.start, `seed ${seed} ${x.item.id} after ${p.id}`).toBeGreaterThanOrEqual(ready);
        }
      }
      if (underwayBound(plan, s)) bound++;
    }
    expect(bound).toBeGreaterThan(60);
    expect(underwayBeyond).toBeGreaterThan(40);
  });

  it("places planned work beside underway load on every carrier leveling binds on, under levelOn owner and unlevelled seats too", () => {
    let bound = 0;
    for (const seed of seeds) {
      const plan = randomPlan(seed, "mixed");
      const s = schedule(plan, LEVELED);
      expect(plannedOnUnderway(plan, s), `seed ${seed}`).toEqual([]);
      if (underwayBound(plan, s)) bound++;
    }
    expect(bound).toBeGreaterThan(40);
  });

  it("is deterministic, and as planned every start is the declared month or its predecessors' readiness", () => {
    for (const seed of seeds) {
      const plan = randomPlan(seed);
      expect(schedule(plan, LEVELED), `seed ${seed}`).toEqual(schedule(randomPlan(seed), LEVELED));
      const s = schedule(plan, AS_PLANNED);
      const byId = new Map(s.items.map((x) => [x.item.id, x]));
      for (const x of s.items) {
        if (x.beyond) continue;
        const ready = x.item.underway
          ? x.item.earliest
          : Math.max(x.item.earliest, ...x.item.predecessors.map((p) => {
              const pd = byId.get(p.id)!;
              return (pd.item.standing ? pd.start + 1 : pd.end) + (p.lag ?? 0);
            }));
        expect(x.start, `seed ${seed} ${x.item.id}`).toBe(ready);
      }
    }
  });
});
