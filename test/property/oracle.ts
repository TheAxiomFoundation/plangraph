// An independent statement of what the scheduler's documentation promises, and a replay
// checker that compares a Schedule with it. Nothing here calls the engine's scheduling
// internals (effectiveHiring, carrierFor, order, fits): effective hires, carrier chains, the
// processing order, durations, demand profiles and readiness are re-derived from the
// documented rules (the header of src/schedule.ts, the doc comments in src/model.ts, and the
// README's "Scheduling" section).
//
// The replay walks the schedule in the documented processing order and, for each item, checks
// the item against the load that had been booked when the item was placed. That is what the
// scheduler promises: room at the time of booking. What it promises about the final state is
// weaker, and checkMovable and checkFinalCapacity state it separately.
//
// ONE RULE IS COPIED, NOT DERIVED: binds() below, which carriers leveling waits for. The docs
// state it only loosely, so it restates the `continue` conditions in fits() in
// src/schedule.ts. Anything checked through binds() is therefore only as independent as that
// copy; see the notes on P1.cap-asbooked and on checkFinalCapacity.

import type { Binding, Demand, Plan, Scenario, Schedule, Scheduled, SeatId, WorkItem } from "../../src/index";

/** The scheduler's capacity slack: a carrier has room while load + demand <= capacity + EPS. */
const EPS = 1e-9;

/**
 * How far below the largest shortfall a named carrier's shortfall may sit. The scheduler
 * treats shortfalls within 1e-9 as tied and breaks the tie by seat id, and that relation is
 * not transitive, so across a chain of near-ties the named one can drift a few 1e-9 below the
 * maximum. Real differences between the generated FTE values are orders of magnitude larger.
 */
const TIE = 1e-6;

/** model.ts demandAt: FTE by quarter of the run when there is a profile, the last quarter holding. */
export const demandAt = (d: Demand, k: number): number =>
  d.profile && d.profile.length ? d.profile[Math.min(Math.floor(Math.max(0, k) / 3), d.profile.length - 1)] : d.fte;

/** model.ts WorkItem.owner: the explicit owner, else the first demand's seat. */
export const ownerOf = (i: WorkItem): SeatId => i.owner ?? i.demands[0]?.seat ?? "";

const own = (o: object | undefined, k: string): boolean => o !== undefined && Object.prototype.hasOwnProperty.call(o, k);

export type Hiring = Record<SeatId, { months: number[]; index: number[] }>;

/**
 * Scenario.dropSeats, dropHires and hireDelay (model.ts): a dropped role is never hired; a
 * dropped hire is removed; a delay is whole-role or per hire, index-aligned, and a hire is
 * never earlier than month 0. `index` keeps each surviving hire's index into hireMonths.
 */
export function specHires(plan: Plan, sc: Scenario): Hiring {
  const out: Hiring = Object.create(null);
  for (const s of plan.seats) {
    if ((sc.dropSeats ?? []).includes(s.id)) {
      out[s.id] = { months: [], index: [] };
      continue;
    }
    const dropped = own(sc.dropHires, s.id) ? sc.dropHires![s.id] : [];
    const delay = own(sc.hireDelay, s.id) ? sc.hireDelay![s.id] : 0;
    const months: number[] = [];
    const index: number[] = [];
    s.hireMonths.forEach((m, k) => {
      if (dropped.includes(k)) return;
      const d = Array.isArray(delay) ? (delay[k] ?? 0) : delay;
      months.push(Math.max(0, m + d));
      index.push(k);
    });
    out[s.id] = { months, index };
  }
  return out;
}

export const hiredAt = (months: number[], m: number): number => months.filter((h) => h <= m).length;

/**
 * SeatDef.fallback (model.ts) and the README: while a role has no hire, all of its demand goes
 * to its fallback, and on along the chain; "external" is outside help; a role with no
 * fallback keeps the load itself.
 */
export function specCarrier(plan: Plan, hires: Hiring, seat: SeatId, m: number): SeatId | "external" {
  let cur = seat;
  const seen = new Set<SeatId>();
  for (;;) {
    if (hiredAt(hires[cur]?.months ?? [], m) > 0) return cur;
    const def = plan.seats.find((s) => s.id === cur);
    if (!def || def.fallback === null || seen.has(cur)) return cur;
    if (def.fallback === "external") return "external";
    seen.add(cur);
    cur = def.fallback;
  }
}

/**
 * The processing order (README "Scheduling", schedule.ts header): underway items first; then
 * planned items in priority order (circle, then priority, then declared start, then id), each
 * after the predecessors it pulls ahead of itself, in id order. An underway item waits for
 * nothing, so it pulls no predecessor ahead.
 */
export function specOrder(plan: Plan): WorkItem[] {
  const byId = new Map(plan.items.map((i) => [i.id, i]));
  const rank = (c: string) => {
    const k = plan.circles.indexOf(c);
    return k < 0 ? plan.circles.length : k;
  };
  const cmp = (a: WorkItem, b: WorkItem) =>
    rank(a.circle) - rank(b.circle) || (a.priority ?? 0) - (b.priority ?? 0) || a.earliest - b.earliest || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const seen = new Set<string>();
  const out: WorkItem[] = [];
  const visit = (i: WorkItem) => {
    if (seen.has(i.id)) return;
    seen.add(i.id);
    if (!i.underway) for (const p of i.predecessors.map((q) => q.id).sort()) visit(byId.get(p)!);
    out.push(i);
  };
  for (const i of [...plan.items].sort(cmp)) visit(i);
  return [...out.filter((i) => i.underway), ...out.filter((i) => !i.underway)];
}

/**
 * Months a run takes from `start` (README, model.ts): standing work runs to the horizon (at
 * least a month); underway work keeps its duration; planned work scales by durationScale,
 * rounded, at least a month.
 */
export function specDuration(plan: Plan, sc: Scenario, i: WorkItem, start: number): number {
  const H = plan.calendar.horizonMonths;
  if (i.standing) return Math.max(1, H - start);
  if (i.underway) return i.duration;
  return Math.max(1, Math.round(i.duration * (sc.durationScale ?? 1)));
}

export interface Ctx {
  plan: Plan;
  sc: Scenario;
  H: number;
  hires: Hiring;
  /** Seats hired by month times capacity per seat. */
  cap: Record<SeatId, number[]>;
  unlevelled: Set<SeatId>;
  eff: number;
}

export function makeCtx(plan: Plan, sc: Scenario): Ctx {
  const H = plan.calendar.horizonMonths;
  const hires = specHires(plan, sc);
  const cap: Record<SeatId, number[]> = Object.create(null);
  for (const s of plan.seats) cap[s.id] = Array.from({ length: H }, (_, m) => hiredAt(hires[s.id].months, m) * s.capacityFte);
  return { plan, sc, H, hires, cap, unlevelled: new Set(plan.seats.filter((s) => s.unlevelled).map((s) => s.id)), eff: sc.effortScale ?? 1 };
}

export interface Placement {
  seat: SeatId;
  carrier: SeatId | "external";
  fte: number;
}

/** Each demand of item i in month m of a run that starts at `start`: its carrier that month, and its FTE times effortScale. */
export function specPlacements(ctx: Ctx, i: WorkItem, m: number, start: number): Placement[] {
  return i.demands.map((d) => ({ seat: d.seat, carrier: specCarrier(ctx.plan, ctx.hires, d.seat, m), fte: demandAt(d, m - start) * ctx.eff }));
}

/**
 * COPIED FROM fits() IN src/schedule.ts, NOT DERIVED: whether leveling waits for room on
 * `carrier` for item i in month m. It skips external carriers; an unlevelled (leadership)
 * carrier unless it is unhired that month and is the item's owner; and, under levelOn
 * "owner", every carrier but the owner. Because this is a copy, a check made through it
 * (P1.cap-asbooked, and the capacity parts of P2) cannot catch a defect in this rule itself.
 */
export function binds(ctx: Ctx, i: WorkItem, carrier: SeatId | "external", m: number): boolean {
  if (carrier === "external") return false;
  if (ctx.unlevelled.has(carrier) && ((ctx.cap[carrier]?.[m] ?? 0) > 0 || carrier !== ownerOf(i))) return false;
  if (ctx.plan.levelOn === "owner" && carrier !== ownerOf(i)) return false;
  return true;
}

export type Load = Record<SeatId, number[]>;

export type Fit =
  | { ok: true }
  | { ok: false; why: "horizon" }
  /** The first month some carrier is short, and every short carrier then with its shortfall. */
  | { ok: false; why: "capacity"; month: number; short: Map<SeatId, number> };

/**
 * Whether item i's whole run fits from month t against `load` (README: "the first month from
 * which every carrier it needs has room for the whole run"; demands landing on one carrier
 * count together). A finite run that passes the horizon does not fit; standing work never passes it.
 */
export function fitsAt(ctx: Ctx, load: Load, i: WorkItem, t: number): Fit {
  const dur = specDuration(ctx.plan, ctx.sc, i, t);
  if (!i.standing && t + dur > ctx.H) return { ok: false, why: "horizon" };
  for (let m = t; m < Math.min(t + dur, ctx.H); m++) {
    const landed = new Map<SeatId, number>();
    for (const p of specPlacements(ctx, i, m, t)) if (p.carrier !== "external") landed.set(p.carrier, (landed.get(p.carrier) ?? 0) + p.fte);
    const short = new Map<SeatId, number>();
    for (const [c, f] of landed) {
      if (!binds(ctx, i, c, m)) continue;
      const over = (load[c]?.[m] ?? 0) + f - (ctx.cap[c]?.[m] ?? 0);
      if (over > EPS) short.set(c, over);
    }
    if (short.size) return { ok: false, why: "capacity", month: m, short };
  }
  return { ok: true };
}

/**
 * Whether a capacity or hire binding names what the documented search found for a run from t:
 * a carrier short of room in the first short month, with the largest shortfall there (the doc
 * comment on fits() in src/schedule.ts), and a seat of the item whose demand lands on that
 * carrier. The kind follows from the named carrier (the Binding doc comment): a hire when
 * nobody is hired to the carrier in that month and the named seat's own demand there is more
 * than nothing; else capacity. Returns what is wrong, or null.
 */
function blockedBindingProblem(ctx: Ctx, load: Load, i: WorkItem, t: number, b: Binding): string | null {
  const f = fitsAt(ctx, load, i, t);
  if (f.ok) return `a run from ${t} fits, so nothing was short there`;
  if (f.why !== "capacity") return `a run from ${t} passes the horizon, so no seat was short there`;
  const shortList = [...f.short].map(([c, x]) => `${c}+${+x.toFixed(6)}`).join(",");
  if (b.kind !== "capacity" && b.kind !== "hire") return `expected a capacity or hire binding for the run from ${t} (short in month ${f.month}: ${shortList}), got ${JSON.stringify(b)}`;
  const mine = f.short.get(b.carrier);
  if (mine === undefined) return `binding names carrier ${b.carrier}, not short in month ${f.month} of the run from ${t} (short: ${shortList})`;
  const worst = Math.max(...f.short.values());
  if (mine < worst - TIE) return `binding names carrier ${b.carrier}, short by ${mine}, but the largest shortfall in month ${f.month} of the run from ${t} is ${worst} (short: ${shortList})`;
  const on = specPlacements(ctx, i, f.month, t).filter((p) => p.carrier === b.carrier);
  if (!on.some((p) => p.seat === b.seat)) return `binding names seat ${b.seat}, whose demand does not land on ${b.carrier} in month ${f.month} (seats there: ${on.map((p) => p.seat).join(",")})`;
  const asking = on.filter((p) => p.fte > EPS);
  const unhired = hiredAt(ctx.hires[b.carrier]?.months ?? [], f.month) === 0;
  // Standing work in the horizon's last month is capacity: a later start drops that month.
  const kind = unhired && asking.length > 0 && (!i.standing || f.month + 1 < ctx.H) ? "hire" : "capacity";
  if (b.kind !== kind) return `binding kind ${b.kind}, but carrier ${b.carrier} in month ${f.month} is ${unhired ? "unhired" : "hired"} and ${asking.length ? "asked for" : "asked for nothing"}: expected ${kind}`;
  if (kind === "hire" && !asking.some((p) => p.seat === b.seat)) return `hire binding names seat ${b.seat}, which asks nothing of ${b.carrier} in month ${f.month}`;
  return null;
}

/**
 * The promises the Binding doc comment makes for a hire, checked directly. Let m be the first
 * short month of the last start that failed. For a scheduled item (last start = start - 1),
 * nobody on the named seat's fallback chain is hired by m, the first of them is hired in m + 1,
 * and m + 1 is at or after the start. For an item beyond the horizon, nobody on the chain is
 * hired by m, and every start after `last` passes the horizon, so `last` is the last month the
 * run could start.
 */
function hirePromiseProblem(ctx: Ctx, load: Load, i: WorkItem, it: Scheduled, last: number): string | null {
  const b = it.binding;
  if (b.kind !== "hire") return null;
  const staffed = (m: number): boolean => {
    const c = specCarrier(ctx.plan, ctx.hires, b.seat, m);
    return c !== "external" && hiredAt(ctx.hires[c]?.months ?? [], m) > 0;
  };
  let firstHire = -1;
  for (let m = 0; m < ctx.H && firstHire < 0; m++) if (staffed(m)) firstHire = m;
  const tried = it.beyond ? last : it.start - 1;
  if (tried < 0) return `hire binding, but no start was short of room`;
  const f = fitsAt(ctx, load, i, tried);
  if (f.ok || f.why !== "capacity") return `hire binding, but the run from ${tried} ${f.ok ? "fits" : "passes the horizon"}`;
  if (staffed(f.month)) return `hire binding, but someone on ${b.seat}'s fallback chain is hired by month ${f.month}, the first short month of the run from ${tried}`;
  if (!it.beyond) {
    if (firstHire !== f.month + 1) return `hire binding, but the first hire on ${b.seat}'s fallback chain is in month ${firstHire}, not ${f.month + 1}, the month after the first short month of the run from ${tried}`;
    if (firstHire < it.start) return `hire binding, but the first hire on ${b.seat}'s fallback chain, in month ${firstHire}, is before the start ${it.start}`;
    return null;
  }
  for (let t = last + 1; t < ctx.H; t++) {
    const g = fitsAt(ctx, load, i, t);
    if (g.ok || g.why !== "horizon") return `beyond with a hire binding at last start ${last}, but a run from ${t} ${g.ok ? "fits" : "is short of room"}, so ${last} is not the last month the run could start`;
  }
  return null;
}

export interface Violation {
  prop: string;
  item?: string;
  msg: string;
}

/** How often a replay met each case, so the tests can show the properties are not vacuous. */
export interface Coverage {
  /** Seats whose effective hires differ from their hireMonths (a drop or a delay). */
  hiresChanged: number;
  scheduled: number;
  underway: number;
  withPredecessor: number;
  standingPredecessor: number;
  fallbackBookings: number;
  externalBookings: number;
  /** Leveled items that started later than they were ready. */
  leveledMoves: number;
  beyondByPredecessor: number;
  /** Beyond because the run cannot fit between readiness and the horizon. */
  beyondByTime: number;
  /** Leveled items that could have run inside the horizon but found no room. */
  beyondByCapacity: number;
  /** Leveled moves and capacity beyonds where a carrier short of room holds underway load. */
  heldByUnderway: number;
  /** Leveled moves that waited for a hire. */
  hireWaits: number;
  /** Items leveling kept beyond the horizon waiting for a hire that lands too late or never. */
  hireTooLate: number;
  dropped: number;
}

export const zeroCoverage = (): Coverage => ({
  hiresChanged: 0, scheduled: 0, underway: 0, withPredecessor: 0, standingPredecessor: 0, fallbackBookings: 0, externalBookings: 0,
  leveledMoves: 0, beyondByPredecessor: 0, beyondByTime: 0, beyondByCapacity: 0, heldByUnderway: 0, hireWaits: 0, hireTooLate: 0, dropped: 0,
});

const pred = (pd: Scheduled, lag = 0): number => (pd.item.standing ? pd.start + 1 : pd.end) + lag;

/**
 * Replay a schedule in the documented processing order and check P1 (soundness) and P2
 * (explanations), item by item, against the load booked before each item was placed.
 *
 * P1.order     bookings are contiguous per item and come in the documented processing order
 * P1.hires     the schedule's hires and hire indices are the scenario's effective hires
 * P1.declared  no item starts before its declared month; underway items start exactly there
 * P1.pred      a planned item starts at or after each predecessor's end plus lag (a standing
 *              predecessor: its start plus one), and never after a predecessor beyond the horizon
 * P1.horizon   duration and end follow the documented rule; no finite run passes the horizon
 * P1.beyond    an item beyond the horizon (or dropped) books nothing and has no carriers; only
 *              leveling or a time cause puts a planned item there, and only a time cause an
 *              underway one
 * P1.bookings  bookings are exactly the item's demands month by month, on that month's carrier
 * P1.cap-asbooked  when leveling, each planned item had room, on every carrier it waits for,
 *              for its whole run when it was booked
 * P2.binding   the binding names the constraint that bound: declared, else the first
 *              predecessor in id order with the latest readiness; underway; for a leveled move,
 *              the carrier short a month before the start (the largest shortfall in the first
 *              short month, and a seat that lands on it); for an item beyond the horizon, the
 *              first beyond predecessor, else the horizon when the time cause holds, else the
 *              same capacity rule at the last start leveling found without room
 * P2.earliest  as planned, a start equals readiness; leveled, no month from readiness to the
 *              start fits
 * P2.complete  leveling put nothing beyond the horizon that fits somewhere from its readiness
 * P2.beyond-label  the horizon label is never used when capacity, not time, kept the item out
 * P2.hire     a hire binding keeps its promise: the role carrying the demand at the start is
 *              first hired that month, or, beyond the horizon, nobody on the seat's chain is
 *              hired by the last month the run could start
 */
export function checkSchedule(plan: Plan, sc: Scenario, S: Schedule): { violations: Violation[]; coverage: Coverage } {
  const v: Violation[] = [];
  const cov = zeroCoverage();
  const ctx = makeCtx(plan, sc);
  const H = ctx.H;
  const byId = new Map(S.items.map((x) => [x.item.id, x]));
  const load: Load = Object.create(null);
  const underwayLoad: Load = Object.create(null);
  for (const s of plan.seats) {
    load[s.id] = new Array(H).fill(0);
    underwayLoad[s.id] = new Array(H).fill(0);
  }
  /** Whether a run of i from t is refused on a carrier that holds underway load in the refused month. */
  const refusedOnUnderway = (i: WorkItem, t: number): boolean => {
    const f = fitsAt(ctx, load, i, t);
    return !f.ok && f.why === "capacity" && [...f.short.keys()].some((c) => (underwayLoad[c]?.[f.month] ?? 0) > 0);
  };

  const bookingsOf = new Map<string, Schedule["bookings"]>();
  const bookingSeq: string[] = [];
  for (const b of S.bookings) {
    if (!bookingsOf.has(b.item)) {
      bookingsOf.set(b.item, []);
      bookingSeq.push(b.item);
    } else if (bookingSeq[bookingSeq.length - 1] !== b.item) {
      v.push({ prop: "P1.order", item: b.item, msg: `bookings of ${b.item} are not contiguous` });
    }
    bookingsOf.get(b.item)!.push(b);
    if (b.carrier === "external") cov.externalBookings++;
    else if (b.carrier !== b.seat) cov.fallbackBookings++;
  }
  const order = specOrder(plan);
  const bookedOrder = order.map((i) => i.id).filter((id) => bookingsOf.has(id));
  if (bookedOrder.join() !== bookingSeq.join()) v.push({ prop: "P1.order", msg: `booking order ${bookingSeq.join()} differs from the documented order ${bookedOrder.join()}` });

  for (const s of plan.seats) {
    const got = JSON.stringify([S.hires[s.id], S.hireIndex[s.id]]);
    const want = JSON.stringify([ctx.hires[s.id].months, ctx.hires[s.id].index]);
    if (got !== want) v.push({ prop: "P1.hires", msg: `hires and hire indices of ${s.id}: engine ${got}, spec ${want}` });
    if (JSON.stringify(ctx.hires[s.id].months) !== JSON.stringify(s.hireMonths)) cov.hiresChanged++;
  }

  for (const i of order) {
    const it = byId.get(i.id)!;
    const base = Math.max(0, i.earliest);
    if (it.dropped) {
      cov.dropped++;
      if (it.binding.kind !== "dropped") v.push({ prop: "P2.binding", item: i.id, msg: `dropped item has binding ${JSON.stringify(it.binding)}` });
      if (bookingsOf.has(i.id) || it.carriers.length) v.push({ prop: "P1.beyond", item: i.id, msg: "dropped item books or has carriers" });
      continue;
    }
    // Readiness: the declared month, then every predecessor's end plus lag (a standing
    // predecessor releases its successors one month after it starts). Underway work waits for nothing.
    const preds = [...i.predecessors].sort((a, b) => (a.id < b.id ? -1 : 1)).map((p) => ({ p, pd: byId.get(p.id)! }));
    const beyondPred = i.underway ? undefined : preds.find(({ pd }) => pd.beyond);
    let ready = base;
    let argmax: string | null = null;
    if (!i.underway && !beyondPred) {
      for (const { p, pd } of preds) {
        const r = pred(pd, p.lag);
        if (r > ready) {
          ready = r;
          argmax = p.id;
        }
      }
    }
    const b = it.binding;
    const leveled = sc.level && !i.underway;

    if (it.beyond) {
      if (bookingsOf.has(i.id) || it.carriers.length) v.push({ prop: "P1.beyond", item: i.id, msg: "beyond item books or has carriers" });
      if (it.start !== H || it.end !== H || it.duration !== 0) v.push({ prop: "P1.beyond", item: i.id, msg: `beyond item start/end/duration ${it.start}/${it.end}/${it.duration}, expected ${H}/${H}/0` });
      if (beyondPred) {
        cov.beyondByPredecessor++;
        // The scheduler names the first predecessor, in id order, that never finishes.
        const want: Binding = { kind: "predecessor", id: beyondPred.p.id };
        if (JSON.stringify(b) !== JSON.stringify(want)) v.push({ prop: "P2.binding", item: i.id, msg: `beyond after predecessor ${beyondPred.p.id}, expected binding ${JSON.stringify(want)}, got ${JSON.stringify(b)}` });
        continue;
      }
      // The time cause: the run cannot fit between readiness and the horizon, whatever the capacity.
      const timeCause = ready >= H || (!i.standing && ready + specDuration(plan, sc, i, ready) > H);
      // Leveling's search: every start from readiness to the horizon. Nothing may fit, and the
      // last start it found short of room (not past the horizon) is the one a capacity binding names.
      let last = -1;
      if (leveled) {
        for (let t = ready; t < H; t++) {
          const f = fitsAt(ctx, load, i, t);
          if (f.ok) v.push({ prop: "P2.complete", item: i.id, msg: `beyond the horizon, but a run from ${t} fits` });
          else if (f.why === "capacity") last = t;
        }
      }
      if (timeCause) cov.beyondByTime++;
      else if (leveled) {
        cov.beyondByCapacity++;
        if (last >= 0 && refusedOnUnderway(i, last)) cov.heldByUnderway++;
      } else {
        v.push({ prop: "P1.beyond", item: i.id, msg: `${i.underway ? "underway" : "as-planned"} item beyond the horizon, though a ${specDuration(plan, sc, i, ready)}-month run from ready month ${ready} ends by ${H}` });
      }
      if (timeCause) {
        // Time cause => horizon.
        if (b.kind !== "horizon") v.push({ prop: "P2.binding", item: i.id, msg: `beyond for lack of time (ready ${ready}, ${specDuration(plan, sc, i, ready)} months, horizon ${H}), expected binding horizon, got ${JSON.stringify(b)}` });
      } else if (b.kind === "horizon") {
        // Horizon => time cause, stated as its own clause: the label W104 turns into "its run would extend past the horizon".
        const f = fitsAt(ctx, load, i, ready);
        v.push({ prop: "P2.beyond-label", item: i.id, msg: `binding horizon, but a ${specDuration(plan, sc, i, ready)}-month run from ready month ${ready} ends by ${H}; capacity kept it out (at ${ready}: ${f.ok ? "fits" : f.why === "capacity" ? `short ${[...f.short.keys()].join(",")} in month ${f.month}` : f.why})` });
      } else if (leveled) {
        // Otherwise the binding is the capacity failure at the last start leveling tried and found without room.
        const problem = last < 0 ? `binding ${JSON.stringify(b)}, but no start from ${ready} was short of room` : blockedBindingProblem(ctx, load, i, last, b);
        if (problem) v.push({ prop: "P2.binding", item: i.id, msg: `beyond the horizon: ${problem}` });
        if (b.kind === "hire") cov.hireTooLate++;
        const promise = hirePromiseProblem(ctx, load, i, it, last);
        if (promise) v.push({ prop: "P2.hire", item: i.id, msg: promise });
      }
      continue;
    }

    // Scheduled.
    cov.scheduled++;
    if (i.underway) cov.underway++;
    if (!i.underway && preds.length) cov.withPredecessor++;
    if (!i.underway && preds.some(({ pd }) => pd.item.standing)) cov.standingPredecessor++;
    const dur = specDuration(plan, sc, i, it.start);
    if (it.duration !== dur || it.end !== Math.min(it.start + dur, H)) v.push({ prop: "P1.horizon", item: i.id, msg: `duration/end ${it.duration}/${it.end}, spec ${dur}/${Math.min(it.start + dur, H)}` });
    if (!i.standing && it.start + dur > H) v.push({ prop: "P1.horizon", item: i.id, msg: `finite run ${it.start}+${dur} passes horizon ${H}` });
    if (it.start < base) v.push({ prop: "P1.declared", item: i.id, msg: `start ${it.start} before declared ${base}` });
    if (i.underway) {
      if (it.start !== base) v.push({ prop: "P1.declared", item: i.id, msg: `underway start ${it.start} is not the declared ${base}` });
      if (b.kind !== "underway") v.push({ prop: "P2.binding", item: i.id, msg: `underway item has binding ${JSON.stringify(b)}` });
    } else {
      for (const { p, pd } of preds) {
        if (pd.beyond || it.start < pred(pd, p.lag)) v.push({ prop: "P1.pred", item: i.id, msg: `start ${it.start} before predecessor ${p.id} is ready (${pd.beyond ? "never" : pred(pd, p.lag)})` });
      }
      const atReady: Binding = argmax === null ? { kind: "declared" } : { kind: "predecessor", id: argmax };
      if (it.start === ready) {
        if (JSON.stringify(b) !== JSON.stringify(atReady)) v.push({ prop: "P2.binding", item: i.id, msg: `start ${it.start} is its readiness; expected binding ${JSON.stringify(atReady)}, got ${JSON.stringify(b)}` });
      } else if (it.start < ready) {
        v.push({ prop: "P1.pred", item: i.id, msg: `start ${it.start} before readiness ${ready}` });
      } else if (!sc.level) {
        v.push({ prop: "P2.earliest", item: i.id, msg: `as-planned start ${it.start} later than readiness ${ready}` });
      } else {
        cov.leveledMoves++;
        if (refusedOnUnderway(i, it.start - 1)) cov.heldByUnderway++;
        for (let t = ready; t < it.start; t++) if (fitsAt(ctx, load, i, t).ok) v.push({ prop: "P2.earliest", item: i.id, msg: `leveled start ${it.start}, but a run from ${t} fits` });
        const problem = blockedBindingProblem(ctx, load, i, it.start - 1, b);
        if (problem) v.push({ prop: "P2.binding", item: i.id, msg: `leveled start ${it.start} after readiness ${ready}: ${problem}` });
        if (b.kind === "hire") cov.hireWaits++;
        const promise = hirePromiseProblem(ctx, load, i, it, -1);
        if (promise) v.push({ prop: "P2.hire", item: i.id, msg: promise });
      }
      // NEAR-TAUTOLOGICAL: fitsAt waits for exactly the carriers binds() names, and binds() is a
      // copy of the engine's own rule. This clause catches a booking that ignores that rule's
      // verdict, a wrong load, or a wrong month; it cannot catch a wrong rule. P1.cap-final and
      // P1.movable are the capacity checks that do not go through binds().
      if (sc.level) {
        const f = fitsAt(ctx, load, i, it.start);
        if (!f.ok) v.push({ prop: "P1.cap-asbooked", item: i.id, msg: `booked at ${it.start} without room: ${f.why === "capacity" ? `short ${[...f.short].map(([c, x]) => `${c}+${+x.toFixed(6)}`).join(",")} in month ${f.month}` : f.why}` });
      }
    }
    // Bookings equal the documented placements for the run.
    const want: string[] = [];
    for (let m = it.start; m < it.end; m++) for (const p of specPlacements(ctx, i, m, it.start)) want.push(`${m}|${p.seat}|${p.carrier}|${+p.fte.toFixed(12)}`);
    const got = (bookingsOf.get(i.id) ?? []).map((x) => `${x.month}|${x.seat}|${x.carrier}|${+x.fte.toFixed(12)}`);
    if (want.sort().join() !== got.sort().join()) v.push({ prop: "P1.bookings", item: i.id, msg: `bookings [${got.join(" ")}] differ from the documented placements [${want.join(" ")}]` });
    for (const x of bookingsOf.get(i.id) ?? []) {
      if (x.carrier === "external" || !load[x.carrier]) continue;
      load[x.carrier][x.month] += x.fte;
      if (i.underway) underwayLoad[x.carrier][x.month] += x.fte;
    }
  }
  return { violations: v, coverage: cov };
}

/**
 * P1.cap-final, the planner's reading of a leveled schedule (LEVELED's gist in model.ts:
 * "Movable work slides later in priority order until its internal carriers fit"): no month a
 * leveled planned item occupies on an internal carrier ends over capacity. Underway work books
 * first, so nothing booked after a planned item may push a carrier it waits for over.
 *
 * This check does not go through binds(): it is stated only for plans where leveling waits
 * for every internal carrier (levelOn "all", no unlevelled seats), and there every internal
 * carrier binds by the documented rules alone, so it holds the engine to the final state, not
 * to its own rule.
 */
export function checkFinalCapacity(plan: Plan, sc: Scenario, S: Schedule): Violation[] {
  if (!sc.level) return [];
  if (plan.levelOn === "owner" || plan.seats.some((s) => s.unlevelled)) throw new Error("checkFinalCapacity is stated for levelOn all without unlevelled seats");
  const v: Violation[] = [];
  const loads = new Map(S.loads.map((l) => [l.seat, l]));
  const seq = specOrder(plan).map((i) => i.id);
  for (const it of S.items) {
    if (it.beyond || it.item.underway) continue;
    for (const b of S.bookings) {
      if (b.item !== it.item.id || b.carrier === "external") continue;
      const l = loads.get(b.carrier)!;
      if (l.demand[b.month] > l.capacity[b.month] + EPS) {
        const later = S.bookings.filter((x) => x.carrier === b.carrier && x.month === b.month && x.item !== it.item.id && seq.indexOf(x.item) > seq.indexOf(it.item.id)).map((x) => x.item);
        v.push({ prop: "P1.cap-final", item: it.item.id, msg: `leveled ${it.item.id} runs on ${b.carrier} in month ${b.month}, which ends at ${l.demand[b.month]} > capacity ${l.capacity[b.month]}; booked after it there: ${[...new Set(later)].join(",") || "none"}` });
      }
    }
  }
  return v;
}

/**
 * P1.movable, the invariant test/engine.test.ts asserts for leveled schedules: on every seat
 * leveling always waits for, demand minus fixed load (underway work, and load carried for an
 * unhired seat) never exceeds capacity. Stated where every internal carrier binds.
 */
export function checkMovable(plan: Plan, sc: Scenario, S: Schedule): Violation[] {
  if (!sc.level || plan.levelOn === "owner") return [];
  const v: Violation[] = [];
  for (const l of S.loads) {
    if (plan.seats.find((s) => s.id === l.seat)?.unlevelled) continue;
    for (let m = 0; m < S.horizon; m++) {
      if (l.demand[m] - l.fixed[m] > l.capacity[m] + EPS) v.push({ prop: "P1.movable", msg: `${l.seat} month ${m}: demand ${l.demand[m]} - fixed ${l.fixed[m]} > capacity ${l.capacity[m]}` });
    }
  }
  return v;
}
