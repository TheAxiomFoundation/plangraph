// The scheduler: a serial schedule-generation scheme over the plan graph.
//
// Items are taken in priority order (circle, then declared start, then id), predecessors
// always first. Each starts at the latest of: its declared earliest month; every
// predecessor's end plus lag (a standing predecessor counts from its start, since it never
// ends); and, when the scenario levels capacity, the first month from which every seat it
// demands has room for the whole run. A demanded seat that is not yet hired hands its load
// to its fallback, so an unfilled seat's work shows up on the person carrying it.
//
// An item that never fits is scheduled beyond the horizon rather than crammed into the last
// month; it books nothing and everything downstream of it is beyond the horizon too.
//
// Every start records the constraint that bound it. Deterministic: same inputs, same output.

import type { Demand, Plan, Scenario, SeatDef, SeatId, WorkItem } from "./model";

export type Binding =
  | { kind: "declared" }
  | { kind: "underway" }
  | { kind: "predecessor"; id: string }
  | { kind: "capacity"; seat: SeatId; carrier: SeatId };

export interface Scheduled {
  item: WorkItem;
  start: number;
  /** Exclusive. Equal to the horizon for standing items and for items beyond it. */
  end: number;
  duration: number;
  /** True when the item never fit inside the horizon. */
  beyond: boolean;
  binding: Binding;
  /** Who carries each demand at the start month: the seat, or its fallback. */
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
}

export const effectiveHires = (plan: Plan, scenario: Scenario): Record<SeatId, number[]> =>
  Object.fromEntries(
    plan.seats.map((s) => [s.id, s.hireMonths.map((m) => Math.max(0, m + (scenario.hireDelay?.[s.id] ?? 0)))]),
  );

/** Seats of a role on payroll in a month. */
export const seatsHired = (hires: number[], m: number): number => hires.filter((h) => h <= m).length;

/** Where a demand lands in a given month: the seat if hired, else along its fallback chain. */
export function carrierFor(
  seatDefs: Map<SeatId, SeatDef>,
  hires: Record<SeatId, number[]>,
  seat: SeatId,
  m: number,
  depth = 0,
): SeatId | "external" {
  if (seatsHired(hires[seat] ?? [], m) > 0) return seat;
  const def = seatDefs.get(seat);
  if (!def || def.fallback === null || depth > 8) return seat; // nobody: the load shows on the empty seat
  if (def.fallback === "external") return "external";
  return carrierFor(seatDefs, hires, def.fallback, m, depth + 1);
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
  const done = new Map<string, Scheduled>();
  const eff = scenario.effortScale ?? 1;

  const durationOf = (i: WorkItem): number => {
    if (i.standing) return Math.max(1, H - i.earliest);
    if (i.underway) return i.duration;
    return Math.max(1, Math.round(i.duration * (scenario.durationScale ?? 1)));
  };

  const fits = (i: WorkItem, start: number, duration: number): { ok: boolean; seat?: SeatId; carrier?: SeatId } => {
    for (let m = start; m < Math.min(start + duration, H); m++) {
      for (const d of i.demands) {
        const c = carrierFor(seatDefs, hires, d.seat, m);
        if (c === "external") continue;
        const load = loads.get(c);
        if (!load) return { ok: false, seat: d.seat, carrier: c };
        if (load.demand[m] + d.fte * eff > load.capacity[m] + 1e-9) return { ok: false, seat: d.seat, carrier: c };
      }
    }
    return { ok: true };
  };

  const book = (i: WorkItem, start: number, duration: number) => {
    for (let m = start; m < Math.min(start + duration, H); m++) {
      for (const d of i.demands) {
        const c = carrierFor(seatDefs, hires, d.seat, m);
        if (c === "external") continue;
        const load = loads.get(c);
        if (!load) continue;
        load.demand[m] += d.fte * eff;
        if (i.underway || c !== d.seat) load.fixed[m] += d.fte * eff;
      }
    }
  };

  for (const i of order(plan.items, plan.circles)) {
    const duration = durationOf(i);
    let start = Math.max(0, i.earliest);
    let binding: Binding = i.underway ? { kind: "underway" } : { kind: "declared" };
    if (!i.underway) {
      for (const p of i.predecessors) {
        const pd = done.get(p.id)!;
        const ready = (pd.beyond ? H : pd.item.standing ? pd.start + 1 : pd.end) + (p.lag ?? 0);
        if (ready > start) {
          start = ready;
          binding = { kind: "predecessor", id: p.id };
        }
      }
      if (scenario.level && start < H) {
        let probe = start;
        let f = fits(i, probe, duration);
        while (!f.ok && probe < H) {
          probe += 1;
          if (probe < H) f = fits(i, probe, duration);
        }
        if (probe !== start) {
          const last = fits(i, Math.min(probe, H) - 1, duration);
          binding = { kind: "capacity", seat: last.seat!, carrier: last.carrier! };
          start = probe;
        }
      }
    }
    const beyond = start >= H;
    if (beyond) start = H;
    else book(i, start, duration);
    const carriers = i.demands.map((d: Demand) => ({
      seat: d.seat,
      carrier: carrierFor(seatDefs, hires, d.seat, Math.min(start, H - 1)),
      fte: d.fte * eff,
    }));
    done.set(i.id, {
      item: i,
      start,
      end: beyond ? H : Math.min(start + duration, H),
      duration,
      beyond,
      binding,
      carriers,
    });
  }

  return {
    scenario,
    horizon: H,
    items: plan.items.map((i) => done.get(i.id)!),
    loads: plan.seats.map((s) => loads.get(s.id)!),
    hires,
  };
}

export interface Slip {
  id: string;
  label: string;
  /** Months later than the baseline; equal to the horizon when the item fell beyond it. */
  months: number;
  beyond: boolean;
  binding: Binding;
}

/** Items that moved against a baseline schedule, largest slip first. */
export function slips(base: Schedule, other: Schedule): Slip[] {
  const byId = new Map(base.items.map((s) => [s.item.id, s]));
  return other.items
    .map((s) => ({ id: s.item.id, label: s.item.label, months: s.start - byId.get(s.item.id)!.start, beyond: s.beyond, binding: s.binding }))
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
