import { describe, expect, it } from "vitest";
import {
  AS_PLANNED,
  PlanParseError,
  ledger,
  lintPlan,
  parsePlan,
  report,
  schedule,
} from "../src/index";
import { loadPlanFile } from "../src/node";

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
      ["plan.scenarios[0].hireDelay.eng[0]", (raw) => (raw.scenarios[0].hireDelay = { eng: Array(1) })],
      ["plan.scenarios[0].dropHires.eng", (raw) => (raw.scenarios[0].dropHires = { eng: Array(1) })],
      ["plan.scenarios[0].dropItems[0]", (raw) => (raw.scenarios[0].dropItems = Array(1))],
      ["plan.scenarios[0].dropSeats[0]", (raw) => (raw.scenarios[0].dropSeats = Array(1))],
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
      ["plan.scenarios[0].hireDelay.eng", (raw) => {
        raw.scenarios[0].hireDelay = {};
        Object.defineProperty(raw.scenarios[0].hireDelay, "eng", { value: 0.5, enumerable: false });
      }],
      ["plan.scenarios[0].hireDelay.unknown", (raw) => (raw.scenarios[0].hireDelay = { unknown: 1 })],
      ["plan.scenarios[0].countFunding.unknown", (raw) => (raw.scenarios[0].countFunding = { unknown: true })],
      ["plan.scenarios[0].countFunding.grant", (raw) => (raw.scenarios[0].countFunding = { grant: "yes" })],
      ["plan.scenarios[0].countFunding.grant", (raw) => {
        raw.scenarios[0].countFunding = {};
        Object.defineProperty(raw.scenarios[0].countFunding, "grant", { value: "yes", enumerable: false });
      }],
    ];
    for (const [path, mutate] of cases) expectRejectedAt(mutate, path);

    const negativeDelay = rawStudio();
    negativeDelay.scenarios[0].hireDelay = { eng: -2 };
    expect(parsePlan(negativeDelay).scenarios?.[0].hireDelay?.eng).toBe(-2);
  });

  it("rejects scenario overrides the scheduler would ignore, at their exact paths", () => {
    const problems = (mutate: (raw: Record<string, any>) => void): string[] => {
      const raw = rawStudio();
      mutate(raw);
      try {
        parsePlan(raw);
        return [];
      } catch (error) {
        expect(error).toBeInstanceOf(PlanParseError);
        return (error as PlanParseError).problems;
      }
    };

    // The engineer role has two hires, so a third delay has nothing to delay.
    expect(rawStudio().seats[1]).toMatchObject({ id: "eng", hireMonths: [2, 14] });
    expect(problems((raw) => (raw.scenarios[0].hireDelay = { eng: [1, 2, 3] }))).toEqual([
      "plan.scenarios[0].hireDelay.eng: must have no more entries than the seat's hireMonths",
    ]);
    expect(problems((raw) => (raw.scenarios[0].hireDelay = { eng: [1, 0.5] }))).toEqual([
      "plan.scenarios[0].hireDelay.eng[1]: must be an integer",
    ]);

    // A dropped role is never hired, so a delay or a dropped hire on it would be ignored.
    expect(problems((raw) => Object.assign(raw.scenarios[0], { dropSeats: ["eng"], hireDelay: { eng: 2 } }))).toEqual([
      "plan.scenarios[0].hireDelay.eng: must not name a seat in dropSeats",
    ]);
    expect(problems((raw) => Object.assign(raw.scenarios[0], { dropSeats: ["eng"], dropHires: { eng: [0] } }))).toEqual([
      "plan.scenarios[0].dropHires.eng: must not name a seat in dropSeats",
    ]);
    expect(problems((raw) => Object.assign(raw.scenarios[0], { dropSeats: ["eng"], hireDelay: { eng: [1] }, dropHires: { eng: [1] } }))).toEqual([
      "plan.scenarios[0].hireDelay.eng: must not name a seat in dropSeats",
      "plan.scenarios[0].dropHires.eng: must not name a seat in dropSeats",
    ]);

    // A dropped hire takes no delay of its own, either way; a 0 keeps the list aligned.
    for (const delay of [5, -1]) {
      expect(problems((raw) => Object.assign(raw.scenarios[0], { dropHires: { eng: [0] }, hireDelay: { eng: [delay, 0] } }))).toEqual([
        "plan.scenarios[0].hireDelay.eng[0]: must be 0 for a hire in dropHires",
      ]);
    }
    // Nor does a role whose every hire is dropped take a whole-role delay.
    for (const delay of [3, -1]) {
      expect(problems((raw) => Object.assign(raw.scenarios[0], { dropHires: { eng: [1, 0] }, hireDelay: { eng: delay } }))).toEqual([
        "plan.scenarios[0].hireDelay.eng: must be 0 when dropHires drops every hire",
      ]);
    }

    // A malformed sibling is reported where it is, once, not as a crash or a conflict.
    expect(problems((raw) => Object.assign(raw.scenarios[0], { dropHires: { eng: 0 }, hireDelay: { eng: [1] } }))).toEqual([
      "plan.scenarios[0].dropHires.eng: must list indices into the seat's hireMonths",
    ]);
    expect(problems((raw) => Object.assign(raw.scenarios[0], { dropHires: null, hireDelay: { eng: 1 } }))).toEqual([
      "plan.scenarios[0].dropHires: must be an object",
    ]);
    expect(problems((raw) => Object.assign(raw.scenarios[0], { dropSeats: "eng", hireDelay: { eng: 1 } }))).toEqual([
      "plan.scenarios[0].dropSeats: must be an array of seat ids",
    ]);
    // An unknown seat is one problem, whatever shape its delay takes; a dropped seat with too
    // long a list is two.
    for (const delay of [1, [1]]) {
      expect(problems((raw) => (raw.scenarios[0].hireDelay = { nobody: delay }))).toEqual(["plan.scenarios[0].hireDelay.nobody: must name a known seat"]);
    }
    expect(problems((raw) => Object.assign(raw.scenarios[0], { dropSeats: ["eng"], hireDelay: { eng: [1, 2, 3] } }))).toEqual([
      "plan.scenarios[0].hireDelay.eng: must not name a seat in dropSeats",
      "plan.scenarios[0].hireDelay.eng: must have no more entries than the seat's hireMonths",
    ]);

    // Still accepted: a shorter list (missing entries are 0), a full one with a negative
    // delay, a placeholder 0 for a dropped hire, a whole-role delay beside dropped hires
    // (a repeated index drops one hire, so one is left to delay), a 0 whole-role delay on a
    // role with every hire dropped, and overrides on a seat other than the dropped one.
    for (const scenario of [
      { hireDelay: { eng: [3] } },
      { hireDelay: { eng: [3, -20] } },
      { dropHires: { eng: [0] }, hireDelay: { eng: [0, 3] } },
      { dropHires: { eng: [0] }, hireDelay: { eng: 3 } },
      { dropHires: { eng: [0, 0] }, hireDelay: { eng: 3 } },
      { dropHires: { eng: [0, 1] }, hireDelay: { eng: 0 } },
      { dropSeats: ["design"], hireDelay: { eng: 2 }, dropHires: { sales: [0] } },
    ]) {
      expect(problems((raw) => Object.assign(raw.scenarios[0], scenario))).toEqual([]);
    }
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

describe("per-year loaded cost", () => {
  it("rejects an empty or negative schedule at its path and carries a good one through", () => {
    expectRejectedAt((raw) => (raw.seats[0].loadedAnnualByYear = []), "plan.seats[0].loadedAnnualByYear");
    expectRejectedAt((raw) => (raw.seats[0].loadedAnnualByYear = [1, -2]), "plan.seats[0].loadedAnnualByYear[1]");
    const raw = rawStudio();
    raw.seats[0].loadedAnnualByYear = [100, 110];
    expect(parsePlan(raw).seats[0].loadedAnnualByYear).toEqual([100, 110]);
  });
});
