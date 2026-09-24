import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bookingOrder, lintSubstitutions, monthIndex, schedule, tightens, type Plan, type Scenario, type Schedule } from "../src/index";
import { BROAD, FALLBACKS, arbRawPlan, arbRawScenario, buildPlan, buildScenario, compactPlan, compactScenario, scheduleLine, type GenOpts, type RawPlan, type RawScenario } from "./property/arbitraries";
import { later, type Change } from "./property/relaxations";
import { Admission, TIMEOUT, expectCoverage, holds } from "./property/run";

// W117 and tightens(), over generated plans. Each scenario change below takes room away and
// gives none back: leveling on, more effort, longer runs, a later or dropped hire on a role that
// falls back to nobody, or on a pooled role whose first hire stays put. The properties:
//
// S1  tightens() recognizes every one of them.
// S2  as planned, and when the change only turns leveling on, no item starts earlier and W117
//     says nothing: starts depend only on declared months, predecessors and durations there,
//     and leveled starts are never earlier than as-planned ones (README "Scheduling").
// S3  leveled, W117 names exactly the items that start earlier, or fit inside the horizon only,
//     under the tighter scenario, and each reason it gives is true of the two schedules: a
//     predecessor it names ends (or, standing, starts) earlier; every item it names put less
//     load on the carrier the item waited for, over the months the item moved into.

type Tighten = (plan: Plan, sc: Scenario, a: number, b: number) => Change | null;

/** Per-hire delays in effect for a seat under a scenario, index-aligned with hireMonths. */
const delays = (plan: Plan, sc: Scenario, seat: string): number[] => {
  const d0 = sc.hireDelay?.[seat] ?? 0;
  return plan.seats.find((s) => s.id === seat)!.hireMonths.map((_, j) => (Array.isArray(d0) ? (d0[j] ?? 0) : d0));
};

/** Effective hire month by index, without dropped hires: the scheduler's drop, delay and clamp at 0. */
const effective = (plan: Plan, sc: Scenario, seat: string, per = delays(plan, sc, seat), dropped = sc.dropHires?.[seat] ?? []): Map<number, number> => {
  const out = new Map<number, number>();
  plan.seats.find((s) => s.id === seat)!.hireMonths.forEach((m, j) => {
    if (!dropped.includes(j)) out.set(j, Math.max(0, m + per[j]));
  });
  return out;
};

/** A hire change tightens only on a role with no fallback, or one whose first hire does not move. */
const firstHireHolds = (plan: Plan, seat: string, before: Map<number, number>, after: Map<number, number>): boolean =>
  plan.seats.find((s) => s.id === seat)!.fallback === null || Math.min(...before.values()) === Math.min(...after.values());

const TIGHTEN: Record<string, Tighten> = {
  "leveling on": (plan, sc) => (sc.level ? null : { plan, sc: { ...sc, level: true }, what: "level: true" }),
  "more effort": (plan, sc, a) => {
    const f = [1.1, 1.5, 2][a % 3];
    return { plan, sc: { ...sc, effortScale: (sc.effortScale ?? 1) * f }, what: `effortScale x${f}` };
  },
  "longer runs": (plan, sc, a) => {
    const f = [1.25, 1.5][a % 2];
    return { plan, sc: { ...sc, durationScale: (sc.durationScale ?? 1) * f }, what: `durationScale x${f}` };
  },
  "a later hire": (plan, sc, a, b) => {
    const seat = plan.seats[a % plan.seats.length];
    const k = b % seat.hireMonths.length;
    if ((sc.dropSeats ?? []).includes(seat.id) || (sc.dropHires?.[seat.id] ?? []).includes(k)) return null;
    const per = delays(plan, sc, seat.id);
    const before = effective(plan, sc, seat.id, per);
    per[k] += 1 + (a % 3);
    if (!firstHireHolds(plan, seat.id, before, effective(plan, sc, seat.id, per))) return null;
    return { plan, sc: { ...sc, hireDelay: { ...(sc.hireDelay ?? {}), [seat.id]: per } }, what: `hire ${k} of ${seat.id} later (hireDelay ${JSON.stringify(per)})` };
  },
  "a dropped hire": (plan, sc, a, b) => {
    const seat = plan.seats[a % plan.seats.length];
    const k = b % seat.hireMonths.length;
    const dropped = sc.dropHires?.[seat.id] ?? [];
    if ((sc.dropSeats ?? []).includes(seat.id) || dropped.includes(k)) return null;
    if (!firstHireHolds(plan, seat.id, effective(plan, sc, seat.id), effective(plan, sc, seat.id, undefined, [...dropped, k]))) return null;
    return { plan, sc: { ...sc, dropHires: { ...(sc.dropHires ?? {}), [seat.id]: [...dropped, k] } }, what: `drop hire ${k} of ${seat.id}` };
  },
};

/** Items that start earlier, or fit inside the horizon only, in `tight` than in `loose`. */
const earlier = (tight: Schedule, loose: Schedule): string[] => later(tight, loose).map((line) => line.split(" ")[0]);

interface Pair {
  plan: Plan;
  loose: Scenario;
  tight: Scenario;
  what: string;
}

/** Run `check` over generated plans, scenarios and tightenings; returns runs and how many had a W117. */
function overTightenings(level: boolean | undefined, gen: GenOpts, check: (p: Pair, loose: Schedule, tight: Schedule) => boolean): { runs: number; flagged: number } {
  let runs = 0;
  let flagged = 0;
  // A loose scenario that already levels cannot have leveling turned on.
  for (const [name, tighten] of Object.entries(TIGHTEN).filter(([n]) => !(level === true && n === "leveling on"))) {
    const admission = new Admission();
    const build = ([rp, rs, a, b]: [RawPlan, RawScenario, number, number]): Pair | null => {
      const plan = buildPlan(rp);
      const loose = buildScenario(plan, rs);
      const change = tighten(plan, loose, a, b);
      return change && { plan, loose, tight: { ...change.sc, id: "tight", name: "tight" }, what: change.what };
    };
    const result = holds(
      fc.tuple(arbRawPlan(gen), arbRawScenario({ level, overrides: true }), fc.nat(7), fc.nat(7)),
      (raw) => {
        const plan = buildPlan(raw[0]);
        admission.admit(plan, buildScenario(plan, raw[1]));
        const p = build(raw);
        fc.pre(p !== null);
        admission.admit(p!.plan, p!.tight);
        const a = schedule(p!.plan, p!.loose);
        const b = schedule(p!.plan, p!.tight);
        runs++;
        if (lintSubstitutions(p!.plan, b, a).length) flagged++;
        return check(p!, a, b);
      },
      (raw) => {
        const p = build(raw)!;
        const a = schedule(p.plan, p.loose);
        const b = schedule(p.plan, p.tight);
        return [
          `tighten:  ${name}: ${p.what}`,
          `plan:     ${JSON.stringify(compactPlan(p.plan))}`,
          `loose:    ${JSON.stringify(compactScenario(p.loose))}`,
          `tight:    ${JSON.stringify(compactScenario(p.tight))}`,
          `before:   ${scheduleLine(a)}`,
          `after:    ${scheduleLine(b)}`,
          `W117:     ${lintSubstitutions(p.plan, b, a).map((f) => `${f.subject}: ${f.message} ${f.hint}`).join("\n          ") || "none"}`,
        ].join("\n");
      },
      { maxSkipsPerRun: 1000 },
    );
    admission.expectFewSkipped();
    expect(result.numRuns).toBeGreaterThan(0);
  }
  return { runs, flagged };
}

/** Month index of a "YYYY-MM" label in the plan's calendar. */
const monthOf = (plan: Plan, label: string): number => monthIndex(plan.calendar, Number(label.slice(0, 4)), Number(label.slice(5, 7)));

/** Whether every reason a W117 hint gives is true of the two schedules. */
function reasonsHold(plan: Plan, loose: Schedule, tight: Schedule): boolean {
  const was = new Map(loose.items.map((x) => [x.item.id, x]));
  const now = new Map(tight.items.map((x) => [x.item.id, x]));
  for (const f of lintSubstitutions(plan, tight, loose)) {
    const a = was.get(f.subject)!;
    const b = now.get(f.subject)!;
    const pred = /it waited for "([^"]+)", which (ends earlier here|starts earlier here|does not fit inside the horizon there)\./.exec(f.hint);
    if (pred) {
      const pa = was.get(pred[1])!;
      const pb = now.get(pred[1])!;
      if (pred[2] === "does not fit inside the horizon there" && !(pa.beyond && !pb.beyond)) return false;
      if (pred[2] === "starts earlier here" && !(pa.item.standing && pb.start < pa.start)) return false;
      if (pred[2] === "ends earlier here" && !(!pa.item.standing && !pa.beyond && !pb.beyond && pb.end < pa.end)) return false;
    }
    const room = /it waited for (?:room on|a hire to carry) ([^;.]+)(?:; here (.+) put less there (?:in (\d{4}-\d{2})|from (\d{4}-\d{2}) to (\d{4}-\d{2})))?\./.exec(f.hint);
    if (room) {
      const carrier = room[1];
      if ((a.binding.kind !== "capacity" && a.binding.kind !== "hire") || a.binding.carrier !== carrier) return false;
      const from = room[3] ? monthOf(plan, room[3]) : room[4] ? monthOf(plan, room[4]) : b.start;
      const to = (room[3] ? monthOf(plan, room[3]) : room[5] ? monthOf(plan, room[5]) : b.start) + 1;
      if (from !== b.start || to !== (a.beyond ? b.end : Math.min(a.start, b.end))) return false;
      // Each item named was booked before the subject and, in some month of the window, put
      // less on the carrier here than in the looser schedule.
      const order = bookingOrder(plan);
      const on = (s: Schedule, id: string, m: number) => s.bookings.filter((x) => x.item === id && x.carrier === carrier && x.month === m).reduce((n, x) => n + x.fte, 0);
      for (const [, id] of (room[2] ?? "").matchAll(/"([^"]+)"/g)) {
        if (order.indexOf(id) >= order.indexOf(f.subject)) return false;
        let less = 0;
        for (let m = from; m < to; m++) less += Math.max(0, on(loose, id, m) - on(tight, id, m));
        if (!(less > 1e-9)) return false;
      }
    }
    if (!pred && !room && (a.binding.kind === "capacity" || a.binding.kind === "hire" || a.binding.kind === "predecessor")) return false;
  }
  return true;
}

describe("W117 and tightens(), over generated plans", () => {
  it("S1: tightens() recognizes every change that only takes room away", () => {
    for (const gen of [FALLBACKS, BROAD]) overTightenings(undefined, gen, (p) => tightens(p.plan, p.loose, p.tight));
  }, TIMEOUT);

  it("S2: as planned, or when only leveling is turned on, a tightening starts nothing earlier and W117 is silent", () => {
    for (const gen of [FALLBACKS, BROAD]) {
      overTightenings(false, gen, (p, a, b) => earlier(b, a).length === 0 && lintSubstitutions(p.plan, b, a).length === 0);
    }
  }, TIMEOUT);

  it("S3: leveled, W117 names exactly the items the tightening started earlier, and every reason it gives is true", () => {
    let runs = 0;
    let flagged = 0;
    for (const gen of [FALLBACKS, BROAD]) {
      const r = overTightenings(true, gen, (p, a, b) =>
        JSON.stringify(lintSubstitutions(p.plan, b, a).map((f) => f.subject).sort()) === JSON.stringify(earlier(b, a).sort()) && reasonsHold(p.plan, a, b),
      );
      runs += r.runs;
      flagged += r.flagged;
    }
    // Anomalies are rare but not vanishingly so; the property would be empty without them.
    expectCoverage("a leveled tightening that started some item earlier", flagged, runs, 0.005);
  }, TIMEOUT);
});
