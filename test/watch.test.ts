import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "src/cli.ts");

const plan = (name: string) => ({
  name,
  calendar: { startYear: 2027, startMonth: 1, horizonMonths: 6, fundingYearStartMonth: 0 },
  circles: ["a"],
  escalation: { rate: 0, basis: "A" },
  seats: [{ id: "x", title: "X", loadedAnnual: 120_000, costBasis: "A", hireMonths: [0], capacityFte: 1, fallback: null }],
  items: [{ id: "i", lane: "l", label: "Item", circle: "a", earliest: 0, duration: 2, standing: false, underway: false, predecessors: [], demands: [{ seat: "x", fte: 0.5, basis: "A" }] }],
  streams: [],
  funding: [],
  nonLabor: [],
});

describe("plangraph watch", () => {
  it("re-runs the check when the plan file is saved, and keeps running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plangraph-watch-"));
    const file = join(dir, "plan.json");
    writeFileSync(file, JSON.stringify(plan("first")));
    const child = spawn("bun", [cli, "watch", file], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    const reports = () => (out.match(/✓ no errors/g) ?? []).length;
    const until = (n: number, ms: number) =>
      new Promise<boolean>((done) => {
        const started = Date.now();
        const tick = () => (reports() >= n ? done(true) : Date.now() - started > ms ? done(false) : setTimeout(tick, 50));
        tick();
      });
    try {
      expect(await until(1, 15_000), out).toBe(true);
      expect(out).toMatch(/first/);
      expect(child.exitCode).toBeNull(); // still watching
      writeFileSync(file, JSON.stringify(plan("second")));
      expect(await until(2, 15_000), out).toBe(true);
      expect(out).toMatch(/second/);
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill("SIGINT");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
