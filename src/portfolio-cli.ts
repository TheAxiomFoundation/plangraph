#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { parsePortfolioText, project, projectionCsv } from './portfolio/index.js';

const usage = 'usage: plangraph-portfolio <portfolio.json|yaml> --scenario <id> --as-of <YYYY-MM|month-index> [--format json|csv] [--table Work] [--out file]';

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(`${usage}\n`); return; }
  const file = args[0];
  if (!file || file.startsWith('--')) throw new Error(usage);
  const options = new Map<string, string>();
  const allowed = new Set(['--scenario', '--as-of', '--format', '--table', '--out']);
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!allowed.has(key) || options.has(key) || !value || value.startsWith('--')) throw new Error(`Invalid or repeated option ${key}. ${usage}`);
    options.set(key, value);
  }
  const scenario = options.get('--scenario');
  const date = options.get('--as-of');
  if (!scenario || !date) throw new Error(usage);
  const input = parsePortfolioText(await readFile(file, 'utf8'));
  let month: number;
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(date)) {
    const [year, m] = date.split('-').map(Number);
    const [startYear, startMonth] = input.calendar.startMonth.split('-').map(Number);
    month = (year - startYear) * 12 + m - startMonth;
  } else if (/^\d+$/.test(date)) month = Number(date);
  else throw new Error('--as-of must be YYYY-MM or a nonnegative month index');
  const result = project(input, scenario, month);
  const format = options.get('--format') ?? 'json';
  if (format !== 'json' && format !== 'csv') throw new Error('--format must be json or csv');
  if (format !== 'csv' && options.has('--table')) throw new Error('--table requires --format csv');
  const output = format === 'json' ? `${JSON.stringify(result, null, 2)}\n` : projectionCsv(result, options.get('--table'));
  const path = options.get('--out');
  if (path) await writeFile(path, output);
  else await new Promise<void>((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
}

main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`plangraph-portfolio: ${String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ')}\n`);
  process.exitCode = 2;
});
