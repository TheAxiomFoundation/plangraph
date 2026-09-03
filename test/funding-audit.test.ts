import { describe, expect, it } from "vitest";
import {
  AS_PLANNED,
  afterFundingYears,
  atFundingYearEnd,
  beforeFunding,
  byFundingYear,
  fundingYears,
  ledger,
  monthlyLoaded,
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
