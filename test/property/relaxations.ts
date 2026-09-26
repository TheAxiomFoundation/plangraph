// Relaxations for the monotonicity property: each gives the plan more staff, sooner, or less
// work, or fewer dependencies. Applied at two generated choices a and b; null when a
// relaxation does not apply to the plan at hand (no predecessor to remove, say).

import type { Plan, Scenario, Schedule } from "../../src/index";
import { withoutIgnoredOverrides } from "./arbitraries";

export interface Change {
  plan: Plan;
  sc: Scenario;
  what: string;
}

export type Relax = (plan: Plan, sc: Scenario, a: number, b: number) => Change | null;

/** Each relaxation, applied at choices a and b; null when it does not apply to this plan. */
export const RELAX: Record<string, Relax> = {
  "hire earlier": (plan, sc, a, b) => {
    const seat = plan.seats[a % plan.seats.length];
    const k = b % seat.hireMonths.length;
    if ((sc.dropSeats ?? []).includes(seat.id) || (sc.dropHires?.[seat.id] ?? []).includes(k)) return null;
    const d0 = sc.hireDelay?.[seat.id] ?? 0;
    const per = seat.hireMonths.map((_, j) => (Array.isArray(d0) ? (d0[j] ?? 0) : d0));
    if (Math.max(0, seat.hireMonths[k] + per[k]) === 0) return null;
    per[k] -= 1;
    const next = withoutIgnoredOverrides(plan, { ...sc, hireDelay: { ...(sc.hireDelay ?? {}), [seat.id]: per } });
    return { plan, sc: next, what: `hire ${k} of ${seat.id} one month earlier (hireDelay ${JSON.stringify(next.hireDelay![seat.id])})` };
  },
  "add a hire": (plan, sc, a, b) => {
    const p = structuredClone(plan);
    const seat = p.seats[a % p.seats.length];
    if ((sc.dropSeats ?? []).includes(seat.id)) return null;
    const m = b % plan.calendar.horizonMonths;
    seat.hireMonths.push(m);
    return { plan: p, sc, what: `add a hire of ${seat.id} at month ${m}` };
  },
  "scale durations down": (plan, sc, a) => {
    const f = [0.5, 0.75, 0.9][a % 3];
    return { plan, sc: { ...sc, durationScale: (sc.durationScale ?? 1) * f }, what: `durationScale x${f}` };
  },
  "shorten one item": (plan, sc, a) => {
    const p = structuredClone(plan);
    const it = p.items[a % p.items.length];
    if (it.standing || it.duration < 2) return null;
    it.duration -= 1;
    return { plan: p, sc, what: `${it.id}.duration ${it.duration + 1} -> ${it.duration}` };
  },
  "scale effort down": (plan, sc, a) => {
    const f = [0.5, 0.75, 0.9][a % 3];
    return { plan, sc: { ...sc, effortScale: (sc.effortScale ?? 1) * f }, what: `effortScale x${f}` };
  },
  "halve one demand": (plan, sc, a, b) => {
    const p = structuredClone(plan);
    const it = p.items[a % p.items.length];
    const d = it.demands[b % it.demands.length];
    d.fte /= 2;
    if (d.profile) d.profile = d.profile.map((x) => x / 2);
    return { plan: p, sc, what: `${it.id}'s demand on ${d.seat} halved` };
  },
  "add capacity": (plan, sc, a) => {
    const p = structuredClone(plan);
    const s = p.seats[a % p.seats.length];
    s.capacityFte += 0.5;
    return { plan: p, sc, what: `${s.id}.capacityFte ${s.capacityFte - 0.5} -> ${s.capacityFte}` };
  },
  "remove an edge": (plan, sc, a, b) => {
    const p = structuredClone(plan);
    const withPreds = p.items.filter((i) => i.predecessors.length);
    if (!withPreds.length) return null;
    const it = withPreds[a % withPreds.length];
    const [gone] = it.predecessors.splice(b % it.predecessors.length, 1);
    return { plan: p, sc, what: `remove edge ${gone.id} -> ${it.id}` };
  },
  "drop an item nothing depends on": (plan, sc, a) => {
    const sinks = plan.items.filter((i) => !plan.items.some((j) => j.predecessors.some((p) => p.id === i.id)) && !(sc.dropItems ?? []).includes(i.id));
    if (!sinks.length) return null;
    const it = sinks[a % sinks.length];
    return { plan, sc: { ...sc, dropItems: [...(sc.dropItems ?? []), it.id] }, what: `drop ${it.id}` };
  },
};

/** Beyond the horizon counts as infinitely late. */
const when = (s: Schedule["items"][number]) => (s.beyond ? Infinity : s.start);

/** Items, present in both schedules, that start later (or newly fall beyond the horizon) after the relaxation. */
export function later(before: Schedule, after: Schedule): string[] {
  const out: string[] = [];
  for (const b of before.items) {
    const a = after.items.find((x) => x.item.id === b.item.id)!;
    if (a.dropped || b.dropped) continue;
    if (when(a) > when(b)) out.push(`${b.item.id} ${b.beyond ? "beyond" : b.start} -> ${a.beyond ? "beyond" : a.start}`);
  }
  return out;
}
