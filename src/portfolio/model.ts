/** Monthly intervals are [startMonth,endMonth); amounts are safe integer USD cents. */
export const PORTFOLIO_SCHEMA = 'plangraph-portfolio/v1' as const;
export const PROJECTION_SCHEMA = 'plangraph-projection/v1' as const;
export const ALGORITHM_VERSION = 'monthly-greedy/1' as const;
export interface Source { id: string; label: string; url?: string; basis?: string; note?: string }
export interface Program { id: string; label: string; financialCompleteness: 'complete' | 'partial' | 'unknown'; note?: string }
export interface CapacityEvent { fromMonth: number; capacityFte: number; sourceIds: string[] }
export interface CostEvent { fromMonth: number; monthlyCents: number; sourceIds: string[] }
export interface Resource {
  id: string; label: string; programId: string; employment: 'existing' | 'planned';
  startMonth: number; endMonth?: number; capacityFte: number; capacityEvents?: CapacityEvent[];
  costEvents: CostEvent[]; skills?: string[]; sourceIds: string[]; note?: string;
}
export interface Pool { id: string; label: string; resourceIds: string[]; sourceIds: string[] }
export interface DemandComponent { id: string; fte: number; profile?: number[]; basis: string; sourceIds: string[]; label?: string }
/** Profile is monthly FTE relative to execution start; its final value repeats. */
export interface Demand { id: string; eligibleResourceIds: string[]; requiredSkills?: string[]; fte: number; profile?: number[]; components: DemandComponent[]; sourceIds: string[] }
export interface Dependency { workId: string; on?: 'start' | 'finish' }
export interface ActualBooking { resourceId: string; demandId?: string; month: number; fte: number; sourceIds: string[] }
export interface Actuals { startMonth?: number; completionMonth?: number; bookings?: ActualBooking[]; remainingEffort?: number; sourceIds: string[] }
/** Smaller integer priorities run first. Metadata is retained, but has no computational meaning. */
export interface Work {
  id: string; label: string; programId: string; mode: 'fixed' | 'duration' | 'effort' | 'ongoing' | 'milestone';
  earliestStartMonth: number; durationMonths?: number; fixedStartMonth?: number;
  targetFinishMonth?: number; dependencies: Dependency[]; priority: number; demands: Demand[];
  effortFteMonths?: number; minStaffingFte?: number; maxStaffingFte?: number;
  /** Ongoing work with a fixed start retains future reservations and exposes shortages. */
  fixed?: boolean; enabled?: boolean; owner?: string; unresolvedReason?: string;
  actuals?: Actuals; sourceIds: string[]; relatedWorkIds?: string[]; metadata?: Record<string, unknown>;
}
export interface Cost {
  id: string; label: string; programId: string; startMonth: number; endMonth: number;
  kind: 'recurring' | 'fixed-total'; monthlyCents?: number; totalCents?: number;
  /** Recurring per-person cost: price each active listed resource, independent of productive FTE. */
  resourceIds?: string[]; costEvents?: CostEvent[]; sourceIds: string[];
}
interface FundingBase { id: string; label: string; sourceIds: string[]; enabled?: boolean; note?: string }
export interface Coverage extends FundingBase {
  kind: 'coverage'; status: 'proposed' | 'committed'; startMonth: number; endMonth: number;
  targetResourceIds?: string[]; targetCostIds?: string[];
  /** Exactly one of a fixed window amount or an exact decimal share of eligible expenses. */
  amountCents?: number; share?: string;
}
export interface Commitment extends FundingBase { kind: 'commitment'; amountCents: number; month?: number }
export interface Receipt extends FundingBase { kind: 'receipt'; amountCents: number; month: number }
export interface Quote extends FundingBase { kind: 'quote'; amountCents: number; note: string }
export type Funding = Coverage | Commitment | Receipt | Quote;
export interface Scenario {
  id: string; label: string; description?: string;
  resources?: { resourceId: string; startMonth?: number; remove?: boolean; capacityFte?: number }[];
  work?: { workId: string; include?: boolean; effortMultiplier?: number; demandMultiplier?: number; durationMultiplier?: number }[];
  funding?: { fundingId: string; include?: boolean; receiptMonth?: number }[];
}
export interface Portfolio {
  schemaVersion: typeof PORTFOLIO_SCHEMA; id: string; label: string; sourceRevision: string;
  calendar: { startMonth: string; horizonMonths: number };
  sources: Source[]; programs: Program[]; resources: Resource[]; pools: Pool[]; work: Work[];
  costs: Cost[]; funding: Funding[]; scenarios: Scenario[];
  /** Missing opening balance or receiptsKnown !== true means cash is unknown. */
  cash?: { openingBalanceCents?: number; receiptsKnown: boolean };
  metadata?: Record<string, unknown>;
}
export interface ValidationIssue { path: string; message: string }
export interface Finding {
  code: string; severity: 'info' | 'warning' | 'error'; message: string;
  workId?: string; resourceId?: string; fundingId?: string; month?: number;
  sourceIds: string[]; relatedIds?: string[];
}
export interface Blocker {
  code: 'source-gap' | 'dependency' | 'capacity' | 'actuals' | 'horizon' | 'earliest' | 'fixed';
  message: string; workIds?: string[]; resourceIds?: string[]; months?: number[]; sourceIds: string[];
}
export interface Booking {
  workId: string; demandId: string; resourceId: string; month: number; fte: number;
  /** Fixed bookings retain requested commitments, including explicit capacity shortfalls. */
  kind: 'actual' | 'fixed' | 'forecast'; sourceIds: string[]; components: DemandComponent[];
  /** Portion of this fixed commitment that has no available productive capacity. Never actual work. */
  shortfallFte?: number;
}
export interface WorkProjection {
  id: string; label: string; programId: string; mode: Work['mode'];
  status: 'actual-complete' | 'scheduled' | 'partial' | 'ongoing' | 'unresolved' | 'unscheduled' | 'excluded';
  startMonth: number | null; completionMonth: number | null; targetFinishMonth: number | null;
  targetMissed: boolean; actualStartMonth: number | null; actualCompletionMonth: number | null;
  /** Sum of emitted bookings, including retained fixed requests; shortfallFte separates unavailable commitments. */
  allocatedEffortFteMonths: number; remainingEffortFteMonths: number | null;
  blockers: Blocker[]; sourceGapIds: string[]; sourceIds: string[]; relatedWorkIds: string[];
  bookings: Booking[]; demands: Demand[]; owner?: string; metadata?: Record<string, unknown>;
}
export interface ResourceMonth {
  resourceId: string; programId: string; month: number; employed: boolean; capacityFte: number;
  actualFte: number; fixedFte: number; forecastFte: number; bookedFte: number; availableFte: number;
  costCents: number; sourceIds: string[];
}
export interface ResourceProjection extends Resource { effectiveStartMonth: number; removed: boolean }
export interface Expense {
  id: string; kind: 'payroll' | 'cost'; programId: string; month: number; amountCents: number;
  resourceId?: string; costId?: string; sourceIds: string[];
}
export interface CoverageAllocation { fundingId: string; expenseId: string; month: number; amountCents: number; status: Coverage['status']; sourceIds: string[] }
export interface FundingProjection { id: string; kind: Funding['kind']; status?: Coverage['status']; requestedCents: number; appliedCents: number; excessCents: number; sourceIds: string[] }
export interface MonthEconomics {
  month: number; expenseCents: number; payrollCents: number; otherCostCents: number;
  proposedCoverageCents: number; committedCoverageCents: number; uncoveredCents: number;
  receiptCents: number; closingCashCents: number | null;
}
export interface Projection {
  schemaVersion: typeof PROJECTION_SCHEMA; algorithmVersion: typeof ALGORITHM_VERSION; fingerprint: string;
  portfolioId: string; sourceRevision: string; scenarioId: string; asOfMonth: number;
  calendar: Portfolio['calendar']; programs: Program[]; sources: Source[];
  resources: ResourceProjection[]; work: WorkProjection[]; bookings: Booking[]; resourceMonths: ResourceMonth[];
  expenses: Expense[]; coverage: CoverageAllocation[]; funding: FundingProjection[]; months: MonthEconomics[];
  findings: Finding[]; metadata?: Record<string, unknown>;
}
