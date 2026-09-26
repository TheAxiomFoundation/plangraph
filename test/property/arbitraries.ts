// Generators for the property suite: small plans and scenarios that parse and lint clean, and
// compact printers so a shrunk counterexample reads in a line or two.
//
// Plans are drawn as raw numbers first and built into a Plan second. Every index in the raw
// form is reduced modulo the size it indexes, so fast-check can shrink any part of it and the
// result is still a plan: a smaller horizon, fewer seats or items, and zeroed choices all
// build. Items depend only on earlier items and fallbacks point only to later seats, so the
// graph is acyclic and no fallback chain loops.

import fc from "fast-check";
import {
  lintPlan,
  parsePlan,
  type Basis,
  type Binding,
  type Demand,
  type Plan,
  type Predecessor,
  type Scenario,
  type Schedule,
  type Scheduled,
  type SeatDef,
  type WorkItem,
} from "../../src/index";

export interface GenOpts {
  hMin: number;
  hMax: number;
  minItems: number;
  maxItems: number;
  maxSeats: number;
  circles: number;
  fallbacks: boolean;
  unlevelled: boolean;
  underway: boolean;
  standing: boolean;
  profiles: boolean;
  priorities: boolean;
  lags: boolean;
  multiHire: boolean;
  /** Whether the plan may set levelOn ("all" or "owner"); off leaves the default, "all". */
  levelOn: boolean;
  econ: boolean;
  /** FTE values to draw from; the first is where shrinking goes. */
  ftes: number[];
}

/** Every feature the scheduler has. */
export const BROAD: GenOpts = {
  hMin: 4, hMax: 12, minItems: 3, maxItems: 8, maxSeats: 3, circles: 2,
  fallbacks: true, unlevelled: true, underway: true, standing: true, profiles: true,
  priorities: true, lags: true, multiHire: true, levelOn: true, econ: false,
  ftes: [1, 0.5, 0.25, 0.75, 1.5, 0.3, 0.1],
};

/** Plain resource-constrained scheduling: no fallbacks, no leadership seats, no underway or standing work, one circle. */
export const PLAIN: GenOpts = {
  ...BROAD, fallbacks: false, unlevelled: false, underway: false, standing: false, profiles: false,
  priorities: false, levelOn: false, circles: 1, multiHire: false, minItems: 1, hMax: 16,
};

/** PLAIN plus fallbacks and roles with more than one hire. */
export const FALLBACKS: GenOpts = { ...PLAIN, fallbacks: true, multiHire: true };

/** Where leveling waits for every internal carrier: levelOn "all" and no unlevelled seats. */
export const EVERY_CARRIER_BINDS: GenOpts = { ...BROAD, unlevelled: false, levelOn: false };

/** Everything, plus money: per-year and per-hire salaries, escalation, streams, funding, non-labor. */
export const ECON: GenOpts = { ...BROAD, econ: true, hMin: 4, hMax: 40 };

/** A feature switched off draws its "off" value, so the raw shape is the same either way. */
const when = <T>(on: boolean, arb: fc.Arbitrary<T>, off: T): fc.Arbitrary<T> => (on ? arb : fc.constant(off));

type Fallback = "null" | "next" | "next2" | "ext";

const arbEcon = fc.record({
  fundStart: fc.nat(30),
  escalation: fc.constantFrom(0, 0.05, 0.03),
  openingCash: fc.integer({ min: -100_000, max: 1_000_000 }),
  streams: fc.array(
    fc.record({
      by: fc.nat(7),
      price: fc.integer({ min: 0, max: 1000 }),
      units: fc.array(fc.integer({ min: 0, max: 500 }), { minLength: 1, maxLength: 3 }),
      ramp: fc.nat(6),
      basis: fc.constantFrom<Basis>("A", "D"),
    }),
    { maxLength: 2 },
  ),
  funding: fc.array(fc.record({ months: fc.array(fc.integer({ min: 0, max: 200_000 }), { maxLength: 40 }), counted: fc.boolean() }), { maxLength: 2 }),
  nonLabor: fc.array(fc.array(fc.integer({ min: 0, max: 100_000 }), { maxLength: 3 }), { maxLength: 2 }),
});

type RawEcon = typeof arbEcon extends fc.Arbitrary<infer T> ? T : never;

/** A raw-value encoding of a plan that shrinks well. */
export const arbRawPlan = (o: GenOpts) =>
  fc.record({
    H: fc.integer({ min: o.hMin, max: o.hMax }),
    levelOn: when<"all" | "owner" | undefined>(o.levelOn, fc.constantFrom<"all" | "owner" | undefined>(undefined, "all", "owner"), undefined),
    circles: fc.integer({ min: 1, max: o.circles }),
    seats: fc.array(
      fc.record({
        // A hire month can land at H or H+1, so some roles are never hired inside the horizon.
        hires: fc.array(fc.nat(14), { minLength: 1, maxLength: o.multiHire ? 2 : 1 }),
        cap: fc.constantFrom(1, 0.5, 1.5, 2),
        fb: when<Fallback>(o.fallbacks, fc.constantFrom<Fallback>("null", "next", "ext", "next2"), "null"),
        unlevelled: when(o.unlevelled, fc.integer({ min: 0, max: 4 }).map((x) => x === 4), false),
        annual: fc.integer({ min: 0, max: 240_000 }),
        byYear: when<number[] | null>(o.econ, fc.option(fc.array(fc.integer({ min: 0, max: 300_000 }), { minLength: 1, maxLength: 3 }), { freq: 3 }), null),
        byHire: when<(number[] | null)[] | null>(
          o.econ,
          fc.option(fc.array(fc.option(fc.array(fc.integer({ min: 0, max: 300_000 }), { minLength: 1, maxLength: 3 })), { minLength: 2, maxLength: 2 }), { freq: 3 }),
          null,
        ),
      }),
      { minLength: 1, maxLength: o.maxSeats },
    ),
    items: fc.array(
      fc.record({
        circle: fc.nat(Math.max(0, o.circles - 1)),
        earliest: fc.nat(15),
        duration: fc.integer({ min: 1, max: 5 }),
        standing: when(o.standing, fc.integer({ min: 0, max: 5 }).map((x) => x === 5), false),
        underway: when(o.underway, fc.integer({ min: 0, max: 5 }).map((x) => x === 5), false),
        preds: fc.array(fc.record({ k: fc.nat(7), lag: when(o.lags, fc.constantFrom(0, 1, 2), 0) }), { maxLength: 3 }),
        demands: fc.array(
          fc.record({
            s: fc.nat(2),
            fte: fc.constantFrom(...o.ftes),
            profile: when<number[] | null>(o.profiles, fc.option(fc.array(fc.constantFrom(1, 0.5, 0, 0.25), { minLength: 1, maxLength: 3 }), { freq: 4 }), null),
          }),
          { minLength: 1, maxLength: 2 },
        ),
        owner: fc.option(fc.nat(1), { freq: 3 }),
        priority: when<number | null>(o.priorities, fc.option(fc.integer({ min: -1, max: 1 }), { freq: 3 }), null),
        burn: when<number | null>(o.econ, fc.option(fc.integer({ min: 0, max: 5_000 })), null),
      }),
      { minLength: o.minItems, maxLength: o.maxItems },
    ),
    econ: when<RawEcon | null>(o.econ, arbEcon, null),
  });

export type RawPlan = ReturnType<typeof arbRawPlan> extends fc.Arbitrary<infer T> ? T : never;

/** Item ids are letters in array order, so predecessors (earlier items only) keep their meaning as items shrink away. */
export const letter = (k: number): string => String.fromCharCode(97 + k);

export function buildPlan(r: RawPlan): Plan {
  const H = r.H;
  const nSeats = r.seats.length;
  const seatId = (k: number) => `s${k % nSeats}`;
  const circles = Array.from({ length: r.circles }, (_, k) => `c${k}`);
  const seats: SeatDef[] = r.seats.map((s, i) => {
    const fallback: SeatDef["fallback"] =
      s.fb === "ext" ? "external" : s.fb === "next" && i + 1 < nSeats ? `s${i + 1}` : s.fb === "next2" && i + 2 < nSeats ? `s${i + 2}` : null;
    const hireMonths = s.hires.map((h) => h % (H + 2));
    const def: SeatDef = { id: `s${i}`, title: `s${i}`, loadedAnnual: s.annual, costBasis: "A", hireMonths, capacityFte: s.cap, fallback };
    if (s.unlevelled) def.unlevelled = true;
    if (s.byYear) def.loadedAnnualByYear = s.byYear;
    const byHire = s.byHire;
    if (byHire) def.loadedAnnualByHire = hireMonths.map((_, k) => byHire[k] ?? null);
    return def;
  });
  const items: WorkItem[] = r.items.map((it, idx) => {
    const predecessors: Predecessor[] = [];
    for (const p of it.preds) {
      if (p.k >= idx || predecessors.some((q) => q.id === letter(p.k))) continue;
      predecessors.push(p.lag ? { id: letter(p.k), lag: p.lag } : { id: letter(p.k) });
    }
    const demands: Demand[] = [];
    for (const d of it.demands) {
      const seat = seatId(d.s);
      if (demands.some((x) => x.seat === seat)) continue;
      const demand: Demand = { seat, fte: d.fte, basis: "A" };
      if (d.profile) demand.profile = d.profile;
      demands.push(demand);
    }
    const w: WorkItem = {
      id: letter(idx),
      lane: "l",
      label: letter(idx),
      circle: circles[it.circle % circles.length],
      earliest: it.earliest % H,
      duration: it.duration,
      standing: it.standing,
      underway: it.underway,
      predecessors,
      demands,
    };
    if (it.owner !== null && it.owner < demands.length) w.owner = demands[it.owner].seat;
    if (it.priority !== null) w.priority = it.priority;
    if (it.burn !== null) w.burnPerMonth = { usd: it.burn, basis: "A", note: "" };
    return w;
  });
  const plan: Plan = {
    name: "generated",
    calendar: { startYear: 2027, startMonth: 1, horizonMonths: H, fundingYearStartMonth: r.econ ? r.econ.fundStart % H : 0 },
    circles,
    seats,
    items,
    streams: [],
    funding: [],
    nonLabor: [],
    escalation: { rate: r.econ ? r.econ.escalation : 0, basis: "A" },
  };
  if (r.levelOn) plan.levelOn = r.levelOn;
  if (r.econ) {
    plan.openingCash = r.econ.openingCash;
    plan.streams = r.econ.streams.map((st, k) => ({
      id: `st${k}`,
      label: `st${k}`,
      unlockedBy: letter(st.by % items.length),
      unit: "u",
      price: { usd: st.price, basis: "A", note: "" },
      volumeByYear: { units: st.units, basis: st.basis, note: "" },
      rampMonths: st.ramp,
    }));
    plan.funding = r.econ.funding.map((f, k) => ({ id: `f${k}`, label: `f${k}`, byMonth: f.months, basis: "A", note: "", counted: f.counted }));
    plan.nonLabor = r.econ.nonLabor.map((byYear, k) => ({ id: `n${k}`, label: `n${k}`, byYear, basis: "A", note: "" }));
  }
  return plan;
}

/** A raw scenario. `level` pins leveling on or off, or leaves it to the generator; `overrides` adds every other scenario knob. */
export const arbRawScenario = (opts: { level?: boolean; overrides?: boolean }) => {
  const on = opts.overrides === true;
  return fc.record({
    level: opts.level === undefined ? fc.boolean() : fc.constant(opts.level),
    durationScale: when<number | null>(on, fc.option(fc.constantFrom(0.5, 0.75, 1.5), { freq: 3 }), null),
    effortScale: when<number | null>(on, fc.option(fc.constantFrom(0.5, 2), { freq: 3 }), null),
    hireDelay: when<{ s: number; d: number }[] | null>(on, fc.option(fc.array(fc.record({ s: fc.nat(2), d: fc.integer({ min: -3, max: 3 }) }), { maxLength: 2 }), { freq: 3 }), null),
    dropSeats: when<number[] | null>(on, fc.option(fc.array(fc.nat(2), { maxLength: 1 }), { freq: 4 }), null),
    dropHires: when<{ s: number; k: number } | null>(on, fc.option(fc.record({ s: fc.nat(2), k: fc.nat(1) }), { freq: 4 }), null),
    dropItems: when<number[] | null>(on, fc.option(fc.array(fc.nat(7), { maxLength: 1 }), { freq: 4 }), null),
    volumeScale: when<number | null>(on, fc.option(fc.constantFrom(0.5, 1.5), { freq: 3 }), null),
    countFunding: when<{ k: number; on: boolean } | null>(on, fc.option(fc.record({ k: fc.nat(1), on: fc.boolean() }), { freq: 3 }), null),
  });
};

export type RawScenario = ReturnType<typeof arbRawScenario> extends fc.Arbitrary<infer T> ? T : never;

export function buildScenario(plan: Plan, r: RawScenario): Scenario {
  const sc: Scenario = { id: "sc", name: "sc", gist: "", level: r.level };
  const n = plan.seats.length;
  if (r.durationScale) sc.durationScale = r.durationScale;
  if (r.effortScale) sc.effortScale = r.effortScale;
  if (r.volumeScale) sc.volumeScale = r.volumeScale;
  if (r.dropSeats && r.dropSeats.length) sc.dropSeats = [...new Set(r.dropSeats.map((k) => `s${k % n}`))];
  if (r.hireDelay && r.hireDelay.length) {
    const hireDelay: Record<string, number> = {};
    for (const x of r.hireDelay) hireDelay[`s${x.s % n}`] = x.d;
    sc.hireDelay = hireDelay;
  }
  if (r.dropHires) {
    const s = plan.seats[r.dropHires.s % n];
    sc.dropHires = { [s.id]: [r.dropHires.k % s.hireMonths.length] };
  }
  if (r.dropItems && r.dropItems.length) sc.dropItems = [...new Set(r.dropItems.map((k) => plan.items[k % plan.items.length].id))];
  if (r.countFunding && plan.funding.length) sc.countFunding = { [plan.funding[r.countFunding.k % plan.funding.length].id]: r.countFunding.on };
  return withoutIgnoredOverrides(plan, sc);
}

/**
 * The scenario without the hire overrides the scheduler ignores, which the parser rejects: a
 * delay or dropped hires on a seat in dropSeats, a delay on a hire in dropHires (0 in a per-hire
 * list), and a whole-role delay on a role whose every hire is dropped. It schedules exactly as
 * `sc` does, so generators and changes that combine overrides freely pass through it.
 */
export function withoutIgnoredOverrides(plan: Plan, sc: Scenario): Scenario {
  const out: Scenario = { ...sc };
  const droppedSeats = new Set(sc.dropSeats ?? []);
  const hireCount = new Map(plan.seats.map((s) => [s.id, s.hireMonths.length]));
  if (sc.dropHires) {
    const dropHires = Object.fromEntries(Object.entries(sc.dropHires).filter(([id]) => !droppedSeats.has(id)));
    if (Object.keys(dropHires).length) out.dropHires = dropHires;
    else delete out.dropHires;
  }
  if (sc.hireDelay) {
    const hireDelay: Record<string, number | number[]> = {};
    for (const [id, d] of Object.entries(sc.hireDelay)) {
      if (droppedSeats.has(id)) continue;
      const dropped = out.dropHires?.[id] ?? [];
      if (Array.isArray(d)) hireDelay[id] = d.map((x, k) => (dropped.includes(k) ? 0 : x));
      else if (d === 0 || Array.from({ length: hireCount.get(id) ?? 0 }, (_, k) => k).some((k) => !dropped.includes(k))) hireDelay[id] = d;
    }
    if (Object.keys(hireDelay).length) out.hireDelay = hireDelay;
    else delete out.hireDelay;
  }
  return out;
}

/**
 * Whether a plan, with the scenario it is scheduled under, is one the library accepts: it
 * parses (scenario included) and lintPlan raises no error. Properties are claims about valid
 * plans only, so the rest are skipped, and each property checks that it skipped few.
 */
export function validPlan(plan: Plan, scenario: Scenario): { ok: true } | { ok: false; why: string } {
  const withScenario: Plan = { ...plan, scenarios: [scenario] };
  try {
    parsePlan(structuredClone(withScenario));
  } catch (e) {
    return { ok: false, why: String(e) };
  }
  const errors = lintPlan(withScenario).filter((f) => f.severity === "error");
  return errors.length ? { ok: false, why: errors.map((f) => `${f.code} ${f.message}`).join("; ") } : { ok: true };
}

/** A compact rendering of a plan for counterexamples: defaults, labels and money dropped. */
export function compactPlan(plan: Plan): unknown {
  const out: Record<string, unknown> = { H: plan.calendar.horizonMonths };
  if (plan.levelOn) out.levelOn = plan.levelOn;
  if (plan.circles.length > 1) out.circles = plan.circles;
  out.seats = plan.seats.map((s) => {
    const x: Record<string, unknown> = { id: s.id, hireMonths: s.hireMonths, capacityFte: s.capacityFte };
    if (s.fallback !== null) x.fallback = s.fallback;
    if (s.unlevelled) x.unlevelled = true;
    return x;
  });
  out.items = plan.items.map((i) => {
    const x: Record<string, unknown> = { id: i.id };
    if (plan.circles.length > 1) x.circle = i.circle;
    x.earliest = i.earliest;
    if (i.standing) x.standing = true;
    else x.duration = i.duration;
    if (i.underway) x.underway = true;
    if (i.priority !== undefined) x.priority = i.priority;
    if (i.predecessors.length) x.predecessors = i.predecessors.map((p) => (p.lag ? `${p.id}+${p.lag}` : p.id));
    x.demands = i.demands.map((d) => `${d.seat}:${d.fte}${d.profile ? `[${d.profile.join(",")}]` : ""}`);
    if (i.owner !== undefined) x.owner = i.owner;
    return x;
  });
  return out;
}

/** The money side of a plan, for economics counterexamples. */
export function compactEconomics(plan: Plan): unknown {
  return {
    calendar: plan.calendar,
    escalation: plan.escalation,
    openingCash: plan.openingCash,
    seats: plan.seats.map((s) => ({ id: s.id, loadedAnnual: s.loadedAnnual, loadedAnnualByYear: s.loadedAnnualByYear, loadedAnnualByHire: s.loadedAnnualByHire })),
    burn: plan.items.filter((i) => i.burnPerMonth).map((i) => `${i.id}:${i.burnPerMonth!.usd}`),
    streams: plan.streams.map((s) => ({ id: s.id, by: s.unlockedBy, price: s.price.usd, units: s.volumeByYear.units, ramp: s.rampMonths })),
    funding: plan.funding.map((f) => ({ id: f.id, byMonth: f.byMonth, counted: f.counted })),
    nonLabor: plan.nonLabor.map((n) => ({ id: n.id, byYear: n.byYear })),
  };
}

export function compactScenario(sc: Scenario): unknown {
  const { id: _id, name: _name, gist: _gist, ...rest } = sc;
  return rest;
}

export const bindStr = (b: Binding): string =>
  b.kind === "predecessor" ? `pred ${b.id}` : b.kind === "capacity" || b.kind === "hire" ? `${b.kind === "capacity" ? "cap" : "hire"} ${b.seat}${b.carrier !== b.seat ? `@${b.carrier}` : ""}` : b.kind;

export const fmtItem = (s: Scheduled): string =>
  s.dropped ? `${s.item.id}:dropped` : s.beyond ? `${s.item.id}:beyond(${bindStr(s.binding)})` : `${s.item.id}:${s.start}-${s.end}(${bindStr(s.binding)})`;

/** One line per schedule: `a:0-1(declared)  b:beyond(cap s0)  c:dropped`. */
export const scheduleLine = (S: Schedule): string => S.items.map(fmtItem).join("  ");

/** A plan, its scenario and its schedule, for a failure message. */
export const describeCase = (plan: Plan, sc: Scenario, S: Schedule): string =>
  [`plan:     ${JSON.stringify(compactPlan(plan))}`, `scenario: ${JSON.stringify(compactScenario(sc))}`, `schedule: ${scheduleLine(S)}`].join("\n");

/** Deterministic PRNG for shuffles, seeded from a generated integer so shrinking can reach it. */
export function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(xs: readonly T[], rnd: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
