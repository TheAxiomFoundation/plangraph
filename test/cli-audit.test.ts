import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AS_PLANNED, parsePlan, report, type Plan } from "../src/index";
import { loadPlanFile } from "../src/node";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "src/cli.ts");
const studioPath = join(root, "examples/studio.yaml");
const temporaryDirectories: string[] = [];

const run = (...args: string[]): SpawnSyncReturns<string> =>
  spawnSync("bun", [cli, ...args], { cwd: root, encoding: "utf8" });

const physicalLines = (text: string): string[] => {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  return normalized.length === 0 ? [] : normalized.split("\n");
};

const normalizedLine = (line: string): string => line.trim().replace(/\s+/g, " ");

const writePlan = (value: unknown): string => {
  const directory = mkdtempSync(join(tmpdir(), "plangraph-cli-audit-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "plan.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
};

/** Every order of three things, as indices. */
const ORDERS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const basePlan = (): Plan => ({
  name: "CLI audit fixture",
  calendar: { startYear: 2027, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
  circles: ["core"],
  escalation: { rate: 0, basis: "A" },
  seats: [
    {
      id: "x",
      title: "X",
      loadedAnnual: 0,
      costBasis: "A",
      hireMonths: [0],
      capacityFte: 1,
      fallback: null,
    },
  ],
  items: [],
  streams: [],
  funding: [],
  nonLabor: [],
  scenarios: [AS_PLANNED],
});

describe("defensive CLI audit", () => {
  it("A11 exits 2 with one concise line for an unknown scenario", () => {
    const result = run("check", studioPath, "--scenario", "does-not-exist");

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(physicalLines(result.stderr)).toEqual([
      'plangraph: unknown scenario "does-not-exist"',
    ]);
  });

  it("A11 exits 2 with one line when --scenario has no value or another flag as its value", () => {
    for (const args of [
      ["check", studioPath, "--scenario"],
      ["check", studioPath, "--scenario", "--json"],
    ]) {
      const result = run(...args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      const lines = physicalLines(result.stderr);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/--scenario.*(?:requires|missing|value|id)/i);
    }
  });

  it("D9 prints only the selected scenario's two slips against the baseline and external work on its own row", () => {
    const expected = report(loadPlanFile(studioPath), "eng-late").scenarios[0];
    const result = run("check", studioPath, "--scenario", "eng-late");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const lines = physicalLines(result.stdout);
    const slipLines = lines.filter((line) => line.includes("Slips vs baseline"));
    expect(slipLines).toHaveLength(1);
    expect(normalizedLine(slipLines[0])).toBe(
      "Slips vs baseline Enterprise tier +4 · Mobile app +4",
    );

    const externalLines = lines.filter((line) => line.includes("External FTE-months"));
    expect(externalLines).toHaveLength(1);
    const amount = externalLines[0].match(/(-?\d+(?:\.\d+)?)\s*$/);
    expect(amount).not.toBeNull();
    expect(Number(amount![1])).toBeCloseTo(expected.externalFteMonths, 2);
  });

  it("D9 keeps selected JSON slips and external FTE-months aligned with the baseline report", () => {
    const expected = report(loadPlanFile(studioPath), "eng-late").scenarios[0];
    const result = run("check", studioPath, "--scenario", "eng-late", "--json");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as {
      scenarios: Array<{
        scenario: string;
        slips: Array<{ id: string; months: number }>;
        externalFteMonths: number;
      }>;
    };
    expect(output.scenarios).toHaveLength(1);
    expect(output.scenarios[0].scenario).toBe("eng-late");
    expect(output.scenarios[0].slips.map(({ id, months }) => ({ id, months }))).toEqual([
      { id: "enterprise", months: 4 },
      { id: "mobile", months: 4 },
    ]);
    expect(output.scenarios[0].slips.map(({ id, months }) => ({ id, months }))).toEqual(
      expected.slips.map(({ id, months }) => ({ id, months })),
    );
    expect(output.scenarios[0].externalFteMonths).toBeCloseTo(expected.externalFteMonths, 12);
  });

  const chainPlan = (): Plan => {
    const raw = basePlan();
    const item = (id: string, label: string, over: Partial<Plan["items"][number]> = {}): Plan["items"][number] => ({
      id,
      lane: "lane",
      label,
      circle: "core",
      earliest: 0,
      duration: 1,
      standing: false,
      underway: false,
      predecessors: [],
      demands: [{ seat: "x", fte: 1, basis: "A" }],
      ...over,
    });
    raw.items = [
      item("p", "P", { duration: 4 }),
      item("a", "A", { predecessors: [{ id: "p" }] }),
      item("b", "B", { predecessors: [{ id: "a" }] }),
    ];
    raw.scenarios = [
      AS_PLANNED,
      { ...AS_PLANNED, id: "drop", name: "Drop", gist: "Without A.", dropItems: ["a"] },
      { ...AS_PLANNED, id: "fast", name: "Fast", gist: "Everything takes half as long.", durationScale: 0.5 },
    ];
    return raw;
  };

  it("marks a dropped item in --json and never lists it as a slip", () => {
    const path = writePlan(chainPlan());

    const json = run("check", path, "--scenario", "drop", "--json");
    expect(json.status).toBe(0);
    const output = JSON.parse(json.stdout) as {
      scenarios: Array<{
        slips: Array<{ id: string; months: number; beyond: boolean }>;
        items: Array<{ id: string; start: string | null; end: string | null; beyond: boolean; dropped: boolean; binding: unknown }>;
      }>;
    };
    const items = output.scenarios[0].items;
    expect(items.find((it) => it.id === "a")).toEqual({ id: "a", start: null, end: null, beyond: true, dropped: true, binding: { kind: "dropped" } });
    expect(items.find((it) => it.id === "b")).toEqual({ id: "b", start: null, end: null, beyond: true, dropped: false, binding: { kind: "predecessor", id: "a" } });
    expect(items.find((it) => it.id === "p")).toMatchObject({ beyond: false, dropped: false });
    expect(output.scenarios[0].slips).toEqual([{ id: "b", label: "B", months: 12 - 5, beyond: true, binding: { kind: "predecessor", id: "a" } }]);

    const text = run("check", path, "--scenario", "drop");
    expect(text.status).toBe(0);
    const line = physicalLines(text.stdout).find((l) => l.trim().startsWith("Slips vs baseline"));
    expect(normalizedLine(line!)).toBe("Slips vs baseline B beyond horizon");
  });

  it("prints a slip earlier than the baseline with its own sign", () => {
    const text = run("check", writePlan(chainPlan()), "--scenario", "fast");
    expect(text.status).toBe(0);
    const line = physicalLines(text.stdout).find((l) => l.trim().startsWith("Slips vs baseline"));
    expect(normalizedLine(line!)).toBe("Slips vs baseline A -2 · B -2");
  });

  it("D5 prints one line per structural E finding before any normal report", () => {
    const raw = basePlan();
    raw.items = [
      {
        id: "a",
        lane: "lane",
        label: "A",
        circle: "core",
        owner: "x",
        earliest: 0,
        duration: 1,
        standing: false,
        underway: false,
        predecessors: [{ id: "b" }],
        demands: [{ seat: "x", fte: 0.1, basis: "A" }],
      },
      {
        id: "b",
        lane: "lane",
        label: "B",
        circle: "core",
        owner: "x",
        earliest: 0,
        duration: 1,
        standing: false,
        underway: false,
        predecessors: [{ id: "a" }],
        demands: [{ seat: "x", fte: 0.1, basis: "A" }],
      },
      {
        id: "bad-edge",
        lane: "lane",
        label: "Bad edge",
        circle: "core",
        owner: "x",
        earliest: 0,
        duration: 1,
        standing: false,
        underway: false,
        predecessors: [{ id: "missing-item" }],
        demands: [{ seat: "x", fte: 0.1, basis: "A" }],
      },
    ];
    raw.streams = [
      {
        id: "bad-stream",
        label: "Bad stream",
        unlockedBy: "missing-unlock",
        unit: "unit",
        price: { usd: 1, basis: "A", note: "fixture" },
        volumeByYear: { units: [1], basis: "A", note: "fixture" },
        rampMonths: 0,
      },
    ];
    const parsed = parsePlan(raw);
    const expected = report(parsed).planFindings.filter((item) => item.severity === "error");
    expect(expected).toHaveLength(3);

    const result = run("check", writePlan(raw));
    const lines = physicalLines(result.stderr);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(lines).toHaveLength(expected.length);
    for (const item of expected) {
      expect(lines.filter((line) => line.includes(item.code) && line.includes(item.message))).toHaveLength(1);
    }
    expect(result.stderr).not.toMatch(/(?:^|\n)\s*at\s/u);
    expect(result.stderr).not.toMatch(/src\/|file:\/\/|Error:/u);
    expect(result.stderr).not.toMatch(/plangraph ·|✓ no errors|✗/u);
  });

  it("A11 prints one line per parse problem without a stack or normal report", () => {
    const raw = basePlan();
    raw.name = "";
    raw.calendar.startMonth = 13;

    const result = run("check", writePlan(raw));
    const lines = physicalLines(result.stderr);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("plan.name:");
    expect(lines[1]).toContain("plan.calendar.startMonth:");
    expect(result.stderr).not.toMatch(/(?:^|\n)\s*at\s/u);
    expect(result.stderr).not.toMatch(/PlanParseError|src\/|file:\/\/|Error:/u);
    expect(result.stderr).not.toMatch(/plangraph ·|✓ no errors|✗/u);
  });

  it("A11 keeps report's unknown-scenario API error concise", () => {
    let thrown: unknown;
    try {
      report(loadPlanFile(studioPath), "does-not-exist");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('plangraph: unknown scenario "does-not-exist"');
    expect(physicalLines((thrown as Error).message)).toHaveLength(1);
  });

  it("prints external FTE-months and overload peaks that round the same in every booking order", () => {
    // Priorities set the booking order. 0.288 + 0.465 + 0.772 FTE of a vendor's work goes external:
    // 1.525 or 1.5250000000000001 FTE-months by order. 0.023 + 0.472 + 0.63 on x is 1.125 or
    // 1.1249999999999998, a peak of 0.125 or just under it. toFixed shows either figure both ways.
    const item = (id: string, seat: string, fte: number, priority: number) => ({
      id,
      lane: "lane",
      label: id,
      circle: "core",
      owner: seat,
      earliest: 0,
      duration: 1,
      standing: false,
      underway: false,
      priority,
      predecessors: [],
      demands: [{ seat, fte, basis: "A" }],
    });
    const printed = ORDERS.map((order) => {
      const raw = basePlan();
      raw.seats.push({ id: "vendor", title: "Vendor", loadedAnnual: 0, costBasis: "A", hireMonths: [12], capacityFte: 1, fallback: "external" });
      raw.items = [
        ...[0.288, 0.465, 0.772].map((fte, k) => item(`v${k}`, "vendor", fte, order[k])),
        ...[0.023, 0.472, 0.63].map((fte, k) => item(`x${k}`, "x", fte, order[k])),
      ] as Plan["items"];
      const result = run("check", writePlan(raw));
      expect(result.status).toBe(0);
      const s = report(parsePlan(raw)).scenarios[0];
      return {
        external: s.externalFteMonths.toFixed(2),
        peak: s.overloads[0].peak.toFixed(2),
        lines: physicalLines(result.stdout).filter((line) => /External FTE-months|Over capacity/.test(line)).map(normalizedLine),
      };
    });
    expect(new Set(printed.map((p) => p.external))).toEqual(new Set(["1.52", "1.53"]));
    expect(new Set(printed.map((p) => p.peak))).toEqual(new Set(["0.12", "0.13"]));
    for (const p of printed) expect(p.lines).toEqual(["External FTE-months 1.53", "Over capacity x 1 mo (peak +0.13)"]);
  });

  it("prints money that rounds the same in every order of seats", () => {
    // 691,000 + 307,000 + 237,000 of salary comes to exactly 1,235,000 in some orders of seats and
    // a hair under it in others: toFixed shows 1.24 or 1.23.
    const seat = (id: string, loadedAnnual: number) => ({ id, title: id, loadedAnnual, costBasis: "A", hireMonths: [0], capacityFte: 1, fallback: null });
    const salaries: Array<[string, number]> = [["a", 691_000], ["b", 307_000], ["c", 237_000]];
    const printed = ORDERS.map((order) => {
      const raw = basePlan();
      raw.seats = order.map((k) => seat(...salaries[k])) as Plan["seats"];
      const result = run("check", writePlan(raw));
      expect(result.status).toBe(0);
      const s = report(parsePlan(raw)).scenarios[0];
      return {
        cost: (s.costByYear[0] / 1e6).toFixed(2),
        trough: (s.cashTrough.usd / 1e6).toFixed(2),
        lines: physicalLines(result.stdout).filter((line) => /Cost \(\$M\)|Cash trough/.test(line)).map(normalizedLine),
      };
    });
    expect(new Set(printed.map((p) => p.cost))).toEqual(new Set(["1.23", "1.24"]));
    expect(new Set(printed.map((p) => p.trough))).toEqual(new Set(["-1.23", "-1.24"]));
    for (const p of printed) expect(p.lines).toEqual(["Cost ($M) 1.24 | 1y 1.24", "Cash trough -1.24M in 2027-12"]);
  });
});
