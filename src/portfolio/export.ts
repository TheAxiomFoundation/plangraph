import type { Projection } from './model.js';

export type ExportCell = string | number | boolean | null;
export interface ProjectionTable {
  name: string;
  columns: string[];
  rows: ExportCell[][];
  /** Columns containing dollar values, for presentation only; the projection retains cents. */
  moneyColumns?: number[];
}

/** A month label at an integer boundary, including the exclusive boundary after the horizon. */
export function portfolioMonthLabel(p: Pick<Projection, 'calendar'>, month: number | null): string {
  if (month === null) return '';
  const [year, start] = p.calendar.startMonth.split('-').map(Number);
  const absolute = year * 12 + start - 1 + month;
  return `${Math.floor(absolute / 12)}-${String((absolute % 12 + 12) % 12 + 1).padStart(2, '0')}`;
}

/** All export formats consume these rows. No scheduling or financial model runs here. */
export function projectionTables(p: Projection): ProjectionTable[] {
  const label = (month: number | null) => portfolioMonthLabel(p, month);
  const source = (ids: string[]) => [...ids].sort().join('; ');
  return [
    { name: 'Projection', columns: ['Field', 'Value'], rows: [
      ['Portfolio', p.portfolioId], ['Scenario', p.scenarioId], ['As of', label(p.asOfMonth)],
      ['Fingerprint', p.fingerprint], ['Source revision', p.sourceRevision], ['Schema', p.schemaVersion],
      ['Algorithm', p.algorithmVersion], ['First month', p.calendar.startMonth], ['Horizon months', p.calendar.horizonMonths],
      ['Date convention', 'Completion and target dates are exclusive month boundaries. Source targets are not actuals.'],
      ['Money convention', 'USD. Values derive from integer-cent events; cents remain available in the JSON projection.'],
      ['Cash', p.months.every(m => m.closingCashCents === null) ? 'Unknown: opening balance or receipt assumptions are missing.' : 'Calculated only from the explicitly supplied opening balance and receipts.'],
      ['Coverage', 'Proposed and committed coverage are distinct; neither is a cash receipt.'],
      ['Forecast', 'Deterministic priority heuristic. Unscheduled work is not proof of infeasibility.'],
      ['Fixed commitments', 'Fixed bookings retain requested commitments even when capacity is missing. Shortfall FTE is not available capacity or actual work.'],
    ] },
    { name: 'Work', columns: ['ID', 'Program', 'Work', 'Mode', 'Status', 'Start', 'Forecast completion exclusive', 'Source target exclusive', 'Target missed', 'Actual start', 'Actual completion exclusive', 'Booked/requested FTE months', 'Unavailable fixed commitment FTE months', 'Remaining FTE months', 'Owner', 'Blockers', 'Source gaps', 'Related work', 'Sources'],
      rows: p.work.map(w => [w.id, w.programId, w.label, w.mode, w.status, label(w.startMonth), label(w.completionMonth), label(w.targetFinishMonth), w.targetMissed,
        label(w.actualStartMonth), label(w.actualCompletionMonth), w.allocatedEffortFteMonths, w.bookings.reduce((sum, booking) => sum + (booking.shortfallFte ?? 0), 0), w.remainingEffortFteMonths, w.owner ?? '',
        w.blockers.map(b => b.message).join('; '), source(w.sourceGapIds), source(w.relatedWorkIds), source(w.sourceIds)]) },
    { name: 'People', columns: ['ID', 'Person or planned hire', 'Home program', 'Employment evidence status', 'Original start', 'Forecast start', 'End exclusive', 'Removed', 'Productive FTE', 'Sources', 'Note'],
      rows: p.resources.map(r => [r.id, r.label, r.programId, r.employment, label(r.startMonth), label(r.effectiveStartMonth), label(r.endMonth ?? null), r.removed, r.capacityFte, source(r.sourceIds), r.note ?? '']) },
    { name: 'Resource months', columns: ['Resource', 'Home program', 'Month', 'Employed', 'Capacity FTE', 'Actual FTE', 'Fixed FTE', 'Forecast FTE', 'Booked FTE', 'Remaining capacity FTE', 'Payroll USD', 'Sources'], moneyColumns: [10],
      rows: p.resourceMonths.map(r => [r.resourceId, r.programId, label(r.month), r.employed, r.capacityFte, r.actualFte, r.fixedFte, r.forecastFte, r.bookedFte, r.availableFte, r.costCents / 100, source(r.sourceIds)]) },
    { name: 'Bookings', columns: ['Work', 'Demand', 'Resource', 'Month', 'FTE', 'Fixed commitment shortfall FTE', 'Kind', 'Source components', 'Sources'],
      rows: p.bookings.map(b => [b.workId, b.demandId, b.resourceId, label(b.month), b.fte, b.shortfallFte ?? 0, b.kind, b.components.map(c => `${c.id} [${c.basis}]`).join('; '), source(b.sourceIds)]) },
    { name: 'Demand assumptions', columns: ['Work', 'Demand', 'Eligible resources', 'Demand FTE', 'Monthly profile', 'Component', 'Component FTE', 'Component profile', 'Basis', 'Sources'],
      rows: p.work.flatMap(w => w.demands.flatMap(d => d.components.map(c => [w.id, d.id, source(d.eligibleResourceIds), d.fte, d.profile?.join('; ') ?? '', c.id, c.fte, c.profile?.join('; ') ?? '', c.basis, source(c.sourceIds)]))) },
    { name: 'Monthly costs', columns: ['Month', 'Total expense USD', 'Payroll USD', 'Other costs USD', 'Proposed coverage USD', 'Committed coverage USD', 'Uncovered USD', 'Cash receipts USD', 'Closing cash USD'], moneyColumns: [1, 2, 3, 4, 5, 6, 7, 8],
      rows: p.months.map(m => [label(m.month), m.expenseCents / 100, m.payrollCents / 100, m.otherCostCents / 100, m.proposedCoverageCents / 100, m.committedCoverageCents / 100, m.uncoveredCents / 100, m.receiptCents / 100, m.closingCashCents === null ? null : m.closingCashCents / 100]) },
    { name: 'Expenses', columns: ['Entry ID', 'Kind', 'Home program', 'Month', 'Amount USD', 'Resource', 'Cost', 'Sources'], moneyColumns: [4],
      rows: p.expenses.map(e => [e.id, e.kind, e.programId, label(e.month), e.amountCents / 100, e.resourceId ?? '', e.costId ?? '', source(e.sourceIds)]) },
    { name: 'Coverage', columns: ['Funding', 'Expense', 'Month', 'Amount USD', 'Status', 'Sources'], moneyColumns: [3],
      rows: p.coverage.map(c => [c.fundingId, c.expenseId, label(c.month), c.amountCents / 100, c.status, source(c.sourceIds)]) },
    { name: 'Funding', columns: ['ID', 'Kind', 'Status', 'Requested USD', 'Applied USD', 'Excess USD', 'Sources'], moneyColumns: [3, 4, 5],
      rows: p.funding.map(f => [f.id, f.kind, f.status ?? '', f.requestedCents / 100, f.appliedCents / 100, f.excessCents / 100, source(f.sourceIds)]) },
    { name: 'Findings', columns: ['Code', 'Severity', 'Message', 'Work', 'Resource', 'Funding', 'Month', 'Related IDs', 'Sources'],
      rows: p.findings.map(f => [f.code, f.severity, f.message, f.workId ?? '', f.resourceId ?? '', f.fundingId ?? '', label(f.month ?? null), source(f.relatedIds ?? []), source(f.sourceIds)]) },
    { name: 'Sources', columns: ['ID', 'Source', 'URL', 'Basis', 'Note'], rows: p.sources.map(s => [s.id, s.label, s.url ?? '', s.basis ?? '', s.note ?? '']) },
    { name: 'Programs', columns: ['ID', 'Program', 'Financial completeness', 'Note'], rows: p.programs.map(g => [g.id, g.label, g.financialCompleteness, g.note ?? '']) },
  ];
}

/** Quote every cell; neutralize spreadsheet formulas in strings, without altering numeric negatives. */
export function csvCell(value: ExportCell): string {
  let text = value === null ? '' : String(value);
  if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function projectionCsv(p: Projection, tableName = 'Work'): string {
  const table = projectionTables(p).find(t => t.name === tableName);
  if (!table) throw new Error(`Unknown projection table ${JSON.stringify(tableName)}`);
  const header = ['Projection fingerprint', 'Scenario', 'As of', ...table.columns];
  const rows = table.rows.map(row => [p.fingerprint, p.scenarioId, portfolioMonthLabel(p, p.asOfMonth), ...row]);
  return [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
