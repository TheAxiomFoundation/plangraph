// The planning graph.
//
// A plan is a directed acyclic graph of work items over a monthly calendar. Items demand
// seats; seats exist from a hire month and cost money whether or not they are busy; items
// depend on other items; finishing an item can unlock a revenue stream; funding arrives on
// its own clock. A scenario is a set of overrides on that graph. The scheduler is a pure
// function from (plan, scenario) to a schedule, and every start it produces names the
// constraint that bound it, so "why is this late" is an output rather than an argument.
//
// Every number carries a basis: D derived from a source model, A assumed, M measured. An
// assumed number in a derived-looking place is a bug, and the harness treats it as one.

export type Basis = "D" | "A" | "M";

export interface Calendar {
  /** The calendar month of index 0. */
  startYear: number;
  startMonth: number; // 1..12
  /** How many months the plan runs. Indices run 0..horizonMonths-1. */
  horizonMonths: number;
  /** Month index where funding year 1 opens; years are counted from it. */
  fundingYearStartMonth: number;
}

export const monthIndex = (cal: Calendar, year: number, month: number): number =>
  (year - cal.startYear) * 12 + (month - cal.startMonth);

export const monthLabel = (cal: Calendar, m: number): string => {
  const abs = cal.startMonth - 1 + m;
  const year = cal.startYear + Math.floor(abs / 12);
  const month = (abs % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
};

/** Funding year of a month index: 1 for the first twelve months from the funding start. */
export const fundingYear = (cal: Calendar, m: number): number =>
  Math.floor((m - cal.fundingYearStartMonth) / 12) + 1;

export type SeatId = string;

export interface SeatDef {
  id: SeatId;
  title: string;
  /** Fully loaded annual cost of one seat in the first funding year. */
  loadedAnnual: number;
  costBasis: Basis;
  /** Month index each seat in the role is hired. Seats in place before the plan use 0. */
  hireMonths: number[];
  /** Capacity of one seat, in FTE. */
  capacityFte: number;
  /**
   * Who carries this seat's demand before it is hired. A seat id means the load lands on that
   * person; "external" means a contractor or firm with no capacity limit modeled; null means
   * nobody, which the schedule shows as load on an empty seat.
   */
  fallback: SeatId | "external" | null;
}

export interface Demand {
  seat: SeatId;
  /** FTE per month while the item runs. */
  fte: number;
  basis: Basis;
}

export interface Predecessor {
  id: string;
  /** Months after the predecessor ends before this may start. Default 0. */
  lag?: number;
}

export type Circle = string;

export interface WorkItem {
  id: string;
  lane: string;
  label: string;
  /** Priority group; the plan lists circles in booking order. */
  circle: Circle;
  /** Declared earliest start, month index. For items underway this is the actual start. */
  earliest: number;
  /** Months the item runs. Ignored for standing items, which run to the horizon. */
  duration: number;
  standing: boolean;
  predecessors: Predecessor[];
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
  /** Annual volume in the first, second, third... year after unlock; the last value holds. */
  volumeByYear: { units: number[]; basis: Basis; note: string };
  /** Months over which the first year's volume ramps from zero. */
  rampMonths: number;
}

export interface FundingLine {
  id: string;
  label: string;
  /** Dollars by month index; shorter arrays are zero-padded. */
  byMonth: number[];
  basis: Basis;
  note: string;
  /** Whether the line counts by default; scenarios can override. */
  counted: boolean;
}

export interface NonLaborLine {
  id: string;
  label: string;
  /** Dollars by funding year; years beyond the array hold the last value. */
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

export interface Scenario {
  id: string;
  name: string;
  gist: string;
  /** Months added to every hire in the role; negative pulls forward. */
  hireDelay?: Record<SeatId, number>;
  /** Multiply every stream's volumes. */
  volumeScale?: number;
  /** Funding lines to count, by id, overriding each line's default. */
  countFunding?: Record<string, boolean>;
  /** When true, seats' capacity binds: overloaded work is pushed later in priority order. */
  level: boolean;
  /** Multiply every planned (not underway, not standing) duration. */
  durationScale?: number;
  /** Multiply every demand, to test the effort assumption. */
  effortScale?: number;
}

export interface Plan {
  name: string;
  calendar: Calendar;
  /** Circles in booking priority: the first books capacity first when leveling. */
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
  /** Scenarios carried with the plan, so a JSON file is self-contained. */
  scenarios?: Scenario[];
}

export const AS_PLANNED: Scenario = {
  id: "as-planned",
  name: "As planned",
  gist: "Dependencies and hire dates bind; capacity is reported, not enforced.",
  level: false,
};

export const LEVELED: Scenario = {
  id: "leveled",
  name: "Capacity-leveled",
  gist: "A seat cannot carry more than it has; overloaded work slides later in priority order.",
  level: true,
};

/** The scenarios to run for a plan: its own, else the two defaults. */
export const scenariosOf = (plan: Plan): Scenario[] =>
  plan.scenarios && plan.scenarios.length ? plan.scenarios : [AS_PLANNED, LEVELED];
