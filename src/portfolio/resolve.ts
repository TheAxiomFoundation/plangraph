import type { Portfolio, Scenario, ResourceProjection, Work, Funding, ValidationIssue, Finding } from './model.js';
import { PortfolioValidationError } from './parse.js';
import { byId, roundedFte } from './canonical.js';

export interface Resolved { resources: ResourceProjection[]; work: Work[]; funding: Funding[]; findings: Finding[] }
export function resolve(p: Portfolio, scenario: Scenario, asOf: number): Resolved {
  const issues: ValidationIssue[] = [], findings: Finding[] = [];
  const resourceOverrides = new Map(scenario.resources?.map(value => [value.resourceId, value]));
  const resources = p.resources.map((resource, index) => {
    const override = resourceOverrides.get(resource.id);
    const historical = resource.employment === 'existing' || (resource.endMonth !== undefined && resource.endMonth <= asOf);
    if (override && resource.endMonth !== undefined && resource.endMonth <= asOf) issues.push({ path: `$.scenarios[${scenario.id}].resources[${resource.id}]`, message: 'Cannot override an already-exited resource' });
    if (override && historical && (override.remove || (override.startMonth !== undefined && override.startMonth !== resource.startMonth))) issues.push({ path: `$.scenarios[${scenario.id}].resources[${resource.id}]`, message: 'Cannot remove or move an existing or exited employee' });
    if (resource.employment === 'existing' && resource.startMonth > asOf) issues.push({ path: `$.resources[${index}].startMonth`, message: 'Existing employment cannot begin after as-of' });
    const requestedStart = override?.startMonth ?? resource.startMonth;
    if (resource.endMonth !== undefined && requestedStart >= resource.endMonth && !override?.remove) issues.push({ path: `$.scenarios[${scenario.id}].resources[${resource.id}].startMonth`, message: 'Hire date must precede the resource exit' });
    if (resource.employment === 'planned' && requestedStart < asOf && !override?.remove) findings.push({ code: 'stale-planned-hire', severity: 'warning', message: `${resource.label} remains a planned hire; original requested month ${requestedStart} is retained and availability/payroll forecast begins at as-of ${asOf}.`, resourceId: resource.id, month: asOf, sourceIds: resource.sourceIds });
    const capacityEvents = [...(resource.capacityEvents ?? [])];
    if (override?.capacityFte !== undefined) {
      // Override future productive capacity while preserving all historical evidence.
      const retained = capacityEvents.filter(event => event.fromMonth < asOf);
      retained.push({ fromMonth: asOf, capacityFte: override.capacityFte, sourceIds: resource.sourceIds });
      capacityEvents.splice(0, capacityEvents.length, ...retained);
    }
    return { ...resource, capacityEvents: capacityEvents.sort((a, b) => a.fromMonth - b.fromMonth), costEvents: [...resource.costEvents].sort((a, b) => a.fromMonth - b.fromMonth), effectiveStartMonth: resource.employment === 'planned' ? Math.max(asOf, requestedStart) : requestedStart, removed: override?.remove ?? false };
  }).sort(byId);
  const originalResources = new Map(p.resources.map(resource => [resource.id, resource]));
  for (const [index, work] of p.work.entries()) {
    const actual = work.actuals;
    if (!actual) continue;
    const path = `$.work[${index}].actuals`;
    if (actual.startMonth !== undefined && actual.startMonth >= asOf) issues.push({ path: `${path}.startMonth`, message: 'Actual start must precede as-of' });
    if (actual.completionMonth !== undefined && actual.completionMonth > asOf) issues.push({ path: `${path}.completionMonth`, message: 'Actual completion must be at or before as-of' });
    let booked = 0;
    for (const [j, booking] of (actual.bookings ?? []).entries()) {
      booked += booking.fte;
      if (booking.month >= asOf) issues.push({ path: `${path}.bookings[${j}].month`, message: 'Actual booking must precede as-of' });
      const resource = originalResources.get(booking.resourceId)!;
      if (resource.employment !== 'existing' || booking.month < resource.startMonth || booking.month >= (resource.endMonth ?? Infinity)) issues.push({ path: `${path}.bookings[${j}]`, message: 'Actual booking must be inside recorded existing employment' });
      if (actual.startMonth !== undefined && booking.month < actual.startMonth) issues.push({ path: `${path}.bookings[${j}].month`, message: 'Booking precedes actual start' });
      if (actual.completionMonth !== undefined && booking.month >= actual.completionMonth) issues.push({ path: `${path}.bookings[${j}].month`, message: 'Booking is at or after exclusive completion' });
    }
    if (work.mode === 'effort') {
      const remaining = roundedFte(work.effortFteMonths! - booked);
      if (remaining < -1e-8) issues.push({ path: `${path}.bookings`, message: 'Actual effort exceeds declared total effort' });
      if (actual.remainingEffort !== undefined && Math.abs(actual.remainingEffort - remaining) > 1e-8) issues.push({ path: `${path}.remainingEffort`, message: 'Remaining effort must equal total effort minus evidenced actual bookings' });
    }
  }
  const workOverrides = new Map(scenario.work?.map(value => [value.workId, value]));
  const work = p.work.map(work => {
    const override = workOverrides.get(work.id), demandMultiplier = override?.demandMultiplier ?? 1;
    const path = `$.scenarios[${scenario.id}].work[${work.id}]`;
    const scaledFte = (value: number, multiplier: number, at: string): number => {
      const result = value * multiplier;
      if (!Number.isFinite(result) || Math.abs(result) > Number.MAX_SAFE_INTEGER) { issues.push({ path: `${path}.${at}`, message: 'Scenario scaling exceeds the finite safe FTE range' }); return 0; }
      return roundedFte(result);
    };
    if (work.actuals && override?.include === false) issues.push({ path: `$.scenarios[${scenario.id}].work[${work.id}].include`, message: 'Cannot erase a work item with actual evidence' });
    const booked = work.actuals?.bookings?.reduce((sum, booking) => sum + booking.fte, 0) ?? 0;
    const duration = work.durationMonths === undefined ? undefined : (work.actuals?.startMonth !== undefined || (work.actuals?.bookings?.length ?? 0) > 0 || work.mode === 'fixed' ? work.durationMonths : Math.max(1, Math.round(work.durationMonths * (override?.durationMultiplier ?? 1))));
    if (duration !== undefined && !Number.isSafeInteger(duration)) issues.push({ path: `${path}.durationMultiplier`, message: 'Scenario scaling exceeds the safe integer duration range' });
    const effort = work.effortFteMonths === undefined ? undefined : scaledFte(booked + scaledFte(work.effortFteMonths - booked, override?.effortMultiplier ?? 1, 'effortMultiplier'), 1, 'effortMultiplier');
    return {
      ...work, enabled: override?.include ?? work.enabled ?? true,
      durationMonths: duration, effortFteMonths: effort,
      demands: work.demands.map(demand => ({ ...demand, eligibleResourceIds: [...demand.eligibleResourceIds].sort(), fte: scaledFte(demand.fte, demandMultiplier, 'demandMultiplier'), profile: demand.profile?.map(value => scaledFte(value, demandMultiplier, 'demandMultiplier')), components: demand.components.map(component => ({ ...component, fte: scaledFte(component.fte, demandMultiplier, 'demandMultiplier'), profile: component.profile?.map(value => scaledFte(value, demandMultiplier, 'demandMultiplier')) })).sort(byId) })).sort(byId),
    };
  }).sort(byId);
  const fundingOverrides = new Map(scenario.funding?.map(value => [value.fundingId, value]));
  const funding = p.funding.map(funding => {
    const override = fundingOverrides.get(funding.id);
    return { ...funding, enabled: override?.include ?? funding.enabled ?? true, ...(funding.kind === 'receipt' && override?.receiptMonth !== undefined ? { month: override.receiptMonth } : {}) };
  }).sort(byId);
  if (issues.length) throw new PortfolioValidationError(issues);
  return { resources, work, funding, findings };
}
export function employed(resource: ResourceProjection, month: number): boolean { return !resource.removed && month >= resource.effectiveStartMonth && month < (resource.endMonth ?? Infinity); }
export function capacity(resource: ResourceProjection, month: number): number {
  if (!employed(resource, month)) return 0;
  let amount = resource.capacityFte;
  for (const event of resource.capacityEvents ?? []) { if (event.fromMonth > month) break; amount = event.capacityFte; }
  return amount;
}
