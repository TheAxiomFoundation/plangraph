import { describe, expect, it } from "vitest";
import { AS_PLANNED, parsePlan, report } from "../src/index";

// An empty terminal role is nobody. Load that lands on it is an overload W101 reports, not a
// person carrying work: W103, W115 and W116 must not count it as internal carriage.
const plan = () =>
  parsePlan({
    name: "empty-terminal-role",
    calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
    circles: ["core", "later"],
    escalation: { rate: 0, basis: "A" },
    seats: [
      { id: "principal", title: "Principal", loadedAnnual: 120_000, costBasis: "A", hireMonths: [4], capacityFte: 1, fallback: null },
      { id: "worker", title: "Worker", loadedAnnual: 90_000, costBasis: "A", hireMonths: [6], capacityFte: 1, fallback: "principal" },
    ],
    items: [
      { id: "bridge", lane: "l", label: "Bridge", circle: "core", earliest: 0, duration: 1, standing: false, underway: false, predecessors: [], demands: [{ seat: "worker", fte: 2, basis: "A" }] },
      { id: "later", lane: "l", label: "Later", circle: "later", earliest: 0, duration: 12, standing: false, underway: false, predecessors: [], demands: [{ seat: "principal", fte: 1.1, basis: "A" }] },
    ],
    streams: [],
    funding: [],
    nonLabor: [],
    scenarios: [AS_PLANNED],
  });

describe("carriage on an empty terminal role", () => {
  it("is not reported as a person carrying work, as internal FTE-months, or as a principal's load", () => {
    const r = report(plan());
    const findings = r.scenarios[0].findings;
    const codes = (code: string) => findings.filter((f) => f.code === code);
    // W103: the worker's bridge lands on the principal in month 0, when nobody is hired.
    const w103 = codes("W103");
    expect(w103).toHaveLength(1);
    expect(w103[0].message).toMatch(/nobody is hired/);
    expect(w103[0].message).not.toMatch(/Principal carries/);
    // W115: only months 4–11 have a hired principal: 8 × 1.1 = 8.8 FTE-months, under the policy's 12.
    expect(codes("W115")).toHaveLength(0);
    // W116: months 0–3 have no principal; once hired, no fallback load remains.
    expect(codes("W116")).toHaveLength(0);
    // The empty role's overload is still reported where it belongs.
    expect(codes("W101").some((f) => f.subject === "principal")).toBe(true);
  });

  it("still credits a hired carrier", () => {
    const p = plan();
    p.seats[0].hireMonths = [0];
    const findings = report(p).scenarios[0].findings;
    const w103 = findings.filter((f) => f.code === "W103");
    expect(w103).toHaveLength(1);
    expect(w103[0].message).toMatch(/Principal carries 2\.00 FTE/);
    expect(findings.some((f) => f.code === "W115")).toBe(true); // 12 × 1.1 = 13.2 FTE-months on a hired seat
  });
});
