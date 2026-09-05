import { ALGORITHM_VERSION, PROJECTION_SCHEMA, type Portfolio, type Projection, type ResourceMonth } from './model.js';
import { PortfolioValidationError, validatePortfolio } from './parse.js';
import { canonicalStringify, contentFingerprint, byId, roundedFte, unique, compareText } from './canonical.js';
import { capacity, employed, resolve } from './resolve.js';
import { schedule } from './schedule.js';
import { economics } from './economics.js';
import { addCents } from './money.js';

/** Pure, deterministic monthly greedy projection. No I/O, timestamps, or mutation of inputs. */
export function project(portfolio: Portfolio, scenarioId: string, asOfMonth: number): Projection {
  const issues = validatePortfolio(portfolio);
  if (issues.length) throw new PortfolioValidationError(issues);
  if (!Number.isSafeInteger(asOfMonth) || asOfMonth < 0 || asOfMonth >= portfolio.calendar.horizonMonths) throw new PortfolioValidationError([{ path: '$.asOfMonth', message: 'As-of must be an integer month inside [0,horizonMonths)' }]);
  if (!portfolio.scenarios.some(scenario => scenario.id === scenarioId)) throw new PortfolioValidationError([{ path: '$.scenarioId', message: `Unknown scenario ${scenarioId}` }]);
  // Normalize unordered collections and detach every output object from caller-owned input.
  const p = JSON.parse(canonicalStringify(portfolio)) as Portfolio;
  const selected = p.scenarios.find(scenario => scenario.id === scenarioId)!;
  const resolved = resolve(p, selected, asOfMonth);
  const scheduled = schedule(resolved.work, resolved.resources, p.calendar.horizonMonths, asOfMonth);
  const financial = economics(p, resolved.resources, resolved.funding);
  const resourceMonths: ResourceMonth[] = [];
  const bookingTotals = new Map<string, Map<number, { actual: number; fixed: number; forecast: number; sources: string[] }>>();
  for (const booking of scheduled.bookings) {
    if (booking.resourceId === null) continue;
    if (!bookingTotals.has(booking.resourceId)) bookingTotals.set(booking.resourceId, new Map());
    const months = bookingTotals.get(booking.resourceId)!;
    if (!months.has(booking.month)) months.set(booking.month, { actual: 0, fixed: 0, forecast: 0, sources: [] });
    const totals = months.get(booking.month)!;
    totals[booking.kind] += booking.fte; totals.sources.push(...booking.sourceIds);
  }
  const payroll = new Map<string, Map<number, number>>();
  for (const expense of financial.expenses) {
    if (expense.kind !== 'payroll' || expense.resourceId === undefined) continue;
    if (!payroll.has(expense.resourceId)) payroll.set(expense.resourceId, new Map());
    const months = payroll.get(expense.resourceId)!;
    months.set(expense.month, addCents(months.get(expense.month) ?? 0, expense.amountCents));
  }
  for (const resource of resolved.resources) for (let month = 0; month < p.calendar.horizonMonths; month++) {
    const totals = bookingTotals.get(resource.id)?.get(month);
    const actualFte = roundedFte(totals?.actual ?? 0), fixedFte = roundedFte(totals?.fixed ?? 0), forecastFte = roundedFte(totals?.forecast ?? 0);
    const bookedFte = roundedFte(actualFte + fixedFte + forecastFte), capacityFte = capacity(resource, month);
    resourceMonths.push({ resourceId: resource.id, programId: resource.programId, month, employed: employed(resource, month), capacityFte, actualFte, fixedFte, forecastFte, bookedFte, availableFte: roundedFte(Math.max(0, capacityFte - bookedFte)), costCents: payroll.get(resource.id)?.get(month) ?? 0, sourceIds: unique([...resource.sourceIds, ...(totals?.sources ?? [])]) });
  }
  return {
    schemaVersion: PROJECTION_SCHEMA, algorithmVersion: ALGORITHM_VERSION,
    fingerprint: contentFingerprint({ portfolio: p, scenarioId, asOfMonth, algorithmVersion: ALGORITHM_VERSION }),
    portfolioId: p.id, sourceRevision: p.sourceRevision, scenarioId, asOfMonth, calendar: p.calendar,
    programs: [...p.programs].sort(byId), sources: [...p.sources].sort(byId), resources: resolved.resources,
    work: scheduled.work, bookings: scheduled.bookings, resourceMonths,
    expenses: financial.expenses, coverage: financial.coverage, funding: financial.funding, months: financial.months,
    findings: [...resolved.findings, ...scheduled.findings, ...financial.findings].map(finding => ({ finding, key: canonicalStringify(finding) })).sort((a, b) => compareText(a.key, b.key)).map(row => row.finding),
    ...(p.metadata !== undefined ? { metadata: p.metadata } : {}),
  };
}
