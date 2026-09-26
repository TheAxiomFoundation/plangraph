// The harness: checks over a plan, its schedule and its ledger that fire while the graph is
// being built. Errors mean the graph is not a plan yet. Warnings mean it is a plan that does
// not make sense somewhere. Info is a fact worth knowing. Each finding names its subject and
// says what to do, so an agent editing nodes gets the same feedback a reviewer would give.

import { atFundingYearEnd, byFundingYear, fundingYears, sumRange, type Ledger } from "./economics.js";
import { lintPolicy, monthLabel, ownerOf, type Plan, type Scenario, type SeatId } from "./model.js";
import { bookingOrder, carrierFor, effectiveHiring, overloads, schedule, seatsHired, type Schedule, type Scheduled } from "./schedule.js";

export type Severity = "error" | "warn" | "info";

export interface Finding {
  code: string;
  severity: Severity;
  /** Item, seat, stream or scenario id the finding is about. */
  subject: string;
  message: string;
  hint: string;
}

const seatTitle = (plan: Plan, id: string) => plan.seats.find((s) => s.id === id)?.title ?? id;

const percent = (share: number): string => `${Number((share * 100).toFixed(1))}%`;

/**
 * Sums of FTE and of dollars can differ in their last bit with the order they were added, so
 * thresholds on sums, and on shares of them, get the slack overloads() uses: a value exactly
 * at a threshold counts as at it, whatever the order. Cash is a running sum of dollars whose
 * drift can pass that slack, so W105 gets half a cent instead.
 */
const SLACK = 1e-9;
const CASH_SLACK = 0.005;

/** Structural checks that need no schedule. */
export function lintPlan(plan: Plan): Finding[] {
  const out: Finding[] = [];
  const H = plan.calendar.horizonMonths;
  const dup = (ids: string[], what: string) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) out.push({ code: "E001", severity: "error", subject: id, message: `Duplicate ${what} id "${id}".`, hint: "Ids are the graph's edges; make each unique." });
      seen.add(id);
    }
  };
  dup(plan.items.map((i) => i.id), "item");
  dup(plan.seats.map((s) => s.id), "seat");
  dup(plan.streams.map((s) => s.id), "stream");
  dup(plan.funding.map((f) => f.id), "funding line");
  dup(plan.nonLabor.map((n) => n.id), "non-labor line");
  dup((plan.scenarios ?? []).map((s) => s.id), "scenario");
  dup(plan.circles, "circle");

  const itemIds = new Set(plan.items.map((i) => i.id));
  const seatIds = new Set(plan.seats.map((s) => s.id));
  const circles = new Set(plan.circles);
  for (const i of plan.items) {
    if (!circles.has(i.circle)) {
      out.push({ code: "E007", severity: "error", subject: i.id, message: `"${i.label}" uses unknown circle "${i.circle}".`, hint: "Add the circle to the plan's priority list or fix the name." });
    }
    for (const p of i.predecessors) {
      if (!itemIds.has(p.id)) out.push({ code: "E002", severity: "error", subject: i.id, message: `"${i.label}" depends on unknown item "${p.id}".`, hint: "Add the item or fix the id." });
      if (p.id === i.id) out.push({ code: "E002", severity: "error", subject: i.id, message: `"${i.label}" depends on itself.`, hint: "Remove the self-edge." });
      if ((p.lag ?? 0) < 0) out.push({ code: "E002", severity: "error", subject: i.id, message: `"${i.label}" has a negative lag on "${p.id}".`, hint: "Lags run forward; use an earlier predecessor instead." });
    }
    if (i.demands.length === 0) out.push({ code: "E004", severity: "error", subject: i.id, message: `"${i.label}" demands no seat: nobody owns it.`, hint: "Give it at least one demand." });
    const demanded = new Set<SeatId>();
    for (const d of i.demands) {
      if (!seatIds.has(d.seat)) out.push({ code: "E004", severity: "error", subject: i.id, message: `"${i.label}" demands unknown seat "${d.seat}".`, hint: "Seat ids come from the plan's seats." });
      if (!(d.fte > 0)) out.push({ code: "E004", severity: "error", subject: i.id, message: `"${i.label}" demands ${d.fte} FTE of ${d.seat}.`, hint: "Demand must be positive." });
      if (demanded.has(d.seat)) out.push({ code: "E004", severity: "error", subject: i.id, message: `"${i.label}" demands seat "${d.seat}" more than once.`, hint: "Combine the demand into one entry per seat." });
      demanded.add(d.seat);
    }
    if (i.owner !== undefined && !demanded.has(i.owner)) {
      out.push({ code: "E004", severity: "error", subject: i.id, message: `"${i.label}" names owner "${i.owner}" but does not demand that seat.`, hint: "The owner must be one of the item's demanded seats." });
    }
    if (!i.standing && !(i.duration > 0)) out.push({ code: "E005", severity: "error", subject: i.id, message: `"${i.label}" has no duration.`, hint: "Give it months, or mark it standing." });
    if (i.earliest < 0 || i.earliest >= H) out.push({ code: "E005", severity: "error", subject: i.id, message: `"${i.label}" starts outside the horizon (${i.earliest}).`, hint: `Month indices run 0..${H - 1}.` });
  }

  // General dependency cycles. Unknown edges are already reported above and are skipped;
  // each back edge names the complete cycle it closes.
  const byItem = new Map(plan.items.map((item) => [item.id, item]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles = new Set<string>();
  const visit = (id: string) => {
    const item = byItem.get(id);
    if (!item || state.get(id) === 2) return;
    state.set(id, 1);
    stack.push(id);
    for (const predecessor of item.predecessors) {
      if (predecessor.id === id || !byItem.has(predecessor.id)) continue;
      if (state.get(predecessor.id) === 1) {
        const from = stack.indexOf(predecessor.id);
        const cycle = [...stack.slice(from), predecessor.id];
        const key = cycle.join("\0");
        if (!cycles.has(key)) {
          cycles.add(key);
          out.push({ code: "E002", severity: "error", subject: id, message: `Dependency cycle: ${cycle.map((part) => `"${part}"`).join(" -> ")}.`, hint: "Remove an edge so dependencies form a directed acyclic graph." });
        }
      } else if (state.get(predecessor.id) !== 2) {
        visit(predecessor.id);
      }
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const item of plan.items) if (state.get(item.id) === undefined) visit(item.id);

  for (const st of plan.streams) {
    if (!itemIds.has(st.unlockedBy)) out.push({ code: "E003", severity: "error", subject: st.id, message: `Stream "${st.label}" is unlocked by unknown item "${st.unlockedBy}".`, hint: "Point it at the item whose completion turns it on." });
    if (st.volumeByYear.units.length === 0) out.push({ code: "E003", severity: "error", subject: st.id, message: `Stream "${st.label}" has no volumes.`, hint: "Give it at least one year of volume." });
  }
  for (const s of plan.seats) {
    if (s.id === "external") {
      out.push({ code: "E006", severity: "error", subject: s.id, message: `Seat id "external" is reserved for the external-carrier sentinel.`, hint: "Rename the seat." });
    }
    const seen = new Set<string>();
    let cur: SeatId | "external" | null = s.fallback;
    while (cur && cur !== "external") {
      if (seen.has(cur) || cur === s.id) {
        out.push({ code: "E006", severity: "error", subject: s.id, message: `Fallback chain from "${s.title}" loops.`, hint: "A chain must end at a person in place, at external, or at null." });
        break;
      }
      seen.add(cur);
      const next = plan.seats.find((x) => x.id === cur);
      if (!next) {
        out.push({ code: "E006", severity: "error", subject: s.id, message: `"${s.title}" falls back to unknown seat "${cur}".`, hint: "Fallbacks are seat ids." });
        break;
      }
      cur = next.fallback;
    }
    if (s.hireMonths.length === 0) out.push({ code: "E006", severity: "error", subject: s.id, message: `"${s.title}" has no seats.`, hint: "Give it at least one hire month." });
    if (!(s.capacityFte > 0)) out.push({ code: "E006", severity: "error", subject: s.id, message: `"${s.title}" has no capacity.`, hint: "Capacity per seat must be positive." });
  }
  return out;
}

/** Checks that need the schedule and the money. */
export function lintSchedule(plan: Plan, s: Schedule, l: Ledger): Finding[] {
  const capacityOf = new Map(s.loads.map((l) => [l.seat, l.capacity]));
  /** Whether a carrier id is a hired seat in a month; an empty terminal role or "external" is not. */
  const staffedAt = (carrier: string, m: number): boolean => carrier !== "external" && (capacityOf.get(carrier)?.[m] ?? 0) > 0;
  const out: Finding[] = [];
  const cal = plan.calendar;
  const H = cal.horizonMonths;
  const label = (m: number) => monthLabel(cal, m);
  const byId = new Map(s.items.map((x) => [x.item.id, x]));
  /**
   * What holds an item beyond the horizon, traced through every predecessor that is beyond it,
   * not only the one its binding names: the items the scenario drops, and the items that do not
   * fit for a reason of their own. The trace goes on through a dropped item that is not underway,
   * since kept, it would still wait for its own predecessors. Both empty for an item that is not
   * beyond, or not beyond because of a predecessor. Each list in id order.
   */
  const heldBy = (it: Scheduled): { dropped: Scheduled[]; unfit: Scheduled[] } => {
    const dropped: Scheduled[] = [];
    const unfit: Scheduled[] = [];
    const seen = new Set<string>();
    const walk = (cur: Scheduled): void => {
      for (const p of cur.item.predecessors) {
        const pd = byId.get(p.id)!;
        if (!pd.beyond || seen.has(pd.item.id)) continue;
        seen.add(pd.item.id);
        if (pd.dropped) {
          dropped.push(pd);
          if (!pd.item.underway) walk(pd);
        } else if (pd.binding.kind === "predecessor") walk(pd);
        else unfit.push(pd);
      }
    };
    if (it.beyond && !it.dropped && it.binding.kind === "predecessor") walk(it);
    const byItemId = (a: Scheduled, b: Scheduled) => (a.item.id < b.item.id ? -1 : 1);
    return { dropped: dropped.sort(byItemId), unfit: unfit.sort(byItemId) };
  };
  /** Quoted, joined with "and": `"a"`, `"a" and "b"`, `"a", "b" and "c"`. */
  const quoted = (xs: string[]): string => {
    const q = xs.map((x) => `"${x}"`);
    return q.length < 2 ? q.join("") : `${q.slice(0, -1).join(", ")} and ${q[q.length - 1]}`;
  };
  /** Why an item held by a drop never starts: the drop, and anything upstream that does not fit either. */
  const heldCause = (held: { dropped: Scheduled[]; unfit: Scheduled[] }, name: (x: Scheduled) => string): string =>
    `this scenario drops ${quoted(held.dropped.map(name))}, which it depends on` +
    (held.unfit.length ? `, and ${quoted(held.unfit.map(name))} ${held.unfit.length === 1 ? "does" : "do"} not fit inside the horizon` : "");
  const years = fundingYears(cal);
  const y1End = cal.fundingYearStartMonth + 12;
  const policy = lintPolicy(plan);
  // For W104: a wait for a hire is told apart from a full seat. The first names the hire the
  // item waits for (once hired, the seat still needs room for it), the second the seat that has
  // no room.
  const seatDefs = new Map(plan.seats.map((x) => [x.id, x]));
  /** Who carries a seat's demand in a month when anyone hired does: the role, or the hired seat on its fallback chain. */
  const staffedCarrier = (seat: SeatId, m: number): SeatId | null => {
    const c = carrierFor(seatDefs, s.hires, seat, m);
    return c !== "external" && seatsHired(s.hires[c], m) > 0 ? c : null;
  };
  /** The first month anyone on a seat's fallback chain is hired, and who: the role that then carries its demand. */
  const firstStaffed = (seat: SeatId): { month: number; carrier: SeatId } | null => {
    for (let m = 0; m < H; m++) {
      const c = staffedCarrier(seat, m);
      if (c !== null) return { month: m, carrier: c };
    }
    return null;
  };
  /** Why an item waiting for a hire never fits: nobody on the seat's chain is hired by the last month its run could start. */
  const hireTooLate = (it: Scheduled, seat: SeatId): { why: string; hint: string } => {
    const first = firstStaffed(seat);
    if (first === null) {
      return {
        why: it.binding.kind === "hire" && it.binding.carrier === seat
          ? `this scenario does not hire ${seatTitle(plan, seat)} inside the horizon`
          : `this scenario hires nobody to carry ${seatTitle(plan, seat)}'s work inside the horizon`,
        hint: `Hire ${seatTitle(plan, seat)} inside the horizon, or drop the item.`,
      };
    }
    const who = first.carrier === seat ? `${seatTitle(plan, seat)} is not hired` : `nobody is hired to carry ${seatTitle(plan, seat)}'s work`;
    return {
      why: `${who} until ${label(first.month)}, after the last month its run could start`,
      hint: `Hire ${seatTitle(plan, first.carrier)} earlier, with room for this item, or drop the item.`,
    };
  };

  // W101 overloaded seats.
  for (const o of overloads(s)) {
    if (o.months.length >= policy.overloadMonths || o.peak >= policy.overloadPeakFte - SLACK) {
      // Under leveling, the hint names the load leveling does not wait for on this seat.
      const left = plan.seats.find((x) => x.id === o.seat)?.unlevelled
        ? "Leveling does not wait for room on a leadership seat, only for the hire of one with no fallback on an item it owns, so its overload is reported here instead."
        : plan.levelOn === "owner"
          ? "Under levelOn owner, leveling waits for room on this seat only for items it owns and never for underway work, so underway load or work on items it does not own is what puts it over."
          : "Leveling waits for room on this seat for all but underway work, so underway load is what puts it over.";
      out.push({
        code: "W101",
        severity: "warn",
        subject: o.seat,
        message: `${seatTitle(plan, o.seat)} is over capacity in ${o.months.length} months (peak +${o.peak.toFixed(2)} FTE), first in ${label(o.months[0])}.`,
        hint: s.scenario.level
          ? `${left} Add a seat, narrow the mandate, or lower the effort assumption.`
          : "Run a leveled scenario to see what slides, or narrow this seat's portfolio.",
      });
    }
  }

  // W102 idle seats: hired after the plan starts, then under the configured share of
  // actual capacity for the configured number of months.
  for (const load of s.loads) {
    for (const h of s.hires[load.seat] ?? []) {
      if (h === 0) continue;
      let idle = 0;
      let peakShare = 0;
      for (let m = h; m < H; m++) {
        const capacity = load.capacity[m];
        const share = capacity > 0 ? load.demand[m] / capacity : load.demand[m] > 0 ? Infinity : 0;
        if (share >= policy.idleLoadShare - SLACK) break;
        idle++;
        peakShare = Math.max(peakShare, share);
      }
      if (idle >= policy.idleMonths) {
        out.push({ code: "W102", severity: "warn", subject: load.seat, message: `${seatTitle(plan, load.seat)} hired ${label(h)} peaks at ${percent(peakShare)} load for its first ${idle} months.`, hint: "Hire later, or give the seat an item that starts when it does." });
        break;
      }
    }
  }

  // W103 owner arrives long after the item starts: a person carries it meanwhile, or nobody does
  // and the load sits on the empty seat (a seat with no fallback carries its own work before it exists).
  for (const it of s.items) {
    if (it.beyond) continue;
    for (const c of it.carriers) {
      if (c.carrier === "external") continue;
      if (c.carrier === c.seat && staffedAt(c.seat, it.start)) continue;
      const hires = s.hires[c.seat] ?? [];
      if (hires.length === 0) {
        const who = staffedAt(c.carrier, it.start) ? `${seatTitle(plan, c.carrier)} carries its ${c.fte.toFixed(2)} FTE` : `nobody is hired to carry its ${c.fte.toFixed(2)} FTE: the load sits on the empty role ${seatTitle(plan, c.carrier)}`;
        out.push({ code: "W103", severity: "warn", subject: it.item.id, message: `"${it.item.label}" asks for ${seatTitle(plan, c.seat)}, which this scenario never hires; ${who}.`, hint: "Fund the seat, or accept that the carrier owns this for good." });
        continue;
      }
      let firstHire = hires[0] ?? H;
      for (let k = 1; k < hires.length; k++) firstHire = Math.min(firstHire, hires[k]);
      const wait = firstHire - it.start;
      if (wait >= policy.lateOwnerMonths) {
        const message = staffedAt(c.carrier, it.start)
          ? `"${it.item.label}" starts ${label(it.start)} but ${seatTitle(plan, c.seat)} arrives ${wait} months later; ${seatTitle(plan, c.carrier)} carries ${c.fte.toFixed(2)} FTE meanwhile.`
          : `"${it.item.label}" starts ${label(it.start)} but ${seatTitle(plan, c.seat)} arrives ${wait} months later, and nobody is hired to carry its ${c.fte.toFixed(2)} FTE: the load sits on the empty role ${seatTitle(plan, c.carrier)}.`;
        out.push({ code: "W103", severity: "warn", subject: it.item.id, message, hint: "Pull the hire forward, fund a contractor, or move the start." });
      }
    }
  }

  // W104 slips against the declared start, with the binding constraint. An item that never starts
  // because the scenario drops something upstream says so, whichever of its never-arriving
  // predecessors the binding names, rather than blaming capacity or the horizon. It names every
  // drop upstream and everything upstream that does not fit either. Whether keeping them would
  // be enough (a kept item can still overrun the horizon) takes a schedule without the drops.
  for (const it of s.items) {
    if (it.dropped) continue;
    const held = heldBy(it);
    if (held.dropped.length && it.binding.kind === "predecessor") {
      const sole = held.dropped.length === 1 && held.unfit.length === 0 ? held.dropped[0] : null;
      const direct = sole !== null && it.item.predecessors.some((p) => p.id === sole.item.id);
      const through = sole && !direct ? ` through "${byId.get(it.binding.id)!.item.label}"` : "";
      const keep = `keep ${quoted(held.dropped.map((x) => x.item.id))}${held.unfit.length ? ` and fit ${quoted(held.unfit.map((x) => x.item.id))} inside the horizon` : ""}`;
      out.push({ code: "W104", severity: "warn", subject: it.item.id, message: `"${it.item.label}" never starts: ${heldCause(held, (x) => x.item.label)}${through}.`, hint: `Drop "${it.item.id}" from the scenario as well, or ${keep}.` });
      continue;
    }
    if (it.beyond) {
      if (it.binding.kind === "hire") {
        const { why, hint } = hireTooLate(it, it.binding.seat);
        out.push({ code: "W104", severity: "warn", subject: it.item.id, message: `"${it.item.label}" does not fit inside the horizon: ${why}.`, hint });
        continue;
      }
      const why =
        it.binding.kind === "capacity"
          ? `leveling found no start with room for it; the last seat without room was ${seatTitle(plan, it.binding.carrier)}`
          : it.binding.kind === "predecessor"
            ? `"${byId.get(it.binding.id)!.item.label}" never finishes`
            : it.binding.kind === "horizon"
              ? "its run would extend past the horizon"
              : "declared start";
      out.push({ code: "W104", severity: "warn", subject: it.item.id, message: `"${it.item.label}" does not fit inside the horizon: ${why}.`, hint: "Lower the effort assumption, add a seat, or drop the item." });
      continue;
    }
    const late = it.start - it.item.earliest;
    if (late >= policy.slipMonths && it.binding.kind !== "underway") {
      if (it.binding.kind === "hire") {
        // The first hire on the seat's fallback chain, which lands at or after the start: in the
        // start month, or later when the run asks nothing of the seat in its first months.
        const seat = it.binding.seat;
        const first = firstStaffed(seat) ?? { month: it.start, carrier: it.binding.carrier };
        const role = seatTitle(plan, first.carrier);
        const why = `waits for the ${role} hire in ${label(first.month)}${first.carrier === seat ? "" : ` to carry ${seatTitle(plan, seat)}'s work`}`;
        out.push({ code: "W104", severity: "warn", subject: it.item.id, message: `"${it.item.label}" starts ${late} months after its declared ${label(it.item.earliest)}: ${why}.`, hint: `Pull the ${role} hire forward, or declare the start later.` });
        continue;
      }
      const why =
        it.binding.kind === "predecessor"
          ? `waits for "${byId.get(it.binding.id)!.item.label}"`
          : it.binding.kind === "capacity"
            ? `no room on ${seatTitle(plan, it.binding.carrier)}`
            : "declared start";
      out.push({ code: "W104", severity: "warn", subject: it.item.id, message: `"${it.item.label}" starts ${late} months after its declared ${label(it.item.earliest)}: ${why}.`, hint: "Either the date or the resourcing is wrong; pick one." });
    }
  }

  // W105 cash goes negative.
  const firstNeg = l.cash.findIndex((c) => c < -CASH_SLACK);
  if (firstNeg >= 0) {
    let trough = l.cash[firstNeg];
    for (let m = firstNeg + 1; m < l.cash.length; m++) trough = Math.min(trough, l.cash[m]);
    out.push({ code: "W105", severity: "warn", subject: s.scenario.id, message: `Cash turns negative in ${label(firstNeg)}; trough ${(trough / 1e6).toFixed(2)}M.`, hint: "Funding arrives later than the seats, or the seats arrive earlier than the funding." });
  }

  // W106 revenue rests on assumptions.
  const span = [cal.fundingYearStartMonth, cal.fundingYearStartMonth + 12 * years] as const;
  const total = sumRange(l.revenue, span[0], span[1]);
  const assumed = plan.streams
    .filter((st) => st.volumeByYear.basis === "A")
    .reduce((n, st) => n + sumRange(l.revenueByStream[st.id], span[0], span[1]), 0);
  if (total > 0 && assumed / total > policy.assumedRevenueShare + SLACK) {
    out.push({ code: "W106", severity: "info", subject: s.scenario.id, message: `${Math.round((assumed / total) * 100)}% of revenue over ${years} years rests on assumed volumes.`, hint: "Land a receipt per stream: a rate card, a signed pilot, a contract." });
  }

  // W107 first-circle items that end after funding year 1.
  const first = plan.circles[0];
  if (first) {
    for (const it of s.items) {
      if (it.item.circle === first && !it.item.standing && !it.beyond && it.end > y1End) {
        out.push({ code: "W107", severity: "info", subject: it.item.id, message: `"${it.item.label}" is in the first circle (${first}) and ends ${label(it.end - 1)}, after funding year 1.`, hint: "Fine if the first circle can land on a partial; otherwise it belongs in the next one." });
      }
    }
  }

  // W108 streams that never unlock. One keyed to a dropped item, or to an item downstream of one,
  // is still revenue the scenario loses; the hint says it was dropped rather than late.
  for (const st of plan.streams) {
    if (l.unlocks[st.id] !== null) continue;
    const it = byId.get(st.unlockedBy);
    const held = it ? heldBy(it) : { dropped: [], unfit: [] };
    const hint = it?.dropped
      ? `Its item "${st.unlockedBy}" is dropped in this scenario.`
      : held.dropped.length
        ? `Its item "${st.unlockedBy}" never starts: ${heldCause(held, (x) => x.item.id)}.`
        : `Its item "${st.unlockedBy}" does not finish by ${label(H - 1)}.`;
    out.push({ code: "W108", severity: "warn", subject: st.id, message: `Stream "${st.label}" never unlocks inside the horizon.`, hint });
  }

  // W109 portfolios too wide: a seat owning too many concurrent items.
  for (const seat of plan.seats) {
    let peak = 0;
    let peakMonth = 0;
    for (let m = 0; m < H; m++) {
      const n = s.items.filter((it) => !it.beyond && it.start <= m && m < it.end && ownerOf(it.item) === seat.id).length;
      if (n > peak) {
        peak = n;
        peakMonth = m;
      }
    }
    if (peak >= policy.wideOwnerItems) out.push({ code: "W109", severity: "warn", subject: seat.id, message: `${seat.title} owns ${peak} items at once in ${label(peakMonth)}.`, hint: "Split the mandate, add a report, or accept that these run slower than drawn." });
  }

  // W110–W112 drift against the reference model, when the plan names one.
  const ref = plan.reference;
  if (ref) {
    const n = ref.headcountByYear.length;
    const hc = atFundingYearEnd(l.headcount, cal, n);
    const complete = hc.slice(0, Math.min(years, n));
    if (complete.some((h, k) => h !== null && h !== ref.headcountByYear[k])) {
      out.push({ code: "W110", severity: "info", subject: s.scenario.id, message: `Headcount at ${complete.length} complete funding-year end${complete.length === 1 ? "" : "s"} ${complete.join("/")} against the reference ${ref.headcountByYear.slice(0, complete.length).join("/")}.`, hint: "Expected under hire-delay scenarios; a drift as planned means the roster moved." });
    }

    // The reference gross and share describe its full span, so do not compare a shorter
    // horizon with those multi-year figures.
    if (years >= n) {
      const costRef = byFundingYear(l.cost, cal, n).reduce((a, b) => a + b, 0);
      const ratio = costRef / ref.gross;
      if (ratio < 1 - policy.referenceCostTolerance - SLACK || ratio > 1 + policy.referenceCostTolerance + SLACK) {
        out.push({ code: "W111", severity: "info", subject: s.scenario.id, message: `${n}-year cost ${(costRef / 1e6).toFixed(1)}M is ${Math.round((ratio - 1) * 100)}% off the reference ${(ref.gross / 1e6).toFixed(1)}M.`, hint: "Labor is derived; the non-labor lines are the assumed part. Reconcile there first." });
      }
      const nl = byFundingYear(l.nonLabor.map((v, m) => v + l.burn[m]), cal, n).reduce((a, b) => a + b, 0);
      const share = costRef > 0 ? nl / costRef : 0;
      if (share < ref.nonLaborShare[0] - SLACK || share > ref.nonLaborShare[1] + SLACK) {
        out.push({ code: "W112", severity: "info", subject: s.scenario.id, message: `Non-labor is ${Math.round(share * 100)}% of cost over ${n} years.`, hint: ref.note });
      }
    }
  }

  // W115 internal seats spent on work in the last circle, when the plan reserves one for it.
  const last = plan.circles[plan.circles.length - 1];
  if (plan.circles.length > 1 && last) {
    let internalFte = 0;
    for (const booking of s.bookings) {
      if (booking.circle !== last || !staffedAt(booking.carrier, booking.month)) continue;
      internalFte += booking.fte;
      if (!Number.isFinite(internalFte)) throw new Error(`plangraph: non-finite internal FTE-months in circle "${last}"`);
    }
    if (internalFte > policy.lastCircleFteMonths + SLACK) {
      out.push({ code: "W115", severity: "info", subject: last, message: `${Number(internalFte.toFixed(2))} internal FTE-months go to work in the last circle (${last}).`, hint: "Fund it separately, or say plainly that the base seats carry it." });
    }
  }

  // W116 principals (in place, no fallback) carrying unfilled seats' work.
  for (const seat of plan.seats.filter((x) => x.fallback === null)) {
    let worst: { month: number; total: number; fallback: number } | null = null;
    for (let m = 0; m < Math.min(H, y1End); m++) {
      if (!staffedAt(seat.id, m)) continue; // an empty role is nobody, not a principal
      let total = 0;
      let fallback = 0;
      for (const booking of s.bookings) {
        if (booking.month !== m || booking.carrier !== seat.id) continue;
        total += booking.fte;
        if (booking.seat !== seat.id) fallback += booking.fte;
      }
      if (
        fallback > 0 &&
        total > policy.principalLoad * seat.capacityFte + SLACK &&
        (worst === null || total > worst.total + SLACK)
      ) {
        worst = { month: m, total, fallback };
      }
    }
    if (worst) {
      out.push({ code: "W116", severity: "warn", subject: seat.id, message: `${seat.title} carries ${worst.total.toFixed(2)} FTE of demand in ${label(worst.month)}; ${percent(worst.fallback / worst.total)} is fallback for unfilled seats.`, hint: "A single point of failure made visible. Shorten the searches or widen the bridge." });
    }
  }

  return out;
}

/**
 * Whether scenario `b` schedules the plan against no more room and no earlier releases than
 * scenario `a`: it levels whenever `a` does, scales effort and duration at least as much,
 * drops the same items, and keeps each hire no earlier than `a` (or drops it). A later or
 * dropped hire counts only on a role with `fallback: null`, or when the role's first hire does
 * not move: fallback is all-or-nothing, so until a role's first hire its work goes to its
 * fallback, which can have more room than the role, and "external" has no limit.
 * Funding and volume overrides do not touch the schedule and are ignored.
 */
export function tightens(plan: Plan, a: Scenario, b: Scenario): boolean {
  if (a.level && !b.level) return false;
  if ((b.effortScale ?? 1) < (a.effortScale ?? 1)) return false;
  if ((b.durationScale ?? 1) < (a.durationScale ?? 1)) return false;
  const da = new Set(a.dropItems ?? []);
  const db = new Set(b.dropItems ?? []);
  if (da.size !== db.size || [...da].some((id) => !db.has(id))) return false;
  const ha = effectiveHiring(plan, a);
  const hb = effectiveHiring(plan, b);
  for (const seat of plan.seats) {
    const at = new Map(ha[seat.id].index.map((k, j) => [k, ha[seat.id].months[j]]));
    const bt = new Map(hb[seat.id].index.map((k, j) => [k, hb[seat.id].months[j]]));
    for (const [k, m] of bt) {
      const was = at.get(k);
      if (was === undefined || m < was) return false;
    }
    if (seat.fallback !== null && Math.min(...at.values()) !== Math.min(...bt.values())) return false;
  }
  return true;
}

/**
 * The scenarios `b` tightens most closely: each one `b` tightens and schedules differently
 * from, with no other such scenario strictly between it and `b` (tightening it without being
 * tightened back). Of those, scenarios that schedule alike (the same items and bookings) count
 * once, the first listed standing for the rest. So the order of the list never changes which
 * items get a W117, only which alike scenario each names and, since alike schedules can have
 * bound for different reasons, the reason its hint gives. `scheduleOf` lets a caller that has
 * the schedules already pass them in.
 */
export function tightenedFrom(plan: Plan, scenarios: Scenario[], b: Scenario, scheduleOf: (sc: Scenario) => Schedule = (sc) => schedule(plan, sc)): Scenario[] {
  // Two scenarios schedule alike when their items and bookings match, whatever their inputs.
  const shape = (sc: Scenario) => {
    const s = scheduleOf(sc);
    return JSON.stringify([s.items.map((x) => [x.item.id, x.start, x.end, x.beyond, !!x.dropped]), s.bookings]);
  };
  const mine = shape(b);
  const looser = scenarios.filter((a) => a !== b && shape(a) !== mine && tightens(plan, a, b));
  const strictly = (x: Scenario, y: Scenario) => tightens(plan, x, y) && !tightens(plan, y, x);
  const nearest = looser.filter((a) => !looser.some((c) => c !== a && strictly(a, c)));
  const seen = new Set<string>();
  return nearest.filter((a) => {
    const k = shape(a);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * W117: an item that starts earlier, or fits inside the horizon only, in a schedule whose
 * scenario only tightens another's (see `tightens`). Leveling is a serial heuristic: work the
 * tighter scenario delays can leave room that a later item in the order takes, so a comparison
 * of the two would credit the tightening with a gain it did not make.
 */
export function lintSubstitutions(plan: Plan, s: Schedule, looser: Schedule): Finding[] {
  const out: Finding[] = [];
  const label = (m: number) => monthLabel(plan.calendar, m);
  const before = new Map(looser.items.map((x) => [x.item.id, x]));
  const rank = new Map(bookingOrder(plan).map((id, k) => [id, k]));
  /** "a", "a and b", "a, b and c". */
  const and = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  /** Months as labels, runs of consecutive months as "from to". */
  const spans = (months: number[]) => {
    const out: string[] = [];
    for (let k = 0; k < months.length; k++) {
      let j = k;
      while (j + 1 < months.length && months[j + 1] === months[j] + 1) j++;
      out.push(j === k ? label(months[k]) : `${label(months[k])} to ${label(months[j])}`);
      k = j;
    }
    return and(out);
  };
  for (const it of s.items) {
    const was = before.get(it.item.id)!;
    if (it.beyond || it.dropped || was.dropped || (!was.beyond && was.start <= it.start)) continue;
    const name = `"${looser.scenario.name}"`;
    const message = was.beyond
      ? `"${it.item.label}" fits inside the horizon here, from ${label(it.start)}, but not under ${name}, though this scenario only tightens that one.`
      : `"${it.item.label}" starts ${was.start - it.start} month${was.start - it.start === 1 ? "" : "s"} earlier here (${label(it.start)}) than under ${name} (${label(was.start)}), though this scenario only tightens that one.`;
    // Where the looser schedule held it: the seat that had no room. Then, over the months it
    // moved into, the seats its own demand lands on here, and, of the work booked before it (all
    // it had to fit beside when it was booked), what puts less load on them here than there, in
    // which months.
    let where = "";
    if (was.binding.kind === "capacity" || was.binding.kind === "hire") {
      const to = was.beyond ? it.end : Math.min(was.start, it.end);
      const cell = (carrier: string, month: number) => `${carrier}\u0000${month}`;
      const mine = new Set(s.bookings.filter((b) => b.item === it.item.id && b.carrier !== "external" && b.month < to).map((b) => cell(b.carrier, b.month)));
      const loadAt = (sched: Schedule) => {
        const by = new Map<string, number>();
        for (const b of sched.bookings) {
          if (b.carrier === "external" || !mine.has(cell(b.carrier, b.month)) || rank.get(b.item)! >= rank.get(it.item.id)!) continue;
          const key = `${b.item}\u0000${cell(b.carrier, b.month)}`;
          by.set(key, (by.get(key) ?? 0) + b.fte);
        }
        return by;
      };
      const here = loadAt(s);
      const less = new Map<string, { fte: number; seats: Set<string>; months: Set<number> }>();
      for (const [key, fte] of loadAt(looser)) {
        const drop = fte - (here.get(key) ?? 0);
        if (drop <= 1e-9) continue;
        const [id, carrier, month] = key.split("\u0000");
        const x = less.get(id) ?? { fte: 0, seats: new Set<string>(), months: new Set<number>() };
        x.fte += drop;
        x.seats.add(carrier);
        x.months.add(Number(month));
        less.set(id, x);
      }
      const freed = [...less].sort(([p, x], [q, y]) => y.fte - x.fte || (p < q ? -1 : 1)).slice(0, 3);
      const seats = [...new Set(freed.flatMap(([, x]) => [...x.seats]))].sort().map((c) => seatTitle(plan, c));
      const months = [...new Set(freed.flatMap(([, x]) => [...x.months]))].sort((a, b) => a - b);
      const who = and(freed.map(([id]) => `"${before.get(id)!.item.label}"`));
      where = `Under ${name} it waited for ${was.binding.kind === "hire" ? "a hire to carry" : "room on"} ${seatTitle(plan, was.binding.carrier)}${freed.length ? `; here ${who}, booked before it, put less on ${and(seats)} in ${spans(months)}` : ""}. `;
    } else if (was.binding.kind === "predecessor") {
      const p = before.get(was.binding.id)!;
      const then = was.beyond ? "does not fit inside the horizon there" : p.item.standing ? "starts earlier here" : "ends earlier here";
      where = `Under ${name} it waited for "${p.item.label}", which ${then}. `;
    }
    out.push({
      code: "W117",
      severity: "info",
      subject: it.item.id,
      message,
      hint: `${where}Leveling is a serial heuristic: work a tighter scenario delays can leave room that this item takes. Read the move as a side effect of the scenario, not a gain.`,
    });
  }
  return out;
}

export const lintAll = (plan: Plan, s: Schedule, l: Ledger): Finding[] => [...lintPlan(plan), ...lintSchedule(plan, s, l)];

export const countBy = (f: Finding[]): Record<Severity, number> => ({
  error: f.filter((x) => x.severity === "error").length,
  warn: f.filter((x) => x.severity === "warn").length,
  info: f.filter((x) => x.severity === "info").length,
});
