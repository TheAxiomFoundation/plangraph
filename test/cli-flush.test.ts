import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { parsePlanText } from '../src/parse.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const plan = (count: number) => ({
  name: 'Piped report', calendar: { startYear: 2026, startMonth: 1, horizonMonths: 12, fundingYearStartMonth: 0 },
  circles: ['work'], escalation: { rate: 0, basis: 'A' },
  seats: [{ id: 'person', title: 'Person', loadedAnnual: 0, costBasis: 'A', hireMonths: [0], capacityFte: 1, fallback: null }],
  items: Array.from({ length: count }, (_, i) => ({ id: `task-${String(i).padStart(5, '0')}`, lane: 'work', label: `Task ${i}`, circle: 'work',
    earliest: 0, duration: 1, standing: false, underway: false, predecessors: [], demands: [{ seat: 'person', fte: 0.0001, basis: 'A' }] })),
  funding: [], streams: [], nonLabor: [], scenarios: [{ id: 'base', name: 'Base', gist: 'Flush a large report', level: false }],
});

it('flushes a large Node report to a pipe before exiting', () => {
  const directory = mkdtempSync(join(tmpdir(), 'plangraph-flush-'));
  try {
    const entry = join(directory, 'cli.mjs');
    const built = spawnSync('bun', ['build', join(root, 'src/cli.ts'), '--target=node', '--outfile', entry], { encoding: 'utf8' });
    expect(built.status, built.stderr).toBe(0);
    const file = join(directory, 'input.json');
    writeFileSync(file, JSON.stringify(plan(3000)));
    const result = spawnSync('node', [entry, 'check', file, '--json'], { encoding: 'utf8', maxBuffer: 10_000_000, timeout: 30_000 });
    expect(result.status, result.stderr.slice(0, 500)).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(65_536);
    const json = JSON.parse(result.stdout);
    expect(json.scenarios[0].items).toHaveLength(3000);
    expect(json.scenarios[0].items.at(-1).id).toBe('task-02999');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

it('rejects escalation that would alternate payroll between positive and negative', () => {
  const input = plan(1);
  input.escalation.rate = -2;
  expect(() => parsePlanText(JSON.stringify(input))).toThrow(/at least -1/);
  input.escalation.rate = -0.05;
  expect(() => parsePlanText(JSON.stringify(input))).not.toThrow();
});
