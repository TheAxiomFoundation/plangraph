import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  AS_PLANNED,
  LEVELED,
  countBy,
  fundingYear,
  ledger,
  lintAll,
  lintPlan,
  loadPlanFile,
  monthIndex,
  monthLabel,
  monthlyLoaded,
  overloads,
  parsePlan,
  report,
  schedule,
  slips,
  type Plan,
} from "../src/index";

const studio = () => loadPlanFile(new URL("../examples/studio.yaml", import.meta.url).pathname);
const sc = (plan: Plan, id: string) => plan.scenarios!.find((s) => s.id === id)!;

const tiny = (over: Partial<Plan> = {}): Plan => ({
  name: "tiny",
  calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
  circles: ["a"],
  escalation: { rate: 0, basis: "A" },
  seats: [{ id: "x", title: "X", loadedAnnual: 120_000, costBasis: "A", hireMonths: [0], capacityFte: 1, fallback: null }],
  items: [],
  streams: [],
  funding: [],
  nonLabor: [],
  ...over,
});

describe("calendar", () => {
  it("labels months and counts funding years", () => {
    const cal = { startYear: 2027, startMonth: 1, horizonMonths: 36, fundingYearStartMonth: 0 };
    expect(monthLabel(cal, 0)).toBe("2027-01");
    expect(monthLabel(cal, 13)).toBe("2028-02");
    expect(monthIndex(cal, 2028, 3)).toBe(14);
    expect(fundingYear(cal, 0)).toBe(1);
    expect(fundingYear(cal, 12)).toBe(2);
    const shifted = { ...cal, startMonth: 7, fundingYearStartMonth: 3 };
    expect(monthLabel(shifted, 3)).toBe("2027-10");
    expect(fundingYear(shifted, 2)).toBe(0);
  });
});

describe("parsing", () => {
  it("accepts the example and rejects a broken file with every problem named", () => {
    expect(studio().items.length).toBe(9);
    expect(() => parsePlan({ name: "", calendar: {}, circles: "no", seats: [{}], items: [], streams: [], funding: [], nonLabor: [] })).toThrow(/plan\.name[\s\S]*plan\.calendar\.startYear[\s\S]*plan\.seats\[0\]\.id/);
  });
});

describe("scheduling", () => {
  it("is deterministic and reproduces declared starts when nothing binds", () => {
    const p = studio();
    const a = schedule(p, sc(p, "leveled"));
    const b = schedule(p, sc(p, "leveled"));
    expect(a.items.map((i) => i.start)).toEqual(b.items.map((i) => i.start));
    const asPlanned = schedule(p, sc(p, "as-planned"));
    for (const it of asPlanned.items) {
      const preds = it.item.predecessors.map((x) => asPlanned.items.find((y) => y.item.id === x.id)!);
      const ready = Math.max(it.item.earliest, ...preds.map((x) => (x.item.standing ? x.start + 1 : x.end)));
      expect(it.start).toBe(ready);
    }
  });

  it("names the binding constraint", () => {
    const p = studio();
    const s = schedule(p, sc(p, "as-planned"));
    const launch = s.items.find((i) => i.item.id === "launch")!;
    expect(launch.binding).toEqual({ kind: "predecessor", id: "onboarding" });
    expect(s.items.find((i) => i.item.id === "proto")!.binding).toEqual({ kind: "underway" });
  });

  it("hands an unfilled seat's work to its fallback and reports it as fixed load", () => {
    const p = studio();
    const s = schedule(p, sc(p, "eng-late"));
    const proto = s.items.find((i) => i.item.id === "proto")!;
    expect(proto.carriers.find((c) => c.seat === "eng")!.carrier).toBe("founder");
    const founder = s.loads.find((l) => l.seat === "founder")!;
    expect(founder.fixed[0]).toBeGreaterThan(0);
  });

  it("never exceeds capacity when leveling, except for load it cannot move", () => {
    const p = studio();
    for (const id of ["leveled", "eng-late", "no-grant"]) {
      const s = schedule(p, sc(p, id));
      for (const load of s.loads) {
        for (let m = 0; m < s.horizon; m++) {
          expect(load.demand[m] - load.fixed[m]).toBeLessThanOrEqual(load.capacity[m] + 1e-9);
        }
      }
    }
  });

  it("sends an item that never fits beyond the horizon, and its dependents with it", () => {
    const p = tiny({
      items: [
        // "a" sorts first, so it books the whole seat for the whole year; "more" then never fits.
        { id: "a", lane: "l", label: "big", circle: "a", earliest: 0, duration: 12, standing: false, underway: false, predecessors: [], demands: [{ seat: "x", fte: 1, basis: "A" }] },
        { id: "more", lane: "l", label: "more", circle: "a", earliest: 0, duration: 3, standing: false, underway: false, predecessors: [], demands: [{ seat: "x", fte: 0.5, basis: "A" }] },
        { id: "after", lane: "l", label: "after", circle: "a", earliest: 0, duration: 1, standing: false, underway: false, predecessors: [{ id: "more" }], demands: [{ seat: "x", fte: 0.1, basis: "A" }] },
      ],
    });
    const s = schedule(p, LEVELED);
    const more = s.items.find((i) => i.item.id === "more")!;
    const after = s.items.find((i) => i.item.id === "after")!;
    expect(more.beyond).toBe(true);
    expect(after.beyond).toBe(true);
    expect(s.loads[0].demand.every((d, m) => d <= s.loads[0].capacity[m] + 1e-9)).toBe(true);
  });

  it("treats a standing predecessor as ready once it is running", () => {
    const p = tiny({
      items: [
        { id: "s", lane: "l", label: "standing", circle: "a", earliest: 2, duration: 1, standing: true, underway: false, predecessors: [], demands: [{ seat: "x", fte: 0.2, basis: "A" }] },
        { id: "d", lane: "l", label: "dependent", circle: "a", earliest: 0, duration: 2, standing: false, underway: false, predecessors: [{ id: "s" }], demands: [{ seat: "x", fte: 0.2, basis: "A" }] },
      ],
    });
    expect(schedule(p, AS_PLANNED).items.find((i) => i.item.id === "d")!.start).toBe(3);
  });

  it("refuses a cycle", () => {
    const p = tiny({
      items: [
        { id: "p", lane: "l", label: "p", circle: "a", earliest: 0, duration: 1, standing: false, underway: false, predecessors: [{ id: "q" }], demands: [{ seat: "x", fte: 0.1, basis: "A" }] },
        { id: "q", lane: "l", label: "q", circle: "a", earliest: 0, duration: 1, standing: false, underway: false, predecessors: [{ id: "p" }], demands: [{ seat: "x", fte: 0.1, basis: "A" }] },
      ],
    });
    expect(() => schedule(p, AS_PLANNED)).toThrow(/cycle/);
  });

  it("books the first circle first when leveling", () => {
    const p = tiny({
      circles: ["first", "second"],
      items: [
        { id: "b", lane: "l", label: "second", circle: "second", earliest: 0, duration: 2, standing: false, underway: false, predecessors: [], demands: [{ seat: "x", fte: 1, basis: "A" }] },
        { id: "a", lane: "l", label: "first", circle: "first", earliest: 0, duration: 2, standing: false, underway: false, predecessors: [], demands: [{ seat: "x", fte: 1, basis: "A" }] },
      ],
    });
    const s = schedule(p, LEVELED);
    expect(s.items.find((i) => i.item.id === "a")!.start).toBe(0);
    expect(s.items.find((i) => i.item.id === "b")!.start).toBe(2);
    expect(s.items.find((i) => i.item.id === "b")!.binding).toEqual({ kind: "capacity", seat: "x", carrier: "x" });
  });
});

describe("money", () => {
  it("charges seats on payroll whether or not busy, escalated from year 2", () => {
    const p = studio();
    const s = schedule(p, sc(p, "as-planned"));
    const l = ledger(p, s);
    const m = 14;
    const expected = p.seats.reduce((n, seat) => n + seat.hireMonths.filter((h) => h <= m).length * monthlyLoaded(p, seat.loadedAnnual, m), 0);
    expect(l.labor[m]).toBeCloseTo(expected, 6);
    expect(monthlyLoaded(p, 120_000, 12)).toBeCloseTo((120_000 * 1.03) / 12, 6);
    expect(monthlyLoaded(p, 120_000, 0)).toBeCloseTo(10_000, 6);
  });

  it("earns nothing before a stream unlocks, and unlocks move with the schedule", () => {
    const p = studio();
    const a = ledger(p, schedule(p, sc(p, "as-planned")));
    const b = ledger(p, schedule(p, sc(p, "eng-late")));
    for (const st of p.streams) {
      const on = a.unlocks[st.id]!;
      for (let m = 0; m < on; m++) expect(a.revenueByStream[st.id][m]).toBe(0);
      expect(b.unlocks[st.id]!).toBeGreaterThanOrEqual(on);
    }
  });

  it("counts funding lines as the scenario says", () => {
    const p = studio();
    const off = ledger(p, schedule(p, sc(p, "no-grant")));
    const on = ledger(p, schedule(p, sc(p, "grant-and-upside")));
    expect(off.fundingByLine.grant.every((v) => v === 0)).toBe(true);
    expect(on.fundingByLine.grant.reduce((x, y) => x + y, 0)).toBe(250_000);
    expect(on.revenue.reduce((x, y) => x + y, 0)).toBeGreaterThan(off.revenue.reduce((x, y) => x + y, 0));
  });
});

describe("harness", () => {
  it("passes the example with no errors and says where it is thin", () => {
    const r = report(studio());
    expect(r.errors).toBe(0);
    const asPlanned = r.scenarios[0];
    expect(asPlanned.findings.some((f) => f.code === "W106")).toBe(true);
    expect(r.scenarios.map((s) => s.scenario.id)).toEqual(["as-planned", "leveled", "eng-late", "no-grant", "grant-and-upside"]);
  });

  it("catches a broken graph", () => {
    const bad = tiny({
      seats: [
        { id: "x", title: "X", loadedAnnual: 1, costBasis: "A", hireMonths: [0], capacityFte: 1, fallback: "y" },
        { id: "y", title: "Y", loadedAnnual: 1, costBasis: "A", hireMonths: [], capacityFte: 0, fallback: "x" },
      ],
      items: [{ id: "a", lane: "l", label: "a", circle: "a", earliest: 0, duration: 0, standing: false, underway: false, predecessors: [{ id: "nope" }, { id: "a" }], demands: [] }],
      streams: [{ id: "s", label: "s", unlockedBy: "gone", unit: "u", price: { usd: 1, basis: "A", note: "" }, volumeByYear: { units: [], basis: "A", note: "" }, rampMonths: 0 }],
    });
    const codes = new Set(lintPlan(bad).map((f) => f.code));
    for (const c of ["E002", "E003", "E004", "E005", "E006"]) expect(codes.has(c)).toBe(true);
  });

  it("flags an owner arriving after its work, and overloads, on the example", () => {
    const p = studio();
    const s = schedule(p, sc(p, "eng-late"));
    const f = lintAll(p, s, ledger(p, s));
    expect(f.some((x) => x.code === "W103" && x.subject === "proto")).toBe(true);
    const asPlanned = schedule(p, sc(p, "as-planned"));
    expect(overloads(asPlanned).length + slips(asPlanned, s).length).toBeGreaterThan(0);
    expect(countBy(f).error).toBe(0);
  });
});

describe("cli", () => {
  it("prints a report and machine-readable json", () => {
    const cwd = new URL("..", import.meta.url).pathname;
    const human = spawnSync("bun", ["src/cli.ts", "check", "examples/studio.yaml"], { cwd, encoding: "utf8" });
    expect(human.status).toBe(0);
    expect(human.stdout).toContain("✓ no errors");
    expect(human.stdout).toContain("Engineer four months late");
    const js = spawnSync("bun", ["src/cli.ts", "check", "examples/studio.yaml", "--json", "--scenario", "eng-late"], { cwd, encoding: "utf8" });
    expect(js.status).toBe(0);
    const parsed = JSON.parse(js.stdout);
    expect(parsed.scenarios).toHaveLength(1);
    expect(parsed.scenarios[0].items.find((i: { id: string }) => i.id === "proto").binding.kind).toBe("underway");
  });
});
