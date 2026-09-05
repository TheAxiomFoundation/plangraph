import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePortfolioText, project, projectionTables, projectionCsv, csvCell } from '../src/portfolio/index.js';

const input = () => parsePortfolioText(readFileSync(new URL('../examples/portfolio.json', import.meta.url), 'utf8'));

describe('portable projection reports', () => {
  it('preserves independently known dates, integer-cent economics and unknown cash in export rows', () => {
    const p = project(input(), 'baseline', 0);
    const tables = projectionTables(p);
    const work = tables.find(t => t.name === 'Work')!;
    const build = work.rows.find(row => row[0] === 'build')!;
    expect(build[work.columns.indexOf('Start')]).toBe('2026-03');
    expect(build[work.columns.indexOf('Forecast completion exclusive')]).toBe('2026-05');
    expect(build[work.columns.indexOf('Source target exclusive')]).toBe('2026-04');
    const money = tables.find(t => t.name === 'Monthly costs')!;
    // Alex is paid six months; Taylor four. Coverage is 50% of Alex only.
    expect(money.rows.reduce((sum, row) => sum + Number(row[1]), 0)).toBe(10_000);
    expect(money.rows.reduce((sum, row) => sum + Number(row[4]), 0)).toBe(3_000);
    expect(money.rows.every(row => row[8] === null)).toBe(true);
    expect(tables.find(t => t.name === 'Projection')!.rows).toContainEqual(['Fingerprint', p.fingerprint]);
    expect(projectionCsv(p)).toContain(`"${p.fingerprint}","baseline","2026-01"`);
  });

  it('quotes untrusted labels without allowing spreadsheet formulas or malformed CSV', () => {
    expect(csvCell('=HYPERLINK("https://example.org")')).toBe('"\'=HYPERLINK(""https://example.org"")"');
    expect(csvCell('\t+SUM(A1:A2)')).toBe('"\'\t+SUM(A1:A2)"');
    expect(csvCell('a,b\r\n"c"')).toBe('"a,b\r\n""c"""');
    expect(csvCell(-1.25)).toBe('"-1.25"');
    expect(csvCell(null)).toBe('""');
    expect(() => projectionCsv(project(input(), 'baseline', 0), 'missing')).toThrow('Unknown projection table');
  });
  it('exports unstaffed fixed demand without attributing it to the planned person', () => {
    const model = input();
    model.work.find(work => work.id === 'operations')!.demands[0].eligibleResourceIds = ['taylor'];
    const p = project(model, 'baseline', 0), tables = projectionTables(p);
    const bookings = tables.find(table => table.name === 'Bookings')!;
    const unassigned = bookings.rows.filter(row => row[2] === 'Unassigned demand');
    expect(unassigned.map(row => [row[3],row[4],row[5]])).toEqual([['2026-01',.25,.25],['2026-02',.25,.25]]);
    expect(projectionCsv(p,'Bookings')).toContain('"Unassigned demand"');
    expect(p.resourceMonths.find(row => row.resourceId === 'taylor' && row.month === 0)?.bookedFte).toBe(0);
    expect(tables.find(table => table.name === 'Projection')!.rows.some(row => row[0] === 'Fingerprint definition' && String(row[1]).includes('not a digest of output bytes'))).toBe(true);
  });
});
