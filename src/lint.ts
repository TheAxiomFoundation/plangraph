// The harness: checks over a plan, its schedule and its ledger that fire while the graph is
// being built. Errors mean the graph is not a plan yet. Warnings mean it is a plan that does
// not make sense somewhere. Info is a fact worth knowing. Each finding names its subject and
// says what to do, so an agent editing nodes gets the same feedback a reviewer would give.

import { atFundingYearEnd, byFundingYear, fundingYears, sumRange, type Ledger } from "./economics.js";
import { monthLabel, type Plan, type SeatId } from "./model.js";
import { overloads, type Schedule } from "./schedule.js";

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
  const out: Finding[] = [];
  const cal = plan.calendar;
  const H = cal.horizonMonths;
  const label = (m: number) => monthLabel(cal, m);
  const byId = new Map(s.items.map((x) => [x.item.id, x]));
  const years = fundingYears(cal);
  const y1End = cal.fundingYearStartMonth + 12;

  // W101 overloaded seats.
  for (const o of overloads(s)) {
    if (o.months.length >= 3) {
      out.push({
        code: "W101",
        severity: "warn",
        subject: o.seat,
        message: `${seatTitle(plan, o.seat)} is over capacity in ${o.months.length} months (peak +${o.peak.toFixed(2)} FTE), first in ${label(o.months[0])}.`,
        hint: s.scenario.level
          ? "Leveling already moved what it could; the remainder is underway or fallback load. Add a seat, narrow the mandate, or lower the effort assumption."
          : "Run a leveled scenario to see what slides, or narrow this seat's portfolio.",
      });
    }
  }

  // W102 idle seats: hired after the plan starts, then under 10% load for three months.
  for (const load of s.loads) {
    for (const h of s.hires[load.seat]) {
      if (h === 0) continue;
      let idle = 0;
      for (let m = h; m < Math.min(h + 12, H); m++) {
        if (load.demand[m] < 0.1 * Math.max(1, load.capacity[m])) idle++;
        else break;
      }
      if (idle >= 3) {
        out.push({ code: "W102", severity: "warn", subject: load.seat, message: `${seatTitle(plan, load.seat)} hired ${label(h)} carries under 10% load for its first ${idle} months.`, hint: "Hire later, or give the seat an item that starts when it does." });
        break;
      }
    }
  }

  // W103 owner arrives long after the item starts, and a person carries it.
  for (const it of s.items) {
    if (it.beyond) continue;
    for (const c of it.carriers) {
      if (c.carrier !== c.seat && c.carrier !== "external") {
        const hires = s.hires[c.seat] ?? [];
        let firstHire = hires[0] ?? H;
        for (let k = 1; k < hires.length; k++) firstHire = Math.min(firstHire, hires[k]);
        const wait = firstHire - it.start;
        if (wait >= 6) {
          out.push({ code: "W103", severity: "warn", subject: it.item.id, message: `"${it.item.label}" starts ${label(it.start)} but ${seatTitle(plan, c.seat)} arrives ${wait} months later; ${seatTitle(plan, c.carrier)} carries ${c.fte.toFixed(2)} FTE meanwhile.`, hint: "Pull the hire forward, fund a contractor, or move the start." });
        }
      }
    }
  }

  // W104 slips against the declared start, with the binding constraint.
  for (const it of s.items) {
    if (it.beyond) {
      const why =
        it.binding.kind === "capacity"
          ? `no room on ${seatTitle(plan, it.binding.carrier)} inside the horizon`
          : it.binding.kind === "predecessor"
            ? `"${byId.get(it.binding.id)!.item.label}" never finishes`
            : "declared start";
      out.push({ code: "W104", severity: "warn", subject: it.item.id, message: `"${it.item.label}" does not fit inside the horizon: ${why}.`, hint: "Lower the effort assumption, add a seat, or drop the item." });
      continue;
    }
    const late = it.start - it.item.earliest;
    if (late >= 3 && it.binding.kind !== "underway") {
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
  const firstNeg = l.cash.findIndex((c) => c < 0);
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
  if (total > 0 && assumed / total > 0.8) {
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

  // W108 streams that never unlock.
  for (const st of plan.streams) {
    if (l.unlocks[st.id] === null) out.push({ code: "W108", severity: "warn", subject: st.id, message: `Stream "${st.label}" never unlocks inside the horizon.`, hint: `Its item "${st.unlockedBy}" does not finish by ${label(H - 1)}.` });
  }

  // W109 portfolios too wide: a seat owning four or more concurrent items. The owner is the
  // first demand on an item.
  for (const seat of plan.seats) {
    let peak = 0;
    let peakMonth = 0;
    for (let m = 0; m < H; m++) {
      const n = s.items.filter((it) => !it.beyond && it.start <= m && m < it.end && it.item.demands[0]?.seat === seat.id).length;
      if (n > peak) {
        peak = n;
        peakMonth = m;
      }
    }
    if (peak >= 4) out.push({ code: "W109", severity: "warn", subject: seat.id, message: `${seat.title} owns ${peak} items at once in ${label(peakMonth)}.`, hint: "Split the mandate, add a report, or accept that these run slower than drawn." });
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
      if (ratio < 0.85 || ratio > 1.15) {
        out.push({ code: "W111", severity: "info", subject: s.scenario.id, message: `${n}-year cost ${(costRef / 1e6).toFixed(1)}M is ${Math.round((ratio - 1) * 100)}% off the reference ${(ref.gross / 1e6).toFixed(1)}M.`, hint: "Labor is derived; the non-labor lines are the assumed part. Reconcile there first." });
      }
      const nl = byFundingYear(l.nonLabor.map((v, m) => v + l.burn[m]), cal, n).reduce((a, b) => a + b, 0);
      const share = costRef > 0 ? nl / costRef : 0;
      if (share < ref.nonLaborShare[0] || share > ref.nonLaborShare[1]) {
        out.push({ code: "W112", severity: "info", subject: s.scenario.id, message: `Non-labor is ${Math.round(share * 100)}% of cost over ${n} years.`, hint: ref.note });
      }
    }
  }

  // W115 seats spent on work outside the last circle, when the plan reserves one for it.
  const last = plan.circles[plan.circles.length - 1];
  if (plan.circles.length > 1 && last) {
    let outsideFte = 0;
    for (const it of s.items) {
      if (it.item.circle !== last || it.beyond) continue;
      for (const c of it.carriers) outsideFte += c.fte * (it.end - it.start);
    }
    if (outsideFte > 12) {
      out.push({ code: "W115", severity: "info", subject: last, message: `${Math.round(outsideFte)} FTE-months of seats go to work in the last circle (${last}).`, hint: "Fund it separately, or say plainly that the base seats carry it." });
    }
  }

  // W116 principals (in place, no fallback) carrying unfilled seats' work.
  for (const seat of plan.seats.filter((x) => x.fallback === null)) {
    const load = s.loads.find((x) => x.seat === seat.id);
    if (!load) continue;
    const window = load.demand.slice(0, Math.min(H, y1End));
    const worst = Math.max(0, ...window);
    if (worst > 1.5 * Math.max(1, seat.capacityFte)) {
      const m = load.demand.indexOf(worst);
      out.push({ code: "W116", severity: "warn", subject: seat.id, message: `${seat.title} carries ${worst.toFixed(2)} FTE of demand in ${label(m)}, much of it as fallback for unfilled seats.`, hint: "A single point of failure made visible. Shorten the searches or widen the bridge." });
    }
  }

  return out;
}

export const lintAll = (plan: Plan, s: Schedule, l: Ledger): Finding[] => [...lintPlan(plan), ...lintSchedule(plan, s, l)];

export const countBy = (f: Finding[]): Record<Severity, number> => ({
  error: f.filter((x) => x.severity === "error").length,
  warn: f.filter((x) => x.severity === "warn").length,
  info: f.filter((x) => x.severity === "info").length,
});
