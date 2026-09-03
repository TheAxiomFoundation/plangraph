import { describe, expect, it } from "vitest";
import {
  AS_PLANNED,
  PlanParseError,
  ledger,
  lintPlan,
  loadPlanFile,
  parsePlan,
  report,
  schedule,
} from "../src/index";

const studio = () => loadPlanFile(new URL("../examples/studio.yaml", import.meta.url).pathname);
const rawStudio = (): Record<string, any> => structuredClone(studio()) as unknown as Record<string, any>;

function expectRejectedAt(mutate: (raw: Record<string, any>) => void, path: string) {
  const raw = rawStudio();
  mutate(raw);
  try {
    parsePlan(raw);
    throw new Error("expected parsePlan to reject the fixture");
  } catch (error) {
    expect(error).toBeInstanceOf(PlanParseError);
    expect(error).not.toBeInstanceOf(RangeError);
    expect((error as PlanParseError).problems.some((problem) => problem.startsWith(`${path}:`))).toBe(true);
  }
}

describe("complete plan parsing", () => {
  it("rejects every non-integer month field at its exact path", () => {
    const cases: [string, (raw: Record<string, any>) => void][] = [
      ["plan.calendar.horizonMonths", (raw) => (raw.calendar.horizonMonths = 1.5)],
      ["plan.calendar.startMonth", (raw) => (raw.calendar.startMonth = 1.5)],
      ["plan.calendar.fundingYearStartMonth", (raw) => (raw.calendar.fundingYearStartMonth = 0.5)],
      ["plan.seats[0].hireMonths[0]", (raw) => (raw.seats[0].hireMonths[0] = 0.5)],
      ["plan.items[0].earliest", (raw) => (raw.items[0].earliest = 0.5)],
      ["plan.items[0].duration", (raw) => (raw.items[0].duration = 0.5)],
      ["plan.items[2].predecessors[0].lag", (raw) => (raw.items[2].predecessors[0].lag = 0.5)],
      ["plan.streams[0].rampMonths", (raw) => (raw.streams[0].rampMonths = 0.5)],
    ];
    for (const [path, mutate] of cases) expectRejectedAt(mutate, path);
  });

  it("enforces month ranges while allowing an ignored zero standing duration", () => {
    const cases: [string, (raw: Record<string, any>) => void][] = [
      ["plan.calendar.horizonMonths", (raw) => (raw.calendar.horizonMonths = 0)],
      ["plan.calendar.startMonth", (raw) => (raw.calendar.startMonth = 13)],
      ["plan.calendar.fundingYearStartMonth", (raw) => (raw.calendar.fundingYearStartMonth = raw.calendar.horizonMonths)],
      ["plan.seats[0].hireMonths[0]", (raw) => (raw.seats[0].hireMonths[0] = -1)],
      ["plan.items[0].earliest", (raw) => (raw.items[0].earliest = raw.calendar.horizonMonths)],
      ["plan.items[0].duration", (raw) => (raw.items[0].duration = 0)],
      ["plan.items[2].predecessors[0].lag", (raw) => (raw.items[2].predecessors[0].lag = -1)],
      ["plan.streams[0].rampMonths", (raw) => (raw.streams[0].rampMonths = -1)],
    ];
    for (const [path, mutate] of cases) expectRejectedAt(mutate, path);

    const standing = rawStudio();
    standing.items[0].standing = true;
    standing.items[0].duration = 0;
    expect(parsePlan(standing).items[0].duration).toBe(0);
  });

  it("requires finite non-negative non-empty revenue volumes", () => {
    expectRejectedAt((raw) => (raw.streams[0].volumeByYear.units = []), "plan.streams[0].volumeByYear.units");
    expectRejectedAt((raw) => (raw.streams[0].volumeByYear.units[0] = -1), "plan.streams[0].volumeByYear.units[0]");
    expectRejectedAt((raw) => (raw.streams[0].volumeByYear.units[0] = Number.NaN), "plan.streams[0].volumeByYear.units[0]");
    expectRejectedAt((raw) => (raw.streams[0].volumeByYear.units = Array(1)), "plan.streams[0].volumeByYear.units[0]");
  });

  it("rejects sparse arrays instead of letting holes reach computation", () => {
    const cases: [string, (raw: Record<string, any>) => void][] = [
      ["plan.circles[0]", (raw) => (raw.circles = Array(1))],
      ["plan.seats[0]", (raw) => (raw.seats = Array(1))],
      ["plan.items[0]", (raw) => (raw.items = Array(1))],
      ["plan.items[0].predecessors[0]", (raw) => (raw.items[0].predecessors = Array(1))],
      ["plan.items[0].demands[0]", (raw) => (raw.items[0].demands = Array(1))],
      ["plan.streams[0]", (raw) => (raw.streams = Array(1))],
      ["plan.funding[0]", (raw) => (raw.funding = Array(1))],
      ["plan.funding[0].byMonth[0]", (raw) => (raw.funding[0].byMonth = Array(1))],
      ["plan.nonLabor[0]", (raw) => (raw.nonLabor = Array(1))],
      ["plan.scenarios[0]", (raw) => (raw.scenarios = Array(1))],
      ["plan.reference.nonLaborShare[0]", (raw) => (raw.reference = { headcountByYear: [1], gross: 1, nonLaborShare: Array(2), note: "source" })],
    ];
    for (const [path, mutate] of cases) expectRejectedAt(mutate, path);
  });

  it("validates scenario values and override ids at exact paths", () => {
    const cases: [string, (raw: Record<string, any>) => void][] = [
      ["plan.scenarios[0].gist", (raw) => delete raw.scenarios[0].gist],
      ["plan.scenarios[0].volumeScale", (raw) => (raw.scenarios[0].volumeScale = "nope")],
      ["plan.scenarios[0].durationScale", (raw) => (raw.scenarios[0].durationScale = Number.POSITIVE_INFINITY)],
      ["plan.scenarios[0].effortScale", (raw) => (raw.scenarios[0].effortScale = 0)],
      ["plan.scenarios[0].hireDelay.eng", (raw) => (raw.scenarios[0].hireDelay = { eng: 0.5 })],
      ["plan.scenarios[0].hireDelay.unknown", (raw) => (raw.scenarios[0].hireDelay = { unknown: 1 })],
      ["plan.scenarios[0].countFunding.unknown", (raw) => (raw.scenarios[0].countFunding = { unknown: true })],
      ["plan.scenarios[0].countFunding.grant", (raw) => (raw.scenarios[0].countFunding = { grant: "yes" })],
    ];
    for (const [path, mutate] of cases) expectRejectedAt(mutate, path);

    const negativeDelay = rawStudio();
    negativeDelay.scenarios[0].hireDelay = { eng: -2 };
    expect(parsePlan(negativeDelay).scenarios?.[0].hireDelay?.eng).toBe(-2);
  });

  it("validates the complete reference shape and its domains", () => {
    expectRejectedAt((raw) => (raw.reference = {}), "plan.reference.headcountByYear");
    expectRejectedAt((raw) => (raw.reference = {}), "plan.reference.gross");
    expectRejectedAt((raw) => (raw.reference = {}), "plan.reference.nonLaborShare");
    expectRejectedAt((raw) => (raw.reference = {}), "plan.reference.note");

    const reference = { headcountByYear: [1], gross: 1, nonLaborShare: [0.1, 0.2], note: "source" };
    expectRejectedAt((raw) => (raw.reference = { ...reference, headcountByYear: [] }), "plan.reference.headcountByYear");
    expectRejectedAt((raw) => (raw.reference = { ...reference, headcountByYear: [1.5] }), "plan.reference.headcountByYear[0]");
    expectRejectedAt((raw) => (raw.reference = { ...reference, gross: 0 }), "plan.reference.gross");
    expectRejectedAt((raw) => (raw.reference = { ...reference, nonLaborShare: [0.3] }), "plan.reference.nonLaborShare");
    expectRejectedAt((raw) => (raw.reference = { ...reference, nonLaborShare: [-0.1, 0.2] }), "plan.reference.nonLaborShare[0]");
    expectRejectedAt((raw) => (raw.reference = { ...reference, nonLaborShare: [0.3, 0.2] }), "plan.reference.nonLaborShare");
  });

  it("requires model strings and finite optional configuration while allowing unknown top-level keys", () => {
    const cases: [string, (raw: Record<string, any>) => void][] = [
      ["plan.funding[0].note", (raw) => delete raw.funding[0].note],
      ["plan.nonLabor[0].label", (raw) => delete raw.nonLabor[0].label],
      ["plan.nonLabor[0].note", (raw) => delete raw.nonLabor[0].note],
      ["plan.items[0].owner", (raw) => (raw.items[0].owner = 42)],
      ["plan.openingCash", (raw) => (raw.openingCash = Number.NaN)],
      ["plan.lint.overloadMonths", (raw) => (raw.lint = { overloadMonths: "three" })],
      ["plan.calendar.horizonMonths", (raw) => (raw.calendar.horizonMonths = 0x1_0000_0000)],
      ["plan.seats[0].id", (raw) => (raw.seats[0].id = "external")],
    ];
    for (const [path, mutate] of cases) expectRejectedAt(mutate, path);

    const raw = rawStudio();
    raw.futureExtension = { accepted: true };
    expect(parsePlan(raw).name).toBe("Northwind Studio");
  });

  it("fails explicitly instead of returning non-finite derived money", () => {
    const raw = rawStudio();
    raw.funding = [
      { id: "huge-a", label: "Huge A", byMonth: [Number.MAX_VALUE], basis: "A", note: "stress", counted: true },
      { id: "huge-b", label: "Huge B", byMonth: [Number.MAX_VALUE], basis: "A", note: "stress", counted: true },
    ];
    raw.scenarios.forEach((scenario: Record<string, unknown>) => delete scenario.countFunding);
    expect(() => report(parsePlan(raw))).toThrow(/non-finite total funding at month 0/);
  });
});

describe("structural preflight", () => {
  it("returns cycles and bad references before schedule or ledger construction", () => {
    const raw = rawStudio();
    raw.items[0].predecessors = [{ id: "beta" }];
    raw.items[1].predecessors = [{ id: "missing-item" }];
    raw.streams[0].unlockedBy = "missing-unlock";
    const result = report(parsePlan(raw));

    expect(result.scenarios).toEqual([]);
    expect(result.errors).toBe(result.planFindings.filter((finding) => finding.severity === "error").length);
    expect(result.planFindings.some((finding) => finding.code === "E002" && /proto.*beta.*proto/.test(finding.message))).toBe(true);
    expect(result.planFindings.some((finding) => finding.code === "E002" && finding.message.includes("missing-item"))).toBe(true);
    expect(result.planFindings.some((finding) => finding.code === "E003" && finding.message.includes("missing-unlock"))).toBe(true);
  });

  it("detects unknown circles, duplicate demand seats, invalid owners, and all duplicate-id scopes", () => {
    const plan = structuredClone(studio());
    plan.items[0].circle = "frist";
    plan.items[0].demands.push({ ...plan.items[0].demands[0] });
    plan.items[0].owner = "sales";
    plan.scenarios!.push({ ...plan.scenarios![0] });
    plan.funding.push({ ...plan.funding[0] });
    plan.nonLabor.push({ ...plan.nonLabor[0] });
    plan.circles.push(plan.circles[0]);
    const findings = lintPlan(plan);

    expect(findings.some((finding) => finding.code === "E007" && finding.subject === "proto")).toBe(true);
    expect(findings.filter((finding) => finding.code === "E004" && finding.subject === "proto")).toHaveLength(2);
    for (const scope of ["scenario", "funding line", "non-labor line", "circle"]) {
      expect(findings.some((finding) => finding.code === "E001" && finding.message.includes(scope))).toBe(true);
    }
  });

  it("rejects the reserved external carrier sentinel as an internal seat id", () => {
    const plan = structuredClone(studio());
    plan.seats[0].id = "external";
    expect(lintPlan(plan)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "E006", subject: "external", message: expect.stringContaining("reserved") }),
      ]),
    );
  });

  it("keeps plan findings once and scenario findings on scenarios", () => {
    const result = report(studio());
    expect(result.planFindings).toEqual([]);
    expect(result.errors).toBe(
      result.planFindings.filter((finding) => finding.severity === "error").length +
        result.scenarios.reduce((total, scenario) => total + scenario.counts.error, 0),
    );
    expect(result.scenarios.every((scenario) => scenario.findings.every((finding) => !finding.code.startsWith("E")))).toBe(true);
  });
});

describe("prototype-safe ids", () => {
  it("treats __proto__ and toString as ordinary own ids and ignores inherited overrides", () => {
    const plan = parsePlan({
      name: "prototype ids",
      calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
      circles: ["a"],
      escalation: { rate: 0, basis: "A" },
      seats: [{ id: "__proto__", title: "Prototype", loadedAnnual: 0, costBasis: "A", hireMonths: [0], capacityFte: 1, fallback: null }],
      items: [{ id: "unlock", lane: "l", label: "Unlock", circle: "a", earliest: 0, duration: 1, standing: false, underway: false, predecessors: [], demands: [{ seat: "__proto__", fte: 0.1, basis: "A" }] }],
      streams: [{ id: "__proto__", label: "Revenue", unlockedBy: "unlock", unit: "units", price: { usd: 12, basis: "A", note: "price" }, volumeByYear: { units: [12], basis: "A", note: "volume" }, rampMonths: 0 }],
      funding: [{ id: "toString", label: "Disabled", byMonth: [100], basis: "A", note: "not counted", counted: false }],
      nonLabor: [],
      scenarios: [{ ...AS_PLANNED, countFunding: {} }],
    });
    const scheduled = schedule(plan, plan.scenarios![0]);
    const money = ledger(plan, scheduled);
    const result = report(plan);

    expect(Object.getPrototypeOf(scheduled.hires)).toBeNull();
    expect(Object.hasOwn(scheduled.hires, "__proto__")).toBe(true);
    for (const record of [money.unlocks, money.revenueByStream, money.fundingByLine, result.scenarios[0].unlocks]) {
      expect(Object.getPrototypeOf(record)).toBeNull();
    }
    expect(Object.hasOwn(money.unlocks, "__proto__")).toBe(true);
    expect(Object.hasOwn(money.revenueByStream, "__proto__")).toBe(true);
    expect(Object.hasOwn(money.fundingByLine, "toString")).toBe(true);
    expect(money.funding.reduce((total, value) => total + value, 0)).toBe(0);
    expect(Object.hasOwn(result.scenarios[0].unlocks, "__proto__")).toBe(true);
  });
});
