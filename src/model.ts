// The planning graph.
//
// A valid plan is a directed acyclic graph of work items over a monthly calendar. Items
// demand seats; seats exist from a hire month and cost money whether or not they are busy;
// items depend on other items; finishing an item can unlock a revenue stream; funding
// arrives on its own clock. A scenario is a set of overrides on that graph. The scheduler is
// a pure function from (plan, scenario) to a schedule, and every start it produces names one
// deterministic binding; coincident causes are not retained.
//
// Cost, demand, revenue and funding assumptions carry a basis: D derived from a source
// model, A assumed, M measured. An assumed number in a derived-looking place is a bug.
//
// Months are integers. There is no partial-month proration: a seat hired in month m is on
// payroll and at full capacity from m.

export type Basis = "D" | "A" | "M";

export interface Calendar {
  /** The calendar month of index 0. */
  startYear: number;
  startMonth: number; // 1..12
  /** How many months the plan runs. Indices run 0..horizonMonths-1. */
  horizonMonths: number;
  /** Month index where funding year 1 opens; years are counted from it. Must be inside the horizon. */
  fundingYearStartMonth: number;
}

export const monthIndex = (cal: Calendar, year: number, month: number): number =>
  (year - cal.startYear) * 12 + (month - cal.startMonth);

export const monthLabel = (cal: Calendar, m: number): string => {
  const abs = cal.startMonth - 1 + m;
  const year = cal.startYear + Math.floor(abs / 12);
  const month = ((abs % 12) + 12) % 12 + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
};

/** Funding year of a month index: 1 for the first twelve months from the funding start; 0 or less before it. */
export const fundingYear = (cal: Calendar, m: number): number =>
  Math.floor((m - cal.fundingYearStartMonth) / 12) + 1;

export type SeatId = string;

export interface SeatDef {
  id: SeatId;
  title: string;
  /** Fully loaded annual cost of one seat in the first funding year. */
  loadedAnnual: number;
  /**
   * Loaded annual cost per funding year (year 1 first; the last value holds), for sources
   * that escalate salary and then load it, so the loaded cost is not a constant multiple of
   * salary. When present it replaces loadedAnnual × (1 + escalation)^(year − 1); months
   * before the funding year opens use year 1.
   */
  loadedAnnualByYear?: number[];
  costBasis: Basis;
  /** Month index each seat in the role is hired. Seats in place before the plan use 0. */
  hireMonths: number[];
  /** Capacity of one seat, in FTE. */
  capacityFte: number;
  /**
   * Who carries this role's demand while the role has no hire at all. A seat id means the
   * load lands on that role; "external" means a contractor or firm, uncapped and uncosted
   * in this model; null means nobody, so the load shows on the empty role as an overload.
   * Fallback is all-or-nothing per role: once one seat is hired, all demand stays on the role.
   */
  fallback: SeatId | "external" | null;
  /**
   * A leadership seat: leveling never waits for room on it, because principals absorb
   * rather than slip; the overload is reported instead. Off by default.
   */
  unlevelled?: boolean;
}

export interface Demand {
  seat: SeatId;
  /** FTE per month while the item runs, when the demand is flat. */
  fte: number;
  /**
   * FTE by quarter of the item's run, first quarter first, the last value holding: a shape
   * instead of a flat rate (front-loaded design, a build, a tail). When present it replaces
   * `fte` month by month; `fte` stays as the number a summary shows.
   */
  profile?: number[];
  basis: Basis;
}

/** The FTE a demand asks for in month k of its item's run. */
export const demandAt = (d: Demand, k: number): number =>
  d.profile && d.profile.length ? d.profile[Math.min(Math.floor(Math.max(0, k) / 3), d.profile.length - 1)] : d.fte;

export interface Predecessor {
  id: string;
  /** Whole months after the predecessor ends before this may start. Default 0. */
  lag?: number;
}

export type Circle = string;

export interface WorkItem {
  id: string;
  lane: string;
  label: string;
  /** Priority group; the plan lists circles in booking order. Must be one of plan.circles. */
  circle: Circle;
  /** The accountable seat. Defaults to the first demand's seat; must be one of the demands. */
  owner?: SeatId;
  /** Declared earliest start, month index. For items underway this is the actual start. */
  earliest: number;
  /** Whole months the item runs. Ignored for standing items, which run to the horizon. */
  duration: number;
  standing: boolean;
  predecessors: Predecessor[];
  /** One demand per seat. */
  demands: Demand[];
  /** True when the item has already begun: its start is a fact, not a decision. */
  underway: boolean;
  /** Non-labor burn per month while the item runs, if any. */
  burnPerMonth?: { usd: number; basis: Basis; note: string };
}

export interface RevenueStream {
  id: string;
  label: string;
  /** The item whose completion turns the stream on; a standing item turns it on when it starts. */
  unlockedBy: string;
  unit: string;
  price: { usd: number; basis: Basis; note: string };
  /** Annual volume in the first, second, third... year after unlock; the last value holds. At least one. */
  volumeByYear: { units: number[]; basis: Basis; note: string };
  /** Whole months over which the first year's volume ramps linearly from zero. */
  rampMonths: number;
}

export interface FundingLine {
  id: string;
  label: string;
  /** Dollars by month index; shorter arrays are zero-padded, longer ones truncated. */
  byMonth: number[];
  basis: Basis;
  note: string;
  /** Whether the line counts by default; scenarios can override. */
  counted: boolean;
}

export interface NonLaborLine {
  id: string;
  label: string;
  /** Dollars by funding year; years beyond the array hold the last value. Nothing before the funding start. */
  byYear: number[];
  basis: Basis;
  note: string;
}

export interface Reference {
  /** Headcount expected at the end of each funding year, from the source model. */
  headcountByYear: number[];
  /** Gross cost the source model states over those years. */
  gross: number;
  /** Acceptable non-labor share of cost, low and high. */
  nonLaborShare: [number, number];
  note: string;
}

/** Thresholds the harness uses. Every one has a default; a plan can set its own. */
export interface LintPolicy {
  /** W101 fires when a seat is over capacity for at least this many months... */
  overloadMonths: number;
  /** ...or by at least this many FTE in any month. */
  overloadPeakFte: number;
  /** W102: months a new hire may sit below the configured load share. */
  idleMonths: number;
  /** W102: share of actual capacity below which a new hire is idle. */
  idleLoadShare: number;
  /** W103: months an item may run before its owner exists, with a person carrying it. */
  lateOwnerMonths: number;
  /** W104: months an item may start after its declared month. */
  slipMonths: number;
  /** W109: items one owner may run at once. */
  wideOwnerItems: number;
  /** W106: share of revenue on assumed volumes that is worth saying. */
  assumedRevenueShare: number;
  /** W115: FTE-months of seats in the last circle that are worth saying. */
  lastCircleFteMonths: number;
  /** W116: a principal's demand as a multiple of one seat's capacity. */
  principalLoad: number;
  /** W111: tolerated proportional difference from reference gross cost. */
  referenceCostTolerance: number;
}

export const DEFAULT_LINT: LintPolicy = {
  overloadMonths: 3,
  overloadPeakFte: 0.5,
  idleMonths: 3,
  idleLoadShare: 0.1,
  lateOwnerMonths: 6,
  slipMonths: 3,
  wideOwnerItems: 4,
  assumedRevenueShare: 0.8,
  lastCircleFteMonths: 12,
  principalLoad: 1.5,
  referenceCostTolerance: 0.15,
};

export interface Scenario {
  id: string;
  name: string;
  gist: string;
  /** Whole months added to every hire in the role; negative pulls forward. Keys are seat ids. */
  hireDelay?: Record<SeatId, number>;
  /** Roles that do not exist in this scenario: never hired, never costed; their demand lands on their fallback. */
  dropSeats?: SeatId[];
  /** Multiply every stream's volumes. Positive. */
  volumeScale?: number;
  /** Funding lines to count, by id, overriding each line's default. */
  countFunding?: Record<string, boolean>;
  /** When true, seats' capacity binds: overloaded work is pushed later in priority order. */
  level: boolean;
  /** Multiply every planned (not underway, not standing) duration. Positive. */
  durationScale?: number;
  /** Multiply every demand, to test the effort assumption. Positive. */
  effortScale?: number;
}

export interface Plan {
  name: string;
  calendar: Calendar;
  /** Circles in booking priority: the first books capacity first when leveling. Every item's circle must be listed. */
  circles: Circle[];
  /** What the plan is checked against, when a source model exists. */
  reference?: Reference;
  seats: SeatDef[];
  items: WorkItem[];
  streams: RevenueStream[];
  funding: FundingLine[];
  nonLabor: NonLaborLine[];
  /** Annual cost escalation from funding year 2. */
  escalation: { rate: number; basis: Basis };
  /** Cash on hand at month 0. Default 0. */
  openingCash?: number;
  /** Harness thresholds. Defaults apply for anything unset. */
  lint?: Partial<LintPolicy>;
  /** Scenarios carried with the plan, so a file is self-contained. */
  scenarios?: Scenario[];
}

export const AS_PLANNED: Scenario = {
  id: "as-planned",
  name: "As planned",
  gist: "Dependencies bind; unfilled seats hand their work to fallbacks; capacity is reported, not enforced.",
  level: false,
};

export const LEVELED: Scenario = {
  id: "leveled",
  name: "Capacity-leveled",
  gist: "Movable work slides later in priority order until its internal carriers fit; fixed load can still overload.",
  level: true,
};

/** The scenarios to run for a plan: its own, else the two defaults. The first is the baseline. */
export const scenariosOf = (plan: Plan): Scenario[] =>
  plan.scenarios && plan.scenarios.length ? plan.scenarios : [AS_PLANNED, LEVELED];

export const lintPolicy = (plan: Plan): LintPolicy => {
  const policy = { ...DEFAULT_LINT };
  for (const key of Object.keys(policy) as Array<keyof LintPolicy>) {
    if (!plan.lint || !Object.prototype.hasOwnProperty.call(plan.lint, key)) continue;
    const value = plan.lint?.[key];
    if (value !== undefined) policy[key] = value;
  }
  return policy;
};

/** The accountable seat of an item. */
export const ownerOf = (item: WorkItem): SeatId => item.owner ?? item.demands[0]?.seat ?? "";

/** A record with no prototype, so user ids like "__proto__" or "toString" are ordinary keys. */
export const table = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
export const has = (o: object | undefined, k: string): boolean => o !== undefined && Object.prototype.hasOwnProperty.call(o, k);
