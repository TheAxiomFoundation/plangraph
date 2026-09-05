import { parse as parseYaml } from 'yaml';
import { PORTFOLIO_SCHEMA, type Portfolio, type ValidationIssue } from './model.js';

export class PortfolioValidationError extends Error {
  constructor(public readonly issues: ValidationIssue[]) {
    super(issues.map(issue => `${issue.path}: ${issue.message}`).join('\n'));
    this.name = 'PortfolioValidationError';
  }
}
type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Structural validation is side-effect free. Projection additionally validates evidence against as-of. */
export function validatePortfolio(input: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fail = (path: string, message: string) => { issues.push({ path, message }); };
  const object = (value: unknown, path: string, keys: string[]): Obj => {
    if (!isObject(value)) { fail(path, 'Expected an object'); return {}; }
    for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${path}.${key}`, 'Unknown field');
    return value;
  };
  const string = (value: unknown, path: string, optional = false) => {
    if (optional && value === undefined) return;
    if (typeof value !== 'string' || value.trim().length === 0) fail(path, 'Expected a nonempty string');
  };
  const num = (value: unknown, path: string, opts: { optional?: boolean; integer?: boolean; min?: number; max?: number } = {}) => {
    if (opts.optional && value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || (opts.integer && !Number.isSafeInteger(value)) || value < (opts.min ?? -Infinity) || value > (opts.max ?? Infinity)) fail(path, `Expected ${opts.integer ? 'a safe integer' : 'a finite number'}${opts.min !== undefined ? ` >= ${opts.min}` : ''}${opts.max !== undefined ? ` <= ${opts.max}` : ''}`);
  };
  const bool = (value: unknown, path: string, optional = true) => { if (!(optional && value === undefined) && typeof value !== 'boolean') fail(path, 'Expected a boolean'); };
  const choice = (value: unknown, path: string, values: string[], optional = false) => { if (!(optional && value === undefined) && !values.includes(value as string)) fail(path, `Expected one of ${values.join(', ')}`); };
  const list = (value: unknown, path: string, optional = false): unknown[] => {
    if (optional && value === undefined) return [];
    if (!Array.isArray(value)) { fail(path, 'Expected an array'); return []; }
    return value;
  };
  const strings = (value: unknown, path: string, optional = false): string[] => {
    const values = list(value, path, optional);
    const seen = new Set<string>();
    values.forEach((v, i) => { string(v, `${path}[${i}]`); if (typeof v === 'string') { if (seen.has(v)) fail(`${path}[${i}]`, `Duplicate value ${v}`); seen.add(v); } });
    return values.filter((v): v is string => typeof v === 'string');
  };
  const cents = (value: unknown, path: string, optional = false) => num(value, path, { optional, integer: true, min: 0 });
  const month = (value: unknown, path: string, optional = false) => num(value, path, { optional, integer: true });
  const fte = (value: unknown, path: string, optional = false) => num(value, path, { optional, min: 0 });
  const serializable = (value: unknown, path: string, ancestors = new Set<unknown>()) => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || value === undefined) return;
    if (typeof value === 'number') { num(value, path); return; }
    if (typeof value !== 'object' || ancestors.has(value)) { fail(path, 'Expected acyclic JSON metadata'); return; }
    const next = new Set(ancestors).add(value);
    Object.entries(value).forEach(([key, child]) => serializable(child, `${path}.${key}`, next));
  };
  const p = object(input, '$', ['schemaVersion','id','label','sourceRevision','calendar','sources','programs','resources','pools','work','costs','funding','scenarios','cash','metadata']);
  if (p.schemaVersion !== PORTFOLIO_SCHEMA) fail('$.schemaVersion', `Expected ${PORTFOLIO_SCHEMA}`);
  for (const key of ['id','label','sourceRevision']) string(p[key], `$.${key}`);
  const calendar = object(p.calendar, '$.calendar', ['startMonth','horizonMonths']);
  if (typeof calendar.startMonth !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(calendar.startMonth)) fail('$.calendar.startMonth', 'Expected YYYY-MM');
  num(calendar.horizonMonths, '$.calendar.horizonMonths', { integer: true, min: 1, max: 1200 });
  const tables = new Map<string, Map<string, Obj>>();
  const rows = new Map<string, unknown[]>();
  for (const key of ['sources','programs','resources','pools','work','costs','funding','scenarios']) {
    const values = list(p[key], `$.${key}`); rows.set(key, values);
    const table = new Map<string, Obj>(); tables.set(key, table);
    values.forEach((v, i) => {
      if (!isObject(v)) { fail(`$.${key}[${i}]`, 'Expected an object'); return; }
      string(v.id, `$.${key}[${i}].id`);
      if (typeof v.id === 'string') { if (table.has(v.id)) fail(`$.${key}[${i}].id`, `Duplicate ID ${v.id}`); table.set(v.id, v); }
    });
  }
  const ref = (value: unknown, path: string, table: string) => { string(value, path); if (typeof value === 'string' && !tables.get(table)!.has(value)) fail(path, `Unknown ${table} ID ${value}`); };
  const refs = (value: unknown, path: string, table: string, optional = false): string[] => { const ids = strings(value, path, optional); ids.forEach((id, i) => ref(id, `${path}[${i}]`, table)); return ids; };
  const sources = (value: unknown, path: string, evidence = false) => { const ids = refs(value, path, 'sources'); if (evidence && ids.length === 0) fail(path, 'Actual evidence requires at least one source reference'); };
  const profile = (value: unknown, path: string) => { if (value !== undefined) { const values = list(value, path); if (!values.length) fail(path, 'Profile must not be empty'); values.forEach((v, i) => fte(v, `${path}[${i}]`)); } };
  const events = (value: unknown, path: string, kind: 'capacity' | 'cost', optional = false) => {
    const seen = new Set<number>();
    list(value, path, optional).forEach((v, i) => {
      const at = `${path}[${i}]`, key = kind === 'capacity' ? 'capacityFte' : 'monthlyCents';
      const event = object(v, at, ['fromMonth',key,'sourceIds']); month(event.fromMonth, `${at}.fromMonth`);
      if (typeof event.fromMonth === 'number') { if (seen.has(event.fromMonth)) fail(`${at}.fromMonth`, 'Duplicate effective month'); seen.add(event.fromMonth); }
      if (kind === 'cost') cents(event[key], `${at}.${key}`); else num(event[key], `${at}.${key}`, { min: 0, max: 1 });
      sources(event.sourceIds, `${at}.sourceIds`);
    });
  };
  rows.get('sources')!.forEach((v, i) => { const at = `$.sources[${i}]`, row = object(v, at, ['id','label','url','basis','note']); string(row.label, `${at}.label`); for (const key of ['url','basis','note']) string(row[key], `${at}.${key}`, true); });
  rows.get('programs')!.forEach((v, i) => { const at = `$.programs[${i}]`, row = object(v, at, ['id','label','financialCompleteness','note']); string(row.label, `${at}.label`); string(row.note, `${at}.note`, true); choice(row.financialCompleteness, `${at}.financialCompleteness`, ['complete','partial','unknown']); });
  rows.get('resources')!.forEach((v, i) => {
    const at = `$.resources[${i}]`, row = object(v, at, ['id','label','programId','employment','startMonth','endMonth','capacityFte','capacityEvents','costEvents','skills','sourceIds','note']);
    string(row.label, `${at}.label`); ref(row.programId, `${at}.programId`, 'programs'); choice(row.employment, `${at}.employment`, ['existing','planned']);
    month(row.startMonth, `${at}.startMonth`); month(row.endMonth, `${at}.endMonth`, true);
    if (typeof row.startMonth === 'number' && typeof row.endMonth === 'number' && row.endMonth <= row.startMonth) fail(`${at}.endMonth`, 'End must be after start');
    num(row.capacityFte, `${at}.capacityFte`, { min: 0, max: 1 }); events(row.capacityEvents, `${at}.capacityEvents`, 'capacity', true); events(row.costEvents, `${at}.costEvents`, 'cost');
    strings(row.skills, `${at}.skills`, true); sources(row.sourceIds, `${at}.sourceIds`); string(row.note, `${at}.note`, true);
  });
  rows.get('pools')!.forEach((v, i) => { const at = `$.pools[${i}]`, row = object(v, at, ['id','label','resourceIds','sourceIds']); string(row.label, `${at}.label`); refs(row.resourceIds, `${at}.resourceIds`, 'resources'); sources(row.sourceIds, `${at}.sourceIds`); });
  rows.get('work')!.forEach((v, i) => {
    const at = `$.work[${i}]`, row = object(v, at, ['id','label','programId','mode','earliestStartMonth','durationMonths','fixedStartMonth','targetFinishMonth','dependencies','priority','demands','effortFteMonths','minStaffingFte','maxStaffingFte','fixed','enabled','owner','unresolvedReason','actuals','sourceIds','relatedWorkIds','metadata']);
    string(row.label, `${at}.label`); ref(row.programId, `${at}.programId`, 'programs'); choice(row.mode, `${at}.mode`, ['fixed','duration','effort','ongoing','milestone']);
    num(row.earliestStartMonth, `${at}.earliestStartMonth`, { integer: true, min: 0 }); month(row.targetFinishMonth, `${at}.targetFinishMonth`, true); month(row.fixedStartMonth, `${at}.fixedStartMonth`, true);
    num(row.priority, `${at}.priority`, { integer: true }); bool(row.fixed, `${at}.fixed`); bool(row.enabled, `${at}.enabled`);
    for (const key of ['owner','unresolvedReason']) string(row[key], `${at}.${key}`, true);
    sources(row.sourceIds, `${at}.sourceIds`); refs(row.relatedWorkIds, `${at}.relatedWorkIds`, 'work', true); serializable(row.metadata, `${at}.metadata`);
    if (row.mode === 'fixed' || row.mode === 'duration') num(row.durationMonths, `${at}.durationMonths`, { integer: true, min: 1 });
    else num(row.durationMonths, `${at}.durationMonths`, { optional: true, integer: true, min: 1 });
    if (row.mode === 'fixed' || (row.mode === 'ongoing' && row.fixed)) month(row.fixedStartMonth, `${at}.fixedStartMonth`);
    if (row.mode === 'effort') {
      num(row.effortFteMonths, `${at}.effortFteMonths`, { min: Number.MIN_VALUE }); num(row.minStaffingFte, `${at}.minStaffingFte`, { min: Number.MIN_VALUE }); num(row.maxStaffingFte, `${at}.maxStaffingFte`, { min: Number.MIN_VALUE });
      if (typeof row.minStaffingFte === 'number' && typeof row.maxStaffingFte === 'number' && row.minStaffingFte > row.maxStaffingFte) fail(`${at}.maxStaffingFte`, 'Maximum must be at least minimum staffing');
    } else for (const key of ['effortFteMonths','minStaffingFte','maxStaffingFte']) fte(row[key], `${at}.${key}`, true);
    const dependencyKeys = new Set<string>();
    list(row.dependencies, `${at}.dependencies`).forEach((d, j) => {
      const dp = `${at}.dependencies[${j}]`, dep = object(d, dp, ['workId','on']); ref(dep.workId, `${dp}.workId`, 'work'); choice(dep.on, `${dp}.on`, ['start','finish'], true);
      const key = `${dep.workId}:${dep.on ?? 'finish'}`; if (dependencyKeys.has(key)) fail(dp, 'Duplicate dependency'); dependencyKeys.add(key);
    });
    const demandIds = new Set<string>();
    const demands = list(row.demands, `${at}.demands`);
    if (row.mode === 'milestone' && demands.length) fail(`${at}.demands`, 'Milestones cannot consume capacity');
    if (row.mode === 'effort' && demands.length === 0) fail(`${at}.demands`, 'Effort work requires an eligible demand');
    demands.forEach((d, j) => {
      const dp = `${at}.demands[${j}]`, demand = object(d, dp, ['id','eligibleResourceIds','requiredSkills','fte','profile','components','sourceIds']);
      string(demand.id, `${dp}.id`); if (typeof demand.id === 'string') { if (demandIds.has(demand.id)) fail(`${dp}.id`, 'Duplicate demand ID'); demandIds.add(demand.id); }
      refs(demand.eligibleResourceIds, `${dp}.eligibleResourceIds`, 'resources'); strings(demand.requiredSkills, `${dp}.requiredSkills`, true); fte(demand.fte, `${dp}.fte`); profile(demand.profile, `${dp}.profile`); sources(demand.sourceIds, `${dp}.sourceIds`);
      const componentIds = new Set<string>();
      list(demand.components, `${dp}.components`).forEach((c, k) => { const cp = `${dp}.components[${k}]`, component = object(c, cp, ['id','fte','profile','basis','sourceIds','label']); string(component.id, `${cp}.id`); string(component.basis, `${cp}.basis`); string(component.label, `${cp}.label`, true); fte(component.fte, `${cp}.fte`); profile(component.profile, `${cp}.profile`); sources(component.sourceIds, `${cp}.sourceIds`); if (typeof component.id === 'string') { if (componentIds.has(component.id)) fail(`${cp}.id`, 'Duplicate component ID'); componentIds.add(component.id); } });
    });
    if (row.actuals !== undefined) {
      const ap = `${at}.actuals`, actual = object(row.actuals, ap, ['startMonth','completionMonth','bookings','remainingEffort','sourceIds']); month(actual.startMonth, `${ap}.startMonth`, true); month(actual.completionMonth, `${ap}.completionMonth`, true); fte(actual.remainingEffort, `${ap}.remainingEffort`, true); sources(actual.sourceIds, `${ap}.sourceIds`, true);
      if (typeof actual.startMonth === 'number' && typeof actual.completionMonth === 'number' && actual.completionMonth < actual.startMonth) fail(`${ap}.completionMonth`, 'Completion cannot precede actual start');
      list(actual.bookings, `${ap}.bookings`, true).forEach((b, j) => { const bp = `${ap}.bookings[${j}]`, booking = object(b, bp, ['resourceId','demandId','month','fte','sourceIds']); ref(booking.resourceId, `${bp}.resourceId`, 'resources'); num(booking.month, `${bp}.month`, { integer: true, min: 0 }); num(booking.fte, `${bp}.fte`, { min: Number.MIN_VALUE }); sources(booking.sourceIds, `${bp}.sourceIds`, true); string(booking.demandId, `${bp}.demandId`, true); if (typeof booking.demandId === 'string' && !demandIds.has(booking.demandId)) fail(`${bp}.demandId`, 'Unknown demand ID'); });
    }
  });
  rows.get('costs')!.forEach((v, i) => {
    const at = `$.costs[${i}]`, row = object(v, at, ['id','label','programId','startMonth','endMonth','kind','monthlyCents','totalCents','resourceIds','costEvents','sourceIds']);
    string(row.label, `${at}.label`); ref(row.programId, `${at}.programId`, 'programs'); month(row.startMonth, `${at}.startMonth`); month(row.endMonth, `${at}.endMonth`); choice(row.kind, `${at}.kind`, ['recurring','fixed-total']);
    if (typeof row.startMonth === 'number' && typeof row.endMonth === 'number' && row.endMonth <= row.startMonth) fail(`${at}.endMonth`, 'End must be after start');
    if (row.kind === 'fixed-total') { cents(row.totalCents, `${at}.totalCents`); if (row.resourceIds !== undefined || row.monthlyCents !== undefined || row.costEvents !== undefined) fail(at, 'Fixed-total cost cannot also have resource IDs or recurring amounts'); }
    else { cents(row.monthlyCents, `${at}.monthlyCents`, row.costEvents !== undefined); events(row.costEvents, `${at}.costEvents`, 'cost', true); if (row.totalCents !== undefined) fail(`${at}.totalCents`, 'Recurring cost cannot have a fixed total'); }
    refs(row.resourceIds, `${at}.resourceIds`, 'resources', true); sources(row.sourceIds, `${at}.sourceIds`);
  });
  rows.get('funding')!.forEach((v, i) => {
    const at = `$.funding[${i}]`, row = object(v, at, ['id','label','sourceIds','enabled','note','kind','status','startMonth','endMonth','targetResourceIds','targetCostIds','amountCents','share','month']);
    string(row.label, `${at}.label`); string(row.note, `${at}.note`, row.kind !== 'quote'); sources(row.sourceIds, `${at}.sourceIds`); bool(row.enabled, `${at}.enabled`); choice(row.kind, `${at}.kind`, ['coverage','commitment','receipt','quote']);
    if (row.kind === 'coverage') {
      choice(row.status, `${at}.status`, ['proposed','committed']); month(row.startMonth, `${at}.startMonth`); month(row.endMonth, `${at}.endMonth`);
      if (typeof row.startMonth === 'number' && typeof row.endMonth === 'number' && row.endMonth <= row.startMonth) fail(`${at}.endMonth`, 'End must be after start');
      const ids = [...refs(row.targetResourceIds, `${at}.targetResourceIds`, 'resources', true), ...refs(row.targetCostIds, `${at}.targetCostIds`, 'costs', true)];
      if (ids.length === 0) fail(at, 'Coverage requires explicit cost/resource restrictions');
      if ((row.amountCents === undefined) === (row.share === undefined)) fail(at, 'Coverage requires exactly one of amountCents or share');
      cents(row.amountCents, `${at}.amountCents`, true);
      if (row.share !== undefined && (typeof row.share !== 'string' || !/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(row.share))) fail(`${at}.share`, 'Expected an exact decimal string in [0,1]');
    } else { cents(row.amountCents, `${at}.amountCents`); month(row.month, `${at}.month`, row.kind !== 'receipt'); }
  });
  rows.get('scenarios')!.forEach((v, i) => {
    const at = `$.scenarios[${i}]`, row = object(v, at, ['id','label','description','resources','work','funding']); string(row.label, `${at}.label`); string(row.description, `${at}.description`, true);
    for (const [key, idKey, table, fields] of [['resources','resourceId','resources',['startMonth','remove','capacityFte']],['work','workId','work',['include','effortMultiplier','demandMultiplier','durationMultiplier']],['funding','fundingId','funding',['include','receiptMonth']]] as const) {
      const seen = new Set<string>();
      list(row[key], `${at}.${key}`, true).forEach((o, j) => {
        const op = `${at}.${key}[${j}]`, override = object(o, op, [idKey,...fields]); ref(override[idKey], `${op}.${idKey}`, table);
        if (typeof override[idKey] === 'string') { if (seen.has(override[idKey])) fail(`${op}.${idKey}`, 'Duplicate override'); seen.add(override[idKey]); }
        for (const field of fields) {
          if (field === 'startMonth' || field === 'receiptMonth') month(override[field], `${op}.${field}`, true);
          else if (field === 'remove' || field === 'include') bool(override[field], `${op}.${field}`);
          else num(override[field], `${op}.${field}`, { optional: true, min: field === 'durationMultiplier' || field === 'effortMultiplier' ? Number.MIN_VALUE : 0, max: field === 'capacityFte' ? 1 : undefined });
        }
        if (key === 'funding' && override.receiptMonth !== undefined && tables.get('funding')!.get(override.fundingId as string)?.kind !== 'receipt') fail(`${op}.receiptMonth`, 'Only cash receipts have a receipt month');
      });
    }
  });
  if (p.cash !== undefined) { const cash = object(p.cash, '$.cash', ['openingBalanceCents','receiptsKnown']); cents(cash.openingBalanceCents, '$.cash.openingBalanceCents', true); bool(cash.receiptsKnown, '$.cash.receiptsKnown', false); }
  serializable(p.metadata, '$.metadata');
  // Iterative traversal avoids a call-stack limit for large, otherwise valid DAGs.
  const work = tables.get('work')!, indegrees = new Map<string, number>(), successors = new Map<string, string[]>();
  for (const [id, row] of work) {
    const deps = Array.isArray(row.dependencies) ? row.dependencies.filter(isObject).map(dep => dep.workId).filter((id): id is string => typeof id === 'string' && work.has(id)) : [];
    indegrees.set(id, deps.length);
    for (const dep of deps) successors.set(dep, [...(successors.get(dep) ?? []), id]);
  }
  const ready = [...indegrees].filter(([, n]) => n === 0).map(([id]) => id);
  for (let i = 0; i < ready.length; i++) for (const next of successors.get(ready[i]) ?? []) { const count = indegrees.get(next)! - 1; indegrees.set(next, count); if (count === 0) ready.push(next); }
  if (ready.length < work.size) fail('$.work.dependencies', `Dependency cycle affects: ${[...indegrees].filter(([, n]) => n > 0).map(([id]) => id).sort().join(', ')}`);
  return issues;
}

export function parsePortfolioText(text: string): Portfolio {
  let value: unknown;
  try { value = parseYaml(text, { maxAliasCount: 100, uniqueKeys: true }); }
  catch (error) { throw new PortfolioValidationError([{ path: '$', message: `Cannot parse portfolio: ${error instanceof Error ? error.message : String(error)}` }]); }
  const issues = validatePortfolio(value);
  if (issues.length) throw new PortfolioValidationError(issues);
  return value as Portfolio;
}
