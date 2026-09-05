import type { Blocker, Booking, Demand, Finding, ResourceProjection, Work, WorkProjection } from './model.js';
import { byId, roundedFte, unique, compareText } from './canonical.js';
import { capacity } from './resolve.js';

const EPS = 1e-8;
const valueAt = (value: number, profile: number[] | undefined, offset: number) => profile ? profile[Math.min(Math.max(offset, 0), profile.length - 1)] : value;
const bookingOrder = (a: Booking, b: Booking) => a.month - b.month || compareText(a.resourceId, b.resourceId) || compareText(a.workId, b.workId) || compareText(a.demandId, b.demandId) || compareText(a.kind, b.kind);
interface Attempt { bookings: Booking[]; blockers: Blocker[]; ok: boolean }
export interface ScheduleResult { work: WorkProjection[]; bookings: Booking[]; findings: Finding[] }

export function schedule(workItems: Work[], resources: ResourceProjection[], horizon: number, asOf: number): ScheduleResult {
  const resourceById = new Map(resources.map(resource => [resource.id, resource]));
  const workById = new Map(workItems.map(work => [work.id, work]));
  const used = new Map(resources.map(resource => [resource.id, Array<number>(horizon).fill(0)]));
  const allBookings: Booking[] = [], findings: Finding[] = [];
  const commit = (bookings: Booking[]) => {
    for (const booking of bookings) {
      if (booking.month < 0 || booking.month >= horizon) continue;
      used.get(booking.resourceId)![booking.month] = roundedFte(used.get(booking.resourceId)![booking.month] + booking.fte);
      allBookings.push(booking);
    }
  };
  const eligible = (demand: Demand) => demand.eligibleResourceIds.filter(id => (demand.requiredSkills ?? []).every(skill => resourceById.get(id)!.skills?.includes(skill))).sort();
  const rankedDemands = (work: Work) => [...work.demands].sort((a, b) => eligible(a).length - eligible(b).length || byId(a, b));
  const attemptMonth = (work: Work, month: number, start: number, kind: Booking['kind'], scale = 1, force = false): Attempt => {
    const free = new Map(resources.map(resource => [resource.id, Math.max(0, capacity(resource, month) - used.get(resource.id)![month])]));
    const bookings: Booking[] = [], blockers: Blocker[] = [];
    for (const demand of rankedDemands(work)) {
      const ids = eligible(demand), required = roundedFte(valueAt(demand.fte, demand.profile, month - start) * scale);
      let remaining = required;
      const add = (resourceId: string, amount: number, shortfall = false) => {
        if (amount <= EPS) return;
        bookings.push({ workId: work.id, demandId: demand.id, resourceId, month, fte: roundedFte(amount), kind, ...(shortfall ? { shortfallFte: roundedFte(amount) } : {}), sourceIds: unique([...work.sourceIds, ...demand.sourceIds, ...demand.components.flatMap(component => component.sourceIds)]), components: demand.components.map(component => ({ ...component, fte: roundedFte(valueAt(component.fte, component.profile, month - start) * scale * amount / required), profile: undefined })) });
        free.set(resourceId, Math.max(0, (free.get(resourceId) ?? 0) - amount));
        remaining = roundedFte(remaining - amount);
      };
      for (const id of ids) { add(id, Math.min(remaining, free.get(id)!)); if (remaining <= EPS) break; }
      if (remaining > EPS) {
        const detail = ids.map(id => { const resource = resourceById.get(id)!; return `${id} (${resource.removed ? 'removed' : month < resource.effectiveStartMonth ? `not employed until ${resource.effectiveStartMonth}` : month >= (resource.endMonth ?? Infinity) ? `exited at ${resource.endMonth}` : `${roundedFte(free.get(id)!)} FTE available`})`; }).join(', ');
        blockers.push({ code: 'capacity', message: `${work.label}: ${demand.id} is short ${remaining} FTE in month ${month}; the greedy assignment exhausted eligible capacity: ${detail || 'no resource meets the declared eligibility/skills'}.`, resourceIds: ids.length ? ids : [...demand.eligibleResourceIds].sort(), months: [month], sourceIds: unique([...work.sourceIds, ...demand.sourceIds]) });
        // A retained commitment can exceed capacity, but its shortage remains explicit.
        if (force && ids.length) add(ids[0], remaining, true);
      }
    }
    return { bookings, blockers, ok: blockers.length === 0 };
  };
  const fresh = (work: Work): WorkProjection => ({
    id: work.id, label: work.label, programId: work.programId, mode: work.mode,
    status: 'unscheduled', startMonth: null, completionMonth: null, targetFinishMonth: work.targetFinishMonth ?? null,
    targetMissed: false, actualStartMonth: work.actuals?.startMonth ?? (work.actuals?.bookings?.length ? Math.min(...work.actuals.bookings.map(booking => booking.month)) : null), actualCompletionMonth: work.actuals?.completionMonth ?? null,
    allocatedEffortFteMonths: 0, remainingEffortFteMonths: work.mode === 'effort' ? work.effortFteMonths! : null,
    blockers: [], sourceGapIds: [], sourceIds: [...work.sourceIds], relatedWorkIds: [...(work.relatedWorkIds ?? [])], bookings: [], demands: work.demands,
    ...(work.owner !== undefined ? { owner: work.owner } : {}), ...(work.metadata !== undefined ? { metadata: work.metadata } : {}),
  });
  const rows = new Map(workItems.map(work => [work.id, fresh(work)]));
  // Facts reserve first, including facts on otherwise source-blocked work.
  for (const work of workItems) {
    const row = rows.get(work.id)!;
    const actualBookings: Booking[] = (work.actuals?.bookings ?? []).map(booking => ({ ...booking, workId: work.id, demandId: booking.demandId ?? 'actual', kind: 'actual', components: [], sourceIds: [...booking.sourceIds] }));
    commit(actualBookings); row.bookings.push(...actualBookings);
    if (row.actualCompletionMonth !== null) { row.status = 'actual-complete'; row.startMonth = row.actualStartMonth ?? row.actualCompletionMonth; row.completionMonth = row.actualCompletionMonth; if (work.mode === 'effort') row.remainingEffortFteMonths = 0; }
  }
  const successors = new Map<string, string[]>(), degree = new Map<string, number>();
  for (const work of workItems) { degree.set(work.id, work.dependencies.length); for (const dependency of work.dependencies) successors.set(dependency.workId, [...(successors.get(dependency.workId) ?? []), work.id]); }
  // Source-gap closure is independent of capacity and of the chosen scenario's dates.
  const gapDegree = new Map(degree), gapReady = workItems.filter(work => gapDegree.get(work.id) === 0).map(work => work.id).sort();
  for (let i = 0; i < gapReady.length; i++) {
    const work = workById.get(gapReady[i])!, row = rows.get(work.id)!;
    if (row.actualCompletionMonth === null) row.sourceGapIds = unique([...((work.unresolvedReason || (work.mode === 'milestone' && work.dependencies.length === 0)) ? [work.id] : []), ...work.dependencies.flatMap(dep => rows.get(dep.workId)!.sourceGapIds)]);
    for (const next of successors.get(work.id) ?? []) { const count = gapDegree.get(next)! - 1; gapDegree.set(next, count); if (count === 0) gapReady.push(next); }
  }
  const pinned = new Set<string>();
  // Reserve every future fixed window before serially placing movable work.
  for (const work of workItems) {
    const row = rows.get(work.id)!;
    if (work.enabled === false || row.actualCompletionMonth !== null || row.sourceGapIds.length) continue;
    const started = row.actualStartMonth !== null;
    const fixed = work.mode === 'fixed' || (work.mode === 'ongoing' && (work.fixed || started)) || (work.mode === 'duration' && started);
    if (!fixed) continue;
    pinned.add(work.id);
    const originalStart = row.actualStartMonth ?? work.fixedStartMonth ?? work.earliestStartMonth;
    const end = work.mode === 'ongoing' ? horizon : originalStart + work.durationMonths!;
    row.blockers.push({ code: 'fixed', message: `Retained ${started ? 'evidenced-start' : 'planning'} window [${originalStart}, ${work.mode === 'ongoing' ? 'ongoing' : end}); historical planned months are not actual bookings.`, months: [originalStart, end], sourceIds: work.sourceIds });
    if (end <= asOf) {
      row.status = 'unresolved'; row.startMonth = row.actualStartMonth;
      row.blockers.push({ code: 'actuals', message: `The original window ended at ${end}, but no actual completion is recorded by as-of ${asOf}.`, sourceIds: work.sourceIds });
      continue;
    }
    if (originalStart >= horizon) { row.blockers.push({ code: 'horizon', message: 'The fixed start is outside the projection horizon.', sourceIds: work.sourceIds }); continue; }
    row.startMonth = row.actualStartMonth ?? Math.max(originalStart, asOf);
    for (let month = Math.max(0, originalStart, asOf); month < Math.min(horizon, end); month++) {
      const attempt = attemptMonth(work, month, originalStart, 'fixed', 1, true);
      commit(attempt.bookings); row.bookings.push(...attempt.bookings); row.blockers.push(...attempt.blockers);
      for (const blocker of attempt.blockers) findings.push({ code: 'fixed-shortage', severity: 'error', message: blocker.message, workId: work.id, month, sourceIds: blocker.sourceIds, relatedIds: blocker.resourceIds });
    }
    row.status = work.mode === 'ongoing' ? 'ongoing' : end > horizon ? 'partial' : 'scheduled';
    row.completionMonth = work.mode === 'ongoing' || end > horizon ? null : end;
    if (row.blockers.some(blocker => blocker.code === 'capacity')) {
      row.status = work.mode === 'ongoing' && started ? 'ongoing' : 'unresolved';
      row.startMonth = row.actualStartMonth; row.completionMonth = null;
    }
    if (end > horizon) row.blockers.push({ code: 'horizon', message: 'The fixed work extends beyond the horizon; only its visible reservations are retained.', sourceIds: work.sourceIds });
    if (!started) findings.push({ code: 'pinned-planning-assumption', severity: 'warning', message: `${work.label} retains a pinned planning window without measured execution evidence.`, workId: work.id, sourceIds: work.sourceIds });
  }
  const ready = workItems.filter(work => degree.get(work.id) === 0);
  const processed = new Set<string>();
  const order = (a: Work, b: Work) => a.priority - b.priority || a.earliestStartMonth - b.earliestStartMonth || byId(a, b);
  while (ready.length) {
    ready.sort(order);
    const work = ready.shift()!, row = rows.get(work.id)!;
    process(work, row);
    processed.add(work.id);
    for (const next of successors.get(work.id) ?? []) { const count = degree.get(next)! - 1; degree.set(next, count); if (count === 0) ready.push(workById.get(next)!); }
  }
  function process(work: Work, row: WorkProjection): void {
    if (row.actualCompletionMonth !== null) return;
    if (work.enabled === false) { row.status = 'excluded'; return; }
    if (row.sourceGapIds.length) {
      row.status = 'unresolved'; row.startMonth = row.actualStartMonth;
      row.blockers.push({ code: 'source-gap', message: work.unresolvedReason ?? `Waiting for unresolved source claims: ${row.sourceGapIds.join(', ')}.`, workIds: row.sourceGapIds, sourceIds: unique(row.sourceGapIds.flatMap(id => workById.get(id)!.sourceIds)) });
      return;
    }
    let earliest = Math.max(asOf, work.earliestStartMonth), dependencyBoundary = -Infinity;
    const dependencyBlockers: Blocker[] = [];
    for (const dependency of work.dependencies) {
      const predecessor = rows.get(dependency.workId)!;
      const boundary = dependency.on === 'start' ? predecessor.startMonth : predecessor.completionMonth;
      if (boundary === null || !processed.has(dependency.workId)) dependencyBlockers.push({ code: 'dependency', message: `Waiting for ${dependency.on ?? 'finish'} of ${predecessor.label}${dependency.on !== 'start' && predecessor.status === 'ongoing' ? '; ongoing work has no finish' : ''}.`, workIds: [dependency.workId], sourceIds: predecessor.sourceIds });
      else { earliest = Math.max(earliest, boundary); dependencyBoundary = Math.max(dependencyBoundary, boundary); row.blockers.push({ code: 'dependency', message: `${dependency.on ?? 'Finish'} of ${predecessor.label} sets a lower bound at month ${boundary}.`, workIds: [dependency.workId], months: [boundary], sourceIds: predecessor.sourceIds }); }
    }
    if (dependencyBlockers.length) {
      row.status = 'unresolved'; row.completionMonth = null; row.startMonth = row.actualStartMonth;
      row.blockers.push(...dependencyBlockers); return;
    }
    if (pinned.has(work.id)) {
      if (row.actualStartMonth === null && (work.fixedStartMonth ?? work.earliestStartMonth) < work.earliestStartMonth) {
        row.blockers.push({ code: 'earliest', message: `The retained fixed window starts before the declared earliest month ${work.earliestStartMonth}.`, months: [work.earliestStartMonth], sourceIds: work.sourceIds });
        row.status = 'unresolved'; row.completionMonth = null; row.startMonth = null;
      }
      if (row.startMonth !== null && dependencyBoundary > row.startMonth && work.dependencies.length) {
        row.blockers.push({ code: 'dependency', message: `Retained fixed start ${row.startMonth} precedes a dependency boundary at ${dependencyBoundary}.`, workIds: work.dependencies.map(dep => dep.workId), sourceIds: work.sourceIds });
        findings.push({ code: 'fixed-dependency-conflict', severity: 'error', message: `${work.label} has a retained reservation before its dependencies permit execution.`, workId: work.id, sourceIds: work.sourceIds });
        row.status = 'unresolved'; row.completionMonth = null; row.startMonth = row.actualStartMonth;
      }
      return;
    }
    if (work.mode === 'milestone') {
      if (!work.dependencies.length) { row.status = 'unresolved'; row.blockers.push({ code: 'source-gap', message: 'Milestone has no dependency or evidenced completion to establish its forecast.', sourceIds: work.sourceIds }); row.sourceGapIds = [work.id]; return; }
      if (earliest > horizon) { row.blockers.push({ code: 'horizon', message: 'Milestone lies beyond the projection horizon.', sourceIds: work.sourceIds }); return; }
      row.startMonth = earliest; row.completionMonth = earliest; row.status = 'scheduled'; return;
    }
    if (earliest > 0) row.blockers.push({ code: 'earliest', message: `The earliest future execution month is ${earliest}, including as-of and dependencies.`, months: [earliest], sourceIds: work.sourceIds });
    if (work.mode === 'effort') { placeEffort(work, row, earliest); return; }
    const failed: Blocker[] = [];
    const duration = work.durationMonths ?? 0;
    for (let start = earliest; start < horizon; start++) {
      const end = work.mode === 'ongoing' ? horizon : start + duration;
      if (end > horizon) break;
      const trial: Booking[] = [], blockers: Blocker[] = [];
      for (let month = start; month < end; month++) { const attempt = attemptMonth(work, month, start, 'forecast'); trial.push(...attempt.bookings); blockers.push(...attempt.blockers); }
      if (blockers.length) { failed.push(...blockers); continue; }
      commit(trial); row.bookings.push(...trial); row.blockers.push(...compactBlockers(failed));
      row.startMonth = start; row.completionMonth = work.mode === 'ongoing' ? null : end; row.status = work.mode === 'ongoing' ? 'ongoing' : 'scheduled'; return;
    }
    row.blockers.push(...compactBlockers(failed));
    row.blockers.push({ code: 'horizon', message: `The monthly greedy heuristic found no complete ${work.mode === 'ongoing' ? 'ongoing window through the horizon' : `${duration}-month contiguous window`} within the horizon.`, sourceIds: work.sourceIds });
  }
  function placeEffort(work: Work, row: WorkProjection, earliest: number): void {
    const actual = row.bookings.filter(booking => booking.kind === 'actual').reduce((sum, booking) => sum + booking.fte, 0);
    let remaining = roundedFte(work.effortFteMonths! - actual);
    row.remainingEffortFteMonths = remaining;
    if (row.actualStartMonth !== null && work.actuals?.bookings === undefined && work.actuals?.remainingEffort === undefined) {
      row.status = 'unresolved'; row.startMonth = row.actualStartMonth;
      row.blockers.push({ code: 'actuals', message: 'Actual start has no explicit bookings or remaining-effort evidence; elapsed work is not inferred.', sourceIds: work.actuals!.sourceIds }); return;
    }
    if (remaining <= EPS) {
      row.status = 'unresolved'; row.startMonth = row.actualStartMonth;
      row.blockers.push({ code: 'actuals', message: 'The booked effort is exhausted but completion evidence is absent.', sourceIds: work.sourceIds }); return;
    }
    const failures: Blocker[] = [];
    for (let month = earliest; month < horizon && remaining > EPS; month++) {
      // Demand FTE values are explicit relative staffing shares for effort mode.
      const sum = work.demands.reduce((total, demand) => total + valueAt(demand.fte, demand.profile, month - earliest), 0);
      const maximum = Math.min(remaining, work.maxStaffingFte!);
      const minimum = Math.min(remaining, work.minStaffingFte!);
      if (sum <= EPS) { failures.push({ code: 'capacity', message: `No positive staffing demand is declared in month ${month}.`, months: [month], resourceIds: unique(work.demands.flatMap(demand => demand.eligibleResourceIds)), sourceIds: work.sourceIds }); continue; }
      let chosen = attemptMonth(work, month, earliest, 'forecast', maximum / sum);
      if (!chosen.ok) {
        const minAttempt = attemptMonth(work, month, earliest, 'forecast', minimum / sum);
        if (!minAttempt.ok) { failures.push(...minAttempt.blockers); continue; }
        // Fractional capacity is continuous. Find the greatest greedy-feasible staffing level.
        let low = minimum, high = maximum;
        chosen = minAttempt;
        for (let step = 0; step < 40 && high - low > 1e-9; step++) {
          const mid = (low + high) / 2, trial = attemptMonth(work, month, earliest, 'forecast', mid / sum);
          if (trial.ok) { low = mid; chosen = trial; } else high = mid;
        }
      }
      const delivered = roundedFte(chosen.bookings.reduce((total, booking) => total + booking.fte, 0));
      if (delivered <= EPS) continue;
      commit(chosen.bookings); row.bookings.push(...chosen.bookings);
      row.startMonth = row.actualStartMonth ?? row.startMonth ?? month;
      remaining = roundedFte(Math.max(0, remaining - delivered));
      if (remaining <= EPS) { row.completionMonth = month + 1; remaining = 0; }
    }
    row.remainingEffortFteMonths = remaining; row.blockers.push(...compactBlockers(failures));
    row.status = remaining === 0 ? 'scheduled' : row.bookings.length ? 'partial' : 'unscheduled';
    if (remaining > EPS) row.blockers.push({ code: 'horizon', message: `${remaining} FTE-months remain at the horizon; visible effort bookings are retained.`, resourceIds: unique(work.demands.flatMap(demand => demand.eligibleResourceIds)), sourceIds: work.sourceIds });
  }
  const result = [...rows.values()].sort(byId);
  for (const row of result) {
    row.bookings.sort(bookingOrder); row.allocatedEffortFteMonths = roundedFte(row.bookings.reduce((sum, booking) => sum + booking.fte, 0));
    row.blockers = compactBlockers(row.blockers);
    row.targetMissed = row.targetFinishMonth !== null && (row.completionMonth !== null ? row.completionMonth > row.targetFinishMonth : row.targetFinishMonth <= asOf);
    if (row.status === 'unresolved' || row.status === 'unscheduled' || row.status === 'partial') findings.push({ code: row.sourceGapIds.length ? 'source-gap' : row.status, severity: 'warning', message: `${row.label}: ${row.blockers.filter(blocker => blocker.code !== 'earliest' && blocker.code !== 'fixed').map(blocker => blocker.message).join(' ')}`, workId: row.id, sourceIds: row.sourceIds, relatedIds: row.sourceGapIds });
    if (row.targetMissed) findings.push({ code: 'target-missed', severity: 'warning', message: `${row.label} does not meet target month ${row.targetFinishMonth}.`, workId: row.id, sourceIds: row.sourceIds });
  }
  for (const resource of resources) for (let month = 0; month < horizon; month++) {
    const excess = roundedFte(used.get(resource.id)![month] - capacity(resource, month));
    if (excess > EPS) findings.push({ code: 'fixed-overload', severity: 'error', message: `${resource.label} has ${excess} FTE of retained fixed/actual load above productive capacity in month ${month}.`, resourceId: resource.id, month, sourceIds: unique(allBookings.filter(booking => booking.resourceId === resource.id && booking.month === month).flatMap(booking => booking.sourceIds)) });
  }
  return { work: result, bookings: allBookings.sort(bookingOrder), findings };
}

function compactBlockers(blockers: Blocker[]): Blocker[] {
  const seen = new Set<string>();
  return blockers.filter(blocker => { const key = JSON.stringify(blocker); if (seen.has(key)) return false; seen.add(key); return true; });
}
