import type { Portfolio, ResourceProjection, Funding, Expense, FundingProjection, CoverageAllocation, Finding, MonthEconomics, CostEvent } from './model.js';
import { unique, compareText } from './canonical.js';
import { addCents, decimalShareCents, halfUp } from './money.js';
import { employed } from './resolve.js';

export interface EconomicsResult { expenses: Expense[]; coverage: CoverageAllocation[]; funding: FundingProjection[]; months: MonthEconomics[]; findings: Finding[] }
export function effectiveCost(events: CostEvent[], month: number): CostEvent | undefined {
  let selected: CostEvent | undefined;
  for (const event of events) if (event.fromMonth <= month && (!selected || event.fromMonth > selected.fromMonth)) selected = event;
  return selected;
}
/** Payroll is employment-based, independent of whether any work is assigned. */
export function economics(p: Portfolio, resources: ResourceProjection[], fundingLines: Funding[]): EconomicsResult {
  const horizon = p.calendar.horizonMonths, expenses: Expense[] = [], findings: Finding[] = [];
  const resourceById = new Map(resources.map(resource => [resource.id, resource]));
  for (const resource of resources) {
    const missingMonths: number[] = [];
    for (let month = 0; month < horizon; month++) {
      if (!employed(resource, month)) continue;
      const event = effectiveCost(resource.costEvents, month);
      if (!event) { missingMonths.push(month); continue; }
      expenses.push({ id: `payroll:${JSON.stringify([resource.id, month])}`, kind: 'payroll', resourceId: resource.id, programId: resource.programId, month, amountCents: event.monthlyCents, sourceIds: unique([...resource.sourceIds, ...event.sourceIds]) });
    }
    if (missingMonths.length) findings.push({ code: 'missing-resource-cost', severity: 'warning', message: `${resource.label} has no cost assumption for active months ${missingMonths.join(', ')}; these missing prices are not certified zero costs.`, resourceId: resource.id, sourceIds: resource.sourceIds });
  }
  for (const cost of [...p.costs].sort((a, b) => compareText(a.id, b.id))) {
    for (let month = Math.max(0, cost.startMonth); month < Math.min(horizon, cost.endMonth); month++) {
      const event = effectiveCost(cost.costEvents ?? [], month);
      // Calculate original cumulative boundaries without allocating a potentially huge past window.
      const offset = BigInt(month) - BigInt(cost.startMonth), window = BigInt(cost.endMonth) - BigInt(cost.startMonth);
      const amountCents = cost.kind === 'fixed-total' ? halfUp(BigInt(cost.totalCents!) * (offset + 1n), window) - halfUp(BigInt(cost.totalCents!) * offset, window) : event?.monthlyCents ?? cost.monthlyCents;
      if (amountCents === undefined) { findings.push({ code: 'missing-cost-rate', severity: 'warning', message: `${cost.label} has no recurring rate in month ${month}.`, month, sourceIds: cost.sourceIds }); continue; }
      const ids: (string | undefined)[] = cost.resourceIds === undefined ? [undefined] : [...cost.resourceIds].sort().filter(id => employed(resourceById.get(id)!, month));
      for (const resourceId of ids) expenses.push({ id: `cost:${JSON.stringify([cost.id, resourceId ?? null, month])}`, kind: 'cost', costId: cost.id, ...(resourceId !== undefined ? { resourceId } : {}), programId: cost.programId, month, amountCents, sourceIds: unique([...cost.sourceIds, ...(event?.sourceIds ?? []), ...(resourceId ? resourceById.get(resourceId)!.sourceIds : [])]) });
    }
  }
  expenses.sort((a, b) => a.month - b.month || compareText(a.id, b.id));
  const coverage: CoverageAllocation[] = [], funding: FundingProjection[] = [];
  const available = new Map(expenses.map(expense => [expense.id, expense.amountCents]));
  const lines = fundingLines.filter(line => line.enabled !== false).sort((a, b) => {
    const rank = (line: Funding) => line.kind === 'coverage' && line.status === 'committed' ? 0 : line.kind === 'coverage' ? 1 : 2;
    return rank(a) - rank(b) || compareText(a.id, b.id);
  });
  for (const line of lines) {
    if (line.kind !== 'coverage') { funding.push({ id: line.id, kind: line.kind, requestedCents: line.amountCents, appliedCents: line.kind === 'receipt' && line.month >= 0 && line.month < horizon ? line.amountCents : 0, excessCents: 0, sourceIds: line.sourceIds }); continue; }
    const resourceIds = new Set(line.targetResourceIds ?? []), costIds = new Set(line.targetCostIds ?? []);
    const eligible = expenses.filter(expense => expense.month >= line.startMonth && expense.month < line.endMonth && ((expense.kind === 'payroll' && expense.resourceId !== undefined && resourceIds.has(expense.resourceId)) || (expense.costId !== undefined && costIds.has(expense.costId))));
    let remaining = line.amountCents ?? 0, requested = line.amountCents ?? 0, applied = 0;
    for (const expense of eligible) {
      const desired = line.share !== undefined ? decimalShareCents(expense.amountCents, line.share) : Math.min(expense.amountCents, remaining);
      if (line.share !== undefined) requested = addCents(requested, desired);
      const amount = Math.min(available.get(expense.id)!, desired);
      if (line.share === undefined) remaining -= amount;
      if (!amount) continue;
      available.set(expense.id, available.get(expense.id)! - amount); applied = addCents(applied, amount);
      coverage.push({ fundingId: line.id, expenseId: expense.id, month: expense.month, amountCents: amount, status: line.status, sourceIds: unique([...line.sourceIds, ...expense.sourceIds]) });
    }
    const excess = requested - applied;
    funding.push({ id: line.id, kind: line.kind, status: line.status, requestedCents: requested, appliedCents: applied, excessCents: excess, sourceIds: line.sourceIds });
    if (excess) findings.push({ code: 'overcoverage', severity: 'warning', message: `${line.label}: ${excess} cents cannot cover its eligible, uncovered costs in this horizon; the amount is not transferred to unrelated costs.`, fundingId: line.id, sourceIds: line.sourceIds });
  }
  const months: MonthEconomics[] = [];
  const payrollByMonth = Array<number>(horizon).fill(0), costByMonth = Array<number>(horizon).fill(0), proposedByMonth = Array<number>(horizon).fill(0), committedByMonth = Array<number>(horizon).fill(0), receiptsByMonth = Array<number>(horizon).fill(0);
  for (const expense of expenses) { const amounts = expense.kind === 'payroll' ? payrollByMonth : costByMonth; amounts[expense.month] = addCents(amounts[expense.month], expense.amountCents); }
  for (const row of coverage) { const amounts = row.status === 'proposed' ? proposedByMonth : committedByMonth; amounts[row.month] = addCents(amounts[row.month], row.amountCents); }
  for (const line of lines) if (line.kind === 'receipt' && line.month >= 0 && line.month < horizon) receiptsByMonth[line.month] = addCents(receiptsByMonth[line.month], line.amountCents);
  let cash: number | null = p.cash?.openingBalanceCents !== undefined && p.cash.receiptsKnown ? p.cash.openingBalanceCents : null;
  for (let month = 0; month < horizon; month++) {
    const payrollCents = payrollByMonth[month], otherCostCents = costByMonth[month];
    const expenseCents = addCents(payrollCents, otherCostCents);
    const proposedCoverageCents = proposedByMonth[month], committedCoverageCents = committedByMonth[month], receiptCents = receiptsByMonth[month];
    if (cash !== null) cash = addCents(cash, receiptCents, -expenseCents);
    months.push({ month, expenseCents, payrollCents, otherCostCents, proposedCoverageCents, committedCoverageCents, uncoveredCents: expenseCents - proposedCoverageCents - committedCoverageCents, receiptCents, closingCashCents: cash });
  }
  if (cash === null) findings.push({ code: 'cash-unknown', severity: 'info', message: 'Cash is unknown: an explicit opening balance and complete receipt assumptions are both required. Coverage, commitments and quotes are not cash receipts.', sourceIds: [] });
  return { expenses, coverage, funding: funding.sort((a, b) => compareText(a.id, b.id)), months, findings };
}
