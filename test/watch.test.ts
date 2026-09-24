import { execFileSync, spawn, spawnSync } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
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

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Starts `plangraph watch <file>` and collects everything it prints. */
const startWatch = (file: string) => {
  const child = spawn("bun", [cli, "watch", file], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", (d) => (out += d.toString()));
  const reports = () => (out.match(/✓ no errors/g) ?? []).length;
  const until = async (ready: () => boolean, ms: number) => {
    const started = Date.now();
    while (!ready()) {
      if (Date.now() - started > ms) return false;
      await pause(50);
    }
    return true;
  };
  return { child, out: () => out, reports, until };
};

/** Opens a FIFO for writing once a reader has it open; until then a non-blocking open fails with ENXIO. */
const openOnceRead = async (fifo: string, ms: number): Promise<number> => {
  const started = Date.now();
  for (;;) {
    try {
      return openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENXIO" || Date.now() - started > ms) throw e;
      await pause(20);
    }
  }
};

describe("plangraph watch", () => {
  it("re-runs the check when the plan file is saved, and keeps running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plangraph-watch-"));
    const file = join(dir, "plan.json");
    writeFileSync(file, JSON.stringify(plan("first")));
    const watcher = startWatch(file);
    try {
      expect(await watcher.until(() => /watching /.test(watcher.out()), 15_000), watcher.out()).toBe(true);
      expect(watcher.out()).toMatch(/plangraph · first/);
      // The first check reads the plan under a live watcher; that read must not queue a re-run.
      await pause(1_000);
      expect(watcher.reports(), watcher.out()).toBe(1);
      expect(watcher.child.exitCode).toBeNull(); // still watching
      writeFileSync(file, JSON.stringify(plan("second")));
      expect(await watcher.until(() => watcher.reports() >= 2, 15_000), watcher.out()).toBe(true);
      expect(watcher.out()).toMatch(/plangraph · second/);
      expect(watcher.child.exitCode).toBeNull();
    } finally {
      watcher.child.kill("SIGINT");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);

  // The plan starts as a FIFO, so the first check blocks in its read until the test feeds it: the
  // save below lands while that check is still running, whatever the machine's load. On Linux a
  // watcher started only after the first check never sees that save, so this fails there. macOS
  // has reported a plan.json event to a watcher started seconds after such a save, so there it
  // can pass either way.
  it.skipIf(process.platform === "win32")("re-runs for a save that lands while the first check is still running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plangraph-watch-"));
    const file = join(dir, "plan.json");
    execFileSync("mkfifo", [file]);
    const watcher = startWatch(file);
    let fifo: number | undefined;
    try {
      fifo = await openOnceRead(file, 15_000);
      expect(watcher.reports()).toBe(0);
      // Save the way editors that write a temporary file and rename it over the plan do.
      writeFileSync(join(dir, "plan.json.tmp"), JSON.stringify(plan("second")));
      renameSync(join(dir, "plan.json.tmp"), file);
      const first = Buffer.from(JSON.stringify(plan("first")));
      expect(writeSync(fifo, first)).toBe(first.length);
      closeSync(fifo);
      fifo = undefined;
      expect(await watcher.until(() => watcher.reports() >= 1, 15_000), watcher.out()).toBe(true);
      expect(watcher.out()).toMatch(/plangraph · first/);
      expect(await watcher.until(() => watcher.reports() >= 2, 15_000), watcher.out()).toBe(true);
      expect(watcher.out()).toMatch(/plangraph · first[\s\S]*plangraph · second/);
      expect(watcher.child.exitCode).toBeNull();
    } finally {
      if (fifo !== undefined) closeSync(fifo);
      watcher.child.kill("SIGINT");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);

  it("exits 1 with one line when the plan's directory cannot be watched", () => {
    const dir = mkdtempSync(join(tmpdir(), "plangraph-watch-"));
    try {
      const result = spawnSync("bun", [cli, "watch", join(dir, "missing", "plan.json")], {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trimEnd().split("\n")).toEqual([expect.stringMatching(/^plangraph: ENOENT\b.*watch/)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
