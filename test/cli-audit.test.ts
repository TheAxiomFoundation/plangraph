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
});
