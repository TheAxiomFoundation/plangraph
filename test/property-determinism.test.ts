import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LEVELED, ledger, report, schedule, type Binding, type Plan, type Scenario, type Schedule, type SeatDef, type WorkItem } from "../src/index";
import {
  BROAD,
  ECON,
  arbRawPlan,
  arbRawScenario,
  buildPlan,
  buildScenario,
  compactPlan,
  compactScenario,
  mulberry32,
  scheduleLine,
  shuffle,
  type GenOpts,
  type RawPlan,
  type RawScenario,
} from "./property/arbitraries";
import { Admission, TIMEOUT, holds } from "./property/run";

// P4, determinism: the scheduler is "a pure, deterministic function from plan and scenario to
// schedule" (README). So the same input gives the same output, however often and from
// whatever copy; nothing the engine does writes to its input; and the order in which a plan
// happens to list things does not matter, except where the documentation says it does.
//
// Two orders do matter, and are documented. Ids break ties for scarce capacity (README
// "Scheduling"), so only a relabelling that keeps id order is a no-op. And an item's owner
// defaults to its first demand (model.ts WorkItem.owner), and the owner decides which seats
// leveling waits for, so reordering demands can change a schedule when no owner is set. The
// permutation property therefore makes every owner explicit first; a concrete test at the end
// records the default-owner case.

type Raw = [RawPlan, RawScenario, number];

const arb = (gen: GenOpts) => fc.tuple(arbRawPlan(gen), arbRawScenario({ overrides: true }), fc.integer());

const build = ([rp, rs]: Raw) => {
  const plan = buildPlan(rp);
  return { plan, sc: buildScenario(plan, rs) };
};

/** Freeze a value and everything it reaches, so any write to it throws (tests run as ES modules, in strict mode). */
function deepFreeze<T>(x: T): T {
  if (x !== null && typeof x === "object" && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const v of Object.values(x)) deepFreeze(v);
  }
  return x;
}

/** Everything a schedule says, keyed by id so array order does not matter, with every id passed through `rename` and FTE rounded to 1e-9. */
function canon(S: Schedule, rename: (id: string) => string = (x) => x): string {
  const r9 = (x: number) => Math.round(x * 1e9) / 1e9;
  const bind = (b: Binding) =>
    b.kind === "predecessor" ? { kind: b.kind, id: rename(b.id) } : b.kind === "capacity" ? { kind: b.kind, seat: rename(b.seat), carrier: rename(b.carrier) } : b;
  const items = S.items
    .map((x) => ({
      id: rename(x.item.id), start: x.start, end: x.end, duration: x.duration, beyond: x.beyond, dropped: !!x.dropped, binding: bind(x.binding),
      carriers: x.carriers.map((c) => `${rename(c.seat)}@${rename(c.carrier)}:${r9(c.fte)}`).sort(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const loads = S.loads
    .map((l) => ({ seat: rename(l.seat), demand: l.demand.map(r9), fixed: l.fixed.map(r9), capacity: l.capacity.map(r9) }))
    .sort((a, b) => (a.seat < b.seat ? -1 : 1));
  const bookings = S.bookings.map((b) => `${rename(b.item)}|${b.month}|${rename(b.seat)}|${rename(b.carrier)}|${r9(b.fte)}`).sort();
  const hires = Object.keys(S.hires).map((k) => `${rename(k)}:${S.hires[k].join(",")}:${S.hireIndex[k].join(",")}`).sort();
  return JSON.stringify({ items, loads, bookings, hires, external: S.external.map(r9) });
}

/** Every item's owner made explicit: the default, the first demand's seat (model.ts). */
function pinOwners(plan: Plan): Plan {
  const p = structuredClone(plan);
  for (const i of p.items) i.owner = i.owner ?? i.demands[0].seat;
  return p;
}

/** Shuffle items, seats, each item's predecessors and each item's demands. */
function permute(plan: Plan, seed: number): Plan {
  const rnd = mulberry32(seed);
  const p = structuredClone(plan);
  p.items = shuffle(p.items, rnd).map((i) => ({ ...i, predecessors: shuffle(i.predecessors, rnd), demands: shuffle(i.demands, rnd) }));
  p.seats = shuffle(p.seats, rnd);
  return p;
}

/** Rename every item and seat id with f, keeping every reference consistent. "external" is not an id. */
function relabel(plan: Plan, sc: Scenario, f: (id: string) => string): { plan: Plan; sc: Scenario } {
  const p = structuredClone(plan);
  const s = structuredClone(sc);
  const g = (id: string) => (id === "external" ? id : f(id));
  const rekey = <V,>(o: Record<string, V> | undefined) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [g(k), v])) : o);
  for (const seat of p.seats) {
    seat.id = g(seat.id);
    if (seat.fallback !== null) seat.fallback = g(seat.fallback);
  }
  for (const i of p.items) {
    i.id = g(i.id);
    i.predecessors = i.predecessors.map((q) => ({ ...q, id: g(q.id) }));
    i.demands = i.demands.map((d) => ({ ...d, seat: g(d.seat) }));
    if (i.owner !== undefined) i.owner = g(i.owner);
  }
  for (const st of p.streams) st.unlockedBy = g(st.unlockedBy);
  if (s.hireDelay) s.hireDelay = rekey(s.hireDelay);
  if (s.dropHires) s.dropHires = rekey(s.dropHires);
  if (s.dropSeats) s.dropSeats = s.dropSeats.map(g);
  if (s.dropItems) s.dropItems = s.dropItems.map(g);
  return { plan: p, sc: s };
}

const explainPair = (label: string, plan: Plan, sc: Scenario, other: Plan, a: Schedule, b: Schedule) =>
  [
    `plan:      ${JSON.stringify(compactPlan(plan))}`,
    `scenario:  ${JSON.stringify(compactScenario(sc))}`,
    `${label.padEnd(10)} ${JSON.stringify(compactPlan(other))}`,
    `original:  ${scheduleLine(a)}`,
    `${label.padEnd(10)} ${scheduleLine(b)}`,
  ].join("\n");

describe("P4 determinism and input independence, over generated plans", () => {
  it("P4.deterministic: schedule, ledger and report give identical output for the same input twice and for a structured clone of it", () => {
    const admission = new Admission();
    const outputs = (plan: Plan, sc: Scenario) => {
      const S = schedule(plan, sc);
      return JSON.stringify([S, ledger(plan, S), report({ ...plan, scenarios: [sc] })]);
    };
    holds(
      arb(ECON),
      (raw) => {
        const { plan, sc } = build(raw);
        admission.admit(plan, sc);
        const first = outputs(plan, sc);
        return first === outputs(plan, sc) && first === outputs(structuredClone(plan), structuredClone(sc));
      },
      (raw) => {
        const { plan, sc } = build(raw);
        return `plan: ${JSON.stringify(compactPlan(plan))}\nscenario: ${JSON.stringify(compactScenario(sc))}`;
      },
    );
    admission.expectFewSkipped();
  }, TIMEOUT);

  it("P4.no-input-mutation: schedule, ledger and report never write to the plan or the scenario", () => {
    const admission = new Admission();
    holds(
      arb(ECON),
      (raw) => {
        const { plan, sc } = build(raw);
        admission.admit(plan, sc);
        const withScenario: Plan = { ...plan, scenarios: [sc] };
        const before = JSON.stringify([withScenario, sc]);
        const S = schedule(withScenario, sc);
        ledger(withScenario, S);
        report(withScenario);
        // Any write to a frozen copy throws, even one undone before returning.
        const frozen = deepFreeze(structuredClone({ plan: withScenario, sc }));
        const F = schedule(frozen.plan, frozen.sc);
        ledger(frozen.plan, F);
        report(frozen.plan);
        return JSON.stringify([withScenario, sc]) === before;
      },
      (raw) => {
        const { plan, sc } = build(raw);
        return `plan: ${JSON.stringify(compactPlan(plan))}\nscenario: ${JSON.stringify(compactScenario(sc))}`;
      },
    );
    admission.expectFewSkipped();
  }, TIMEOUT);

  it("P4.permute: with every owner explicit, the order of items, seats, predecessor lists and demand lists changes nothing", () => {
    const admission = new Admission();
    holds(
      arb(BROAD),
      (raw) => {
        const { plan, sc } = build(raw);
        admission.admit(plan, sc);
        const pinned = pinOwners(plan);
        const base = canon(schedule(plan, sc));
        // Making the default owner explicit is itself a no-op.
        return base === canon(schedule(pinned, sc)) && base === canon(schedule(permute(pinned, raw[2]), structuredClone(sc)));
      },
      (raw) => {
        const { plan, sc } = build(raw);
        const pinned = pinOwners(plan);
        const q = permute(pinned, raw[2]);
        return `${explainPair("permuted:", pinned, sc, q, schedule(pinned, sc), schedule(q, sc))}\nunpinned:  ${scheduleLine(schedule(plan, sc))}`;
      },
    );
    admission.expectFewSkipped();
  }, TIMEOUT);

  it("P4.relabel: renaming every id while keeping id order changes nothing but the names", () => {
    const admission = new Admission();
    const prefix = (id: string) => `q${id}`;
    const unprefix = (id: string) => (id.startsWith("q") ? id.slice(1) : id);
    holds(
      arb(BROAD),
      (raw) => {
        const { plan, sc } = build(raw);
        admission.admit(plan, sc);
        const q = relabel(plan, sc, prefix);
        return canon(schedule(plan, sc)) === canon(schedule(q.plan, q.sc), unprefix);
      },
      (raw) => {
        const { plan, sc } = build(raw);
        const q = relabel(plan, sc, prefix);
        return explainPair("relabeled:", plan, sc, q.plan, schedule(plan, sc), schedule(q.plan, q.sc));
      },
    );
    admission.expectFewSkipped();
  }, TIMEOUT);
});

describe("P4's documented exception: the default owner", () => {
  it("is the first demand, so with no explicit owner the order of demands decides which seat leveling waits for", () => {
    // levelOn "owner": leveling waits only for the owner's seat. y is busy for three months.
    const seat = (id: string): SeatDef => ({ id, title: id, loadedAnnual: 0, costBasis: "A", hireMonths: [0], capacityFte: 1, fallback: null });
    const work = (id: string, over: Partial<WorkItem>): WorkItem => ({
      id, lane: "l", label: id, circle: "c", earliest: 0, duration: 3, standing: false, underway: false, predecessors: [],
      demands: [{ seat: "y", fte: 1, basis: "A" }], ...over,
    });
    const x = { seat: "x", fte: 1, basis: "A" as const };
    const y = { seat: "y", fte: 1, basis: "A" as const };
    const plan = (a: WorkItem): Plan => ({
      name: "default owner",
      levelOn: "owner",
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
      circles: ["c"],
      seats: [seat("x"), seat("y")],
      items: [work("busy", { priority: -1 }), a],
      streams: [], funding: [], nonLabor: [],
      escalation: { rate: 0, basis: "A" },
    });
    const a = (s: Schedule) => s.items.find((i) => i.item.id === "a")!;

    // x first: x owns a, so y's overload is reported, not waited for.
    expect(a(schedule(plan(work("a", { demands: [x, y] })), LEVELED))).toMatchObject({ start: 0, binding: { kind: "declared" } });
    // y first: y owns a, so a waits for y.
    expect(a(schedule(plan(work("a", { demands: [y, x] })), LEVELED))).toMatchObject({ start: 3, binding: { kind: "capacity", seat: "y", carrier: "y" } });
    // An explicit owner makes the order irrelevant.
    expect(a(schedule(plan(work("a", { owner: "x", demands: [y, x] })), LEVELED))).toMatchObject({ start: 0, binding: { kind: "declared" } });
  });
});
