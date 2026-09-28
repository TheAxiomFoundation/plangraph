import { describe, expect, it } from "vitest";
import {
  AS_PLANNED,
  afterFundingYears,
  atFundingYearEnd,
  beforeFunding,
  byFundingYear,
  fmtFixed,
  fmtUsd,
  fundingYears,
  ledger,
  monthlyLoaded,
  seatMonthlyCost,
  report,
  schedule,
  type Plan,
} from "../src/index";

const fixture = (over: Partial<Plan> = {}): Plan => ({
  name: "funding audit fixture",
  calendar: { startYear: 2027, startMonth: 1, horizonMonths: 36, fundingYearStartMonth: 3 },
  circles: ["core"],
  escalation: { rate: 0, basis: "A" },
  seats: [],
  items: [],
  streams: [],
  funding: [],
  nonLabor: [],
  scenarios: [AS_PLANNED],
  ...over,
});

const sum = (row: number[]) => row.reduce((total, value) => total + value, 0);

describe("defensive funding-clock audit", () => {
  it("D7 escalates loaded cost at shifted funding-year boundaries", () => {
    const plan = fixture({ escalation: { rate: 0.1, basis: "A" } });

    expect(monthlyLoaded(plan, 1_200, 14)).toBe(100);
    expect(monthlyLoaded(plan, 1_200, 15)).toBe(110);
    expect(monthlyLoaded(plan, 1_200, 27)).toBeCloseTo(121, 12);
  });

  it("uses a seat's per-year loaded cost when the source escalates salary before loading it", () => {
    const seat = { id: "x", title: "X", loadedAnnual: 1_200, loadedAnnualByYear: [1_200, 1_500], costBasis: "D" as const, hireMonths: [0], capacityFte: 1, fallback: null };
    const plan = fixture({ escalation: { rate: 0.1, basis: "A" }, seats: [seat] });
    expect(seatMonthlyCost(plan, seat, 0)).toBe(100); // before the funding year opens: year 1
    expect(seatMonthlyCost(plan, seat, 14)).toBe(100);
    expect(seatMonthlyCost(plan, seat, 15)).toBe(125); // year 2 from the schedule, not 1,200 × 1.1
    expect(seatMonthlyCost(plan, seat, 27)).toBe(125); // the last value holds
    const flat = { ...seat, loadedAnnualByYear: undefined };
    expect(seatMonthlyCost(plan, flat, 15)).toBe(110);
    const l = ledger(plan, schedule(plan, AS_PLANNED));
    expect(l.labor[15]).toBe(125);
  });

  it("A7 exposes only real funding-year endpoints", () => {
    const calendar = { startYear: 2027, startMonth: 1, horizonMonths: 15, fundingYearStartMonth: 3 };
    const row = Array.from({ length: calendar.horizonMonths }, (_, month) => month);

    expect(fundingYears(calendar)).toBe(1);
    expect(atFundingYearEnd(row, calendar, 3)).toEqual([row[14], null, null]);
  });

  it("A7 reconciles pre-funding, complete years, and trailing months in helpers and reports", () => {
    const plan = fixture({
      openingCash: 5_000,
      seats: [
        {
          id: "x",
          title: "X",
          loadedAnnual: 1_200,
          costBasis: "A",
          hireMonths: [0],
          capacityFte: 1,
          fallback: null,
        },
      ],
      items: [
        {
          id: "service",
          lane: "delivery",
          label: "Service",
          circle: "core",
          owner: "x",
          earliest: 0,
          duration: 1,
          standing: true,
          predecessors: [],
          demands: [{ seat: "x", fte: 0.1, basis: "A" }],
          underway: false,
        },
      ],
      streams: [
        {
          id: "subscriptions",
          label: "Subscriptions",
          unlockedBy: "service",
          unit: "subscription",
          price: { usd: 10, basis: "A", note: "audit fixture" },
          volumeByYear: { units: [12], basis: "A", note: "audit fixture" },
          rampMonths: 0,
        },
      ],
      funding: [
        {
          id: "grant",
          label: "Grant",
          byMonth: new Array(36).fill(25),
          basis: "A",
          note: "audit fixture",
          counted: true,
        },
      ],
    });
    const monthly = ledger(plan, schedule(plan, AS_PLANNED));
    const result = report(plan).scenarios[0];
    const rows = {
      cost: monthly.cost,
      revenue: monthly.revenue,
      funding: monthly.funding,
    };

    expect(fundingYears(plan.calendar)).toBe(2);
    expect(byFundingYear(rows.cost, plan.calendar)).toEqual([1_200, 1_200]);
    expect(byFundingYear(rows.revenue, plan.calendar)).toEqual([120, 120]);
    expect(byFundingYear(rows.funding, plan.calendar)).toEqual([300, 300]);

    for (const row of Object.values(rows)) {
      const reconciled = beforeFunding(row, plan.calendar) + sum(byFundingYear(row, plan.calendar)) + afterFundingYears(row, plan.calendar);
      expect(reconciled).toBe(sum(row));
    }

    expect(result.preFunding).toEqual({ cost: 300, revenue: 30, funding: 75 });
    expect(result.costByYear).toEqual(byFundingYear(rows.cost, plan.calendar));
    expect(result.revenueByYear).toEqual(byFundingYear(rows.revenue, plan.calendar));
    expect(result.fundingByYear).toEqual(byFundingYear(rows.funding, plan.calendar));
    expect(result.trailing).toEqual({ cost: 900, revenue: 90, funding: 225 });
    expect(result.preFunding).toEqual({
      cost: beforeFunding(rows.cost, plan.calendar),
      revenue: beforeFunding(rows.revenue, plan.calendar),
      funding: beforeFunding(rows.funding, plan.calendar),
    });
    expect(result.trailing).toEqual({
      cost: afterFundingYears(rows.cost, plan.calendar),
      revenue: afterFundingYears(rows.revenue, plan.calendar),
      funding: afterFundingYears(rows.funding, plan.calendar),
    });

    const reconciledCost = result.preFunding.cost + sum(result.costByYear) + result.trailing.cost;
    const reconciledRevenue = result.preFunding.revenue + sum(result.revenueByYear) + result.trailing.revenue;
    const reconciledFunding = result.preFunding.funding + sum(result.fundingByYear) + result.trailing.funding;
    expect(monthly.cash[monthly.cash.length - 1]).toBe(
      plan.openingCash! + reconciledFunding + reconciledRevenue - reconciledCost,
    );
  });

  it("A7 seeds the cash ledger with openingCash", () => {
    const plan = fixture({ openingCash: 1_234 });
    const monthly = ledger(plan, schedule(plan, AS_PLANNED));

    expect(monthly.cash).toHaveLength(plan.calendar.horizonMonths);
    expect(monthly.cash.every((cash) => cash === 1_234)).toBe(true);
  });
});

describe("figures for display depend on the sum, not on the order it was added in", () => {
  it("fmtFixed snaps to eight decimals, then rounds half away from zero", () => {
    // The two orders of the same 14.025 FTE-months, and a sum that lands exactly on it.
    expect([14.024999999999999, 14.025, 14.025000000000002].map((x) => fmtFixed(x, 2))).toEqual(["14.03", "14.03", "14.03"]);
    expect([14.024999999999999, 14.025000000000002].map((x) => x.toFixed(2))).toEqual(["14.02", "14.03"]);
    // Within the harness's 1e-9 slack of a half is at the half.
    expect([14.0249999993, 14.0250000007].map((x) => fmtFixed(x, 2))).toEqual(["14.03", "14.03"]);
    expect(fmtFixed(14.02499999, 2)).toBe("14.02");
    // 0.145 is stored just under itself, so toFixed shows 0.14.
    expect(fmtFixed(0.145, 2)).toBe("0.15");
    // Sums that drifted just under a half.
    expect(fmtFixed(1.2499999999999998, 1)).toBe("1.3");
    expect(fmtFixed(12.649999999999999, 1)).toBe("12.7");
    expect(fmtFixed(-1.2349999999999999, 2)).toBe("-1.24");
    // Exact halves and full precision, where toFixed already agrees.
    expect([fmtFixed(2.5, 0), fmtFixed(-2.5, 0), fmtFixed(1.5, 0), fmtFixed(0.1, 7)]).toEqual(["3", "-3", "2", "0.1000000"]);
  });

  it("fmtFixed keeps the sign of a snapped value below zero, and drops drift around zero", () => {
    // A dollar short of zero, in millions, still reads as a negative trough.
    expect(fmtFixed(-0.000001, 2)).toBe("-0.00");
    expect(fmtFixed(-1e-15, 2)).toBe("0.00");
    expect(fmtFixed(0, 2)).toBe("0.00");
    expect(fmtFixed(-0, 2)).toBe("0.00");
    expect(Number(fmtFixed(-0.3, 0))).toBe(-0);
  });

  it("fmtFixed shows what it cannot snap as toFixed does, and refuses digits it cannot round to", () => {
    expect(fmtFixed(1e21, 2)).toBe("1e+21");
    expect(fmtFixed(1e16 + 2, 0)).toBe("10000000000000002");
    expect(fmtFixed(1e10 + 0.5, 0)).toBe((1e10 + 0.5).toFixed(0));
    expect(fmtFixed(Number.NaN, 2)).toBe("NaN");
    expect(fmtFixed(Number.POSITIVE_INFINITY, 1)).toBe("Infinity");
    for (const digits of [-1, 8, 1.5, Number.NaN]) expect(() => fmtFixed(1, digits)).toThrow("plangraph: fmtFixed takes 0 to 7 digits");
  });

  it("fmtUsd rounds millions and thousands the same way, and picks the unit after rounding", () => {
    expect(fmtUsd(1_234_999.9999999998)).toBe("$1.24M");
    expect(fmtUsd(1_235_000)).toBe("$1.24M");
    expect(fmtUsd(-1_235_000)).toBe("$-1.24M");
    expect(fmtUsd(2_500)).toBe("$3k");
    expect(fmtUsd(-2_500)).toBe("$-3k");
    expect(fmtUsd(-400)).toBe("$0k");
    // A million added up a hair short, and 999,500, round to a thousand thousand.
    expect([fmtUsd(999_999.9999999999), fmtUsd(1_000_000), fmtUsd(999_500), fmtUsd(-999_500)]).toEqual(["$1.00M", "$1.00M", "$1.00M", "$-1.00M"]);
    expect(fmtUsd(999_499)).toBe("$999k");
  });

  it("names the first month of a cash trough that repeats, in every order of seats", () => {
    // A grant pays February's payroll exactly, so January and February end with the same cash;
    // added up seat by seat, February comes out a hair lower in some orders of seats.
    const seats = [165_927.72, 102_866.52, 161_847];
    const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const plans = orders.map((order) =>
      fixture({
        calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
        seats: order.map((k) => ({ id: `s${k}`, title: `s${k}`, loadedAnnual: seats[k], costBasis: "A" as const, hireMonths: [0], capacityFte: 1, fallback: null })),
        funding: [{ id: "grant", label: "grant", byMonth: [0, 35_886.77, 1_000_000], basis: "A", note: "audit fixture", counted: true }],
      }),
    );
    expect(plans.some((plan) => {
      const cash = ledger(plan, schedule(plan, AS_PLANNED)).cash;
      return cash[1] < cash[0];
    })).toBe(true);
    const troughs = plans.map((plan) => report(plan).scenarios[0].cashTrough);
    expect(new Set(troughs.map((t) => t.month))).toEqual(new Set(["2027-01"]));
    expect(new Set(troughs.map((t) => fmtFixed(t.usd / 1e6, 2)))).toEqual(new Set(["-0.04"]));
  });
});
