// The scheduler: a serial schedule-generation scheme over the plan graph.
//
// Items are taken in priority order (circle, then declared start, then id), predecessors
// always first. Each starts at the latest of: its declared earliest month; every
// predecessor's end plus lag (a standing predecessor counts from its start plus one, since
// it never ends); and, when the scenario levels capacity, the first month from which every
// carrier it needs has room for the whole run. Demands are resolved to carriers month by
// month and aggregated per carrier before they are compared with capacity, so two demands
// that land on the same person count together.
//
// A finite item must fit entirely inside the horizon to be scheduled; one that cannot is
// beyond the horizon: it books nothing, unlocks nothing, and takes its dependents with it.
//
// Every start records the constraint that bound it. Deterministic: same inputs, same output.

import { has, ownerOf, table, type Plan, type Scenario, type SeatDef, type SeatId, type WorkItem } from "./model.js";

export type Binding =
  | { kind: "declared" }
  | { kind: "underway" }
  | { kind: "predecessor"; id: string }
  | { kind: "capacity"; seat: SeatId; carrier: SeatId }
  | { kind: "horizon" };

export interface Scheduled {
  item: WorkItem;
  start: number;
  /** Exclusive. Equal to the horizon for standing items and for items beyond it. */
  end: number;
  /** Months actually scheduled: the item's duration, or the horizon minus start for standing items. */
  duration: number;
  /** True when the item cannot complete inside the horizon. It books nothing. */
  beyond: boolean;
  binding: Binding;
  /** Who carries each demand at the start month: the seat, or its fallback. Empty when beyond. */
  carriers: { seat: SeatId; carrier: SeatId | "external"; fte: number }[];
}

export interface SeatLoad {
  seat: SeatId;
  /** Demand in FTE by month, including load handed to this seat as a fallback. */
  demand: number[];
  /** The part leveling cannot move: underway items and load carried for unfilled seats. */
  fixed: number[];
  /** Seats hired by month × capacity per seat. */
  capacity: number[];
}

export interface Schedule {
  scenario: Scenario;
  horizon: number;
  items: Scheduled[];
  loads: SeatLoad[];
  /** Effective hire months after the scenario's delays. */
  hires: Record<SeatId, number[]>;
  /** FTE-months routed to external carriers, by month: uncosted and uncapped, but counted. */
  external: number[];
}

export const effectiveHires = (plan: Plan, scenario: Scenario): Record<SeatId, number[]> => {
  const out = table<number[]>();
  for (const s of plan.seats) {
    const delay = has(scenario.hireDelay, s.id) ? scenario.hireDelay![s.id] : 0;
    out[s.id] = s.hireMonths.map((m) => Math.max(0, m + delay));
  }
  return out;
};

/** Seats of a role on payroll in a month. */
export const seatsHired = (hires: number[] | undefined, m: number): number => (hires ?? []).filter((h) => h <= m).length;

/**
 * Where a demand lands in a given month: the seat if it has anyone hired, else along its
 * fallback chain until a hired seat, "external", or a seat with no fallback (the load then
 * shows on that empty seat, which the harness reports).
 */
export function carrierFor(
  seatDefs: Map<SeatId, SeatDef>,
  hires: Record<SeatId, number[]>,
  seat: SeatId,
  m: number,
): SeatId | "external" {
  const seen = new Set<SeatId>();
  let cur = seat;
  for (;;) {
    if (seatsHired(hires[cur], m) > 0) return cur;
    const def = seatDefs.get(cur);
    if (!def || def.fallback === null || seen.has(cur)) return cur;
    if (def.fallback === "external") return "external";
    seen.add(cur);
    cur = def.fallback;
  }
}

function order(items: WorkItem[], circles: string[]): WorkItem[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const pri = (c: string) => {
    const k = circles.indexOf(c);
    return k < 0 ? circles.length : k;
  };
  const cmp = (a: WorkItem, b: WorkItem) =>
    pri(a.circle) - pri(b.circle) || a.earliest - b.earliest || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const out: WorkItem[] = [];
  const visit = (i: WorkItem) => {
    if (visited.has(i.id)) return;
    if (visiting.has(i.id)) throw new Error(`plangraph: dependency cycle through "${i.id}"`);
    visiting.add(i.id);
    for (const p of [...i.predecessors].sort((x, y) => (x.id < y.id ? -1 : 1))) {
      const pi = byId.get(p.id);
      if (!pi) throw new Error(`plangraph: "${i.id}" depends on unknown item "${p.id}"`);
      visit(pi);
    }
    visiting.delete(i.id);
    visited.add(i.id);
    out.push(i);
  };
  for (const i of [...items].sort(cmp)) visit(i);
  return out;
}

export function schedule(plan: Plan, scenario: Scenario): Schedule {
  const H = plan.calendar.horizonMonths;
  const seatDefs = new Map(plan.seats.map((s) => [s.id, s]));
  const hires = effectiveHires(plan, scenario);
  const loads = new Map<SeatId, SeatLoad>(
    plan.seats.map((s) => [
      s.id,
      {
        seat: s.id,
        demand: new Array(H).fill(0),
        fixed: new Array(H).fill(0),
        capacity: Array.from({ length: H }, (_, m) => seatsHired(hires[s.id], m) * s.capacityFte),
      },
    ]),
  );
  const external = new Array(H).fill(0) as number[];
  const done = new Map<string, Scheduled>();
  const eff = scenario.effortScale ?? 1;

  const durationOf = (i: WorkItem, start: number): number => {
    if (i.standing) return Math.max(1, H - start);
    if (i.underway) return i.duration;
    return Math.max(1, Math.round(i.duration * (scenario.durationScale ?? 1)));
  };

  /** Demands of one item in one month, aggregated by the carrier they land on. */
  const landed = (i: WorkItem, m: number): Map<SeatId | "external", { fte: number; seat: SeatId }> => {
    const out = new Map<SeatId | "external", { fte: number; seat: SeatId }>();
    for (const d of i.demands) {
      const c = carrierFor(seatDefs, hires, d.seat, m);
      const cur = out.get(c);
      if (cur) cur.fte += d.fte * eff;
      else out.set(c, { fte: d.fte * eff, seat: d.seat });
    }
    return out;
  };

  /** Whether the whole run fits from `start`; on failure, the carrier with the largest shortfall. */
  const fits = (i: WorkItem, start: number, duration: number): { ok: true } | { ok: false; seat: SeatId; carrier: SeatId } => {
    if (!i.standing && start + duration > H) return { ok: false, seat: ownerOf(i), carrier: ownerOf(i) };
    let worst: { short: number; seat: SeatId; carrier: SeatId } | null = null;
    for (let m = start; m < Math.min(start + duration, H); m++) {
      for (const [c, d] of landed(i, m)) {
        if (c === "external") continue;
        const load = loads.get(c);
        const short = load ? load.demand[m] + d.fte - load.capacity[m] : d.fte;
        if (short > 1e-9 && (!worst || short > worst.short)) worst = { short, seat: d.seat, carrier: c };
      }
      if (worst) return { ok: false, seat: worst.seat, carrier: worst.carrier };
    }
    return { ok: true };
  };

  const book = (i: WorkItem, start: number, duration: number) => {
    for (let m = start; m < Math.min(start + duration, H); m++) {
      for (const [c, d] of landed(i, m)) {
        if (c === "external") {
          external[m] += d.fte;
          continue;
        }
        const load = loads.get(c);
        if (!load) continue;
        load.demand[m] += d.fte;
        if (i.underway || c !== d.seat) load.fixed[m] += d.fte;
      }
    }
  };

  for (const i of order(plan.items, plan.circles)) {
    let start = Math.max(0, i.earliest);
    let binding: Binding = i.underway ? { kind: "underway" } : { kind: "declared" };
    let beyond = false;
    if (!i.underway) {
      for (const p of [...i.predecessors].sort((x, y) => (x.id < y.id ? -1 : 1))) {
        const pd = done.get(p.id)!;
        if (pd.beyond) {
          beyond = true;
          binding = { kind: "predecessor", id: p.id };
          break;
        }
        const ready = (pd.item.standing ? pd.start + 1 : pd.end) + (p.lag ?? 0);
        if (ready > start) {
          start = ready;
          binding = { kind: "predecessor", id: p.id };
        }
      }
    }
    let duration = durationOf(i, start);
    if (!beyond && !i.underway) {
      if (scenario.level) {
        let probe = start;
        let f = fits(i, probe, duration);
        while (!f.ok && probe < H) {
          probe += 1;
          duration = durationOf(i, probe);
          f = fits(i, probe, duration);
        }
        if (probe !== start) {
          if (probe >= H) {
            beyond = true;
            binding = { kind: "horizon" };
          } else {
            const last = fits(i, probe - 1, durationOf(i, probe - 1)) as { ok: false; seat: SeatId; carrier: SeatId };
            binding = { kind: "capacity", seat: last.seat, carrier: last.carrier };
            start = probe;
          }
        }
      } else if (!i.standing && start + duration > H) {
        beyond = true;
        binding = { kind: "horizon" };
      }
    } else if (i.underway && !i.standing && start + duration > H) {
      // Work already begun keeps its declared window; what falls past the horizon is simply not counted.
      duration = Math.max(1, H - start);
    }
    if (beyond) {
      done.set(i.id, { item: i, start: H, end: H, duration: 0, beyond: true, binding, carriers: [] });
      continue;
    }
    book(i, start, duration);
    const carriers = [...landed(i, start)].map(([c, d]) => ({ seat: d.seat, carrier: c, fte: d.fte }));
    done.set(i.id, { item: i, start, end: Math.min(start + duration, H), duration, beyond: false, binding, carriers });
  }

  return {
    scenario,
    horizon: H,
    items: plan.items.map((i) => done.get(i.id)!),
    loads: plan.seats.map((s) => loads.get(s.id)!),
    hires,
    external,
  };
}

export interface Slip {
  id: string;
  label: string;
  /** Months later than the baseline start; when the item fell beyond the horizon, the horizon minus the baseline start. */
  months: number;
  beyond: boolean;
  binding: Binding;
}

/** Items that moved against a baseline schedule, largest slip first. */
export function slips(base: Schedule, other: Schedule): Slip[] {
  const byId = new Map(base.items.map((s) => [s.item.id, s]));
  return other.items
    .map((s) => {
      const b = byId.get(s.item.id)!;
      return { id: s.item.id, label: s.item.label, months: s.start - b.start, beyond: s.beyond && !b.beyond, binding: s.binding };
    })
    .filter((s) => s.months !== 0)
    .sort((a, b) => b.months - a.months || (a.id < b.id ? -1 : 1));
}

/** Months in which a seat's demand exceeds its capacity, by seat, most months first. */
export function overloads(s: Schedule): { seat: SeatId; months: number[]; peak: number }[] {
  return s.loads
    .map((l) => {
      const months = l.demand.map((d, m) => (d > l.capacity[m] + 1e-9 ? m : -1)).filter((m) => m >= 0);
      const peak = Math.max(0, ...l.demand.map((d, m) => d - l.capacity[m]));
      return { seat: l.seat, months, peak };
    })
    .filter((o) => o.months.length > 0)
    .sort((a, b) => b.months.length - a.months.length);
}
