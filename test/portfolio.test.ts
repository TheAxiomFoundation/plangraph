import { describe, expect, it } from 'vitest';
import { stringify as yaml } from 'yaml';
import { project, parsePortfolioText, validatePortfolio, halfUp, distributeFixedTotal, decimalShareCents, type Portfolio, type Resource, type Work, type Demand } from '../src/portfolio/index.js';
import { canonicalStringify, contentFingerprint } from '../src/portfolio/canonical.js';

const sourceIds = ['s'];
const resource = (id: string, extra: Partial<Resource> = {}): Resource => ({ id, label: id, programId: 'p', employment: 'existing', startMonth: 0, capacityFte: 1, costEvents: [{ fromMonth: 0, monthlyCents: 10_000, sourceIds }], sourceIds, ...extra });
const demand = (id: string, ids: string[], fte: number, extra: Partial<Demand> = {}): Demand => ({ id, eligibleResourceIds: ids, fte, components: [{ id: `${id}:component`, fte, basis: 'assumed', sourceIds }], sourceIds, ...extra });
const work = (id: string, extra: Partial<Work> = {}): Work => ({ id, label: id, programId: 'p', mode: 'duration', earliestStartMonth: 0, durationMonths: 1, dependencies: [], priority: 0, demands: [demand('d', ['r'], 1)], sourceIds, ...extra });
const portfolio = (extra: Partial<Portfolio> = {}): Portfolio => ({ schemaVersion: 'plangraph-portfolio/v1', id: 'test', label: 'Fixture', sourceRevision: 'fixture-v1', calendar: { startMonth: '2026-01', horizonMonths: 6 }, sources: [{ id: 's', label: 'Fixture source' }], programs: [{ id: 'p', label: 'Program', financialCompleteness: 'complete' }], resources: [resource('r')], pools: [], work: [], costs: [], funding: [], scenarios: [{ id: 'base', label: 'Baseline' }], ...extra });
const item = (p: ReturnType<typeof project>, id: string) => p.work.find(work => work.id === id)!;
const reverseCollections = (value: unknown, key = ''): unknown => Array.isArray(value) ? (key === 'profile' ? value : [...value].reverse()).map(child => reverseCollections(child)) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([name, child]) => [name, reverseCollections(child, name)])) : value;

describe('portfolio monthly scheduling', () => {
  it('reserves fixed work before movable duration and retains unmet demand without inventing overload', () => {
    const input = portfolio({ work: [work('delivery', { priority: -100, durationMonths: 2 }), work('standing', { mode: 'fixed', fixedStartMonth: 1, durationMonths: 2 }), work('extra', { mode: 'fixed', fixedStartMonth: 1, demands: [demand('d', ['r'], .25)] })] });
    const result = project(input, 'base', 0);
    expect([item(result, 'delivery').startMonth, item(result, 'delivery').completionMonth]).toEqual([3, 5]);
    expect(result.resourceMonths.find(row => row.month === 1)?.bookedFte).toBe(1);
    expect(result.bookings.filter(row => row.month === 1 && row.resourceId === null)).toMatchObject([{ kind:'fixed',fte:.25,shortfallFte:.25 }]);
    expect(result.findings.some(row => row.code === 'fixed-shortage' && row.month === 1)).toBe(true);
    expect(result.findings.some(row => row.code === 'fixed-overload')).toBe(false);
    expect(project(reverseCollections(input) as Portfolio, 'base', 0)).toEqual(result);
  });
  it('assigns restricted demands first, splits capacity by stable resource ID, and is order-independent', () => {
    const input = portfolio({ resources: [resource('a'), resource('b')], work: [work('fixed', { mode: 'fixed', fixedStartMonth: 0, demands: [demand('d', ['a'], .25)] }), work('delivery', { demands: [demand('narrow', ['b'], .5), demand('flex-1', ['a','b'], 1), demand('flex-2', ['a','b'], .25)] })] });
    const result = project(input, 'base', 0);
    expect(item(result, 'delivery').bookings.map(row => [row.demandId, row.resourceId, row.month, row.fte])).toEqual([['flex-1','a',0,.75],['flex-1','b',0,.25],['flex-2','b',0,.25],['narrow','b',0,.5]]);
    expect(project(reverseCollections(input) as Portfolio, 'base', 0)).toEqual(result);
  });
  it('rolls back failed candidate reservations atomically', () => {
    const result = project(portfolio({ resources: [resource('a'), resource('b')], work: [work('fixed', { mode: 'fixed', fixedStartMonth: 0, demands: [demand('d', ['a'], .5)] }), work('X', { priority: -1, demands: [demand('narrow', ['b'], .75), demand('flex', ['a','b'], 1)] }), work('Y', { demands: [demand('d', ['b'], 1)] })] }), 'base', 0);
    expect([item(result, 'X').startMonth, item(result, 'Y').startMonth]).toEqual([1, 0]);
    expect(item(result, 'X').bookings.every(row => row.month === 1)).toBe(true);
  });
  it('uses priority among ready cross-program siblings without pulling by dependent ID', () => {
    const input = portfolio({ programs: [{ id: 'p', label: 'Axiom', financialCompleteness: 'complete' },{ id: 'family', label: 'Family', financialCompleteness: 'unknown' }], work: [work('alpha-family', { programId: 'family', priority: 3000 }), work('z-funded', { priority: -1 }), work('first-summary', { mode: 'milestone', demands: [], priority: -9999, dependencies: [{ workId: 'alpha-family' },{ workId: 'z-funded' }] })] });
    const result = project(input, 'base', 0);
    expect([item(result, 'z-funded').startMonth, item(result, 'alpha-family').startMonth, item(result, 'first-summary').completionMonth]).toEqual([0,1,2]);
  });
  it('shares a bounded founder and reserves the explicit general-executive sensitivity', () => {
    const input = portfolio({ resources: [resource('founder')], pools: [{ id: 'founders', label: 'Founders', resourceIds: ['founder'], sourceIds }], work: [work('general', { mode: 'fixed', fixedStartMonth: 0, durationMonths: 6, demands: [demand('d', ['founder'], .5)] }), work('axiom', { priority: -1, durationMonths: 2, demands: [demand('d', ['founder'], .5)] }), work('chronicle', { demands: [demand('d', ['founder'], .5)] }), work('summary', { mode: 'milestone', demands: [], dependencies: [{ workId: 'axiom' },{ workId: 'chronicle' }] })], scenarios: [{ id: 'base', label: 'Base' },{ id: 'no-general', label: 'No general reservation', work: [{ workId: 'general', include: false }] }] });
    const result = project(input, 'base', 0);
    expect([item(result, 'axiom').startMonth, item(result, 'chronicle').startMonth]).toEqual([0,2]);
    expect(Math.max(...result.resourceMonths.map(row => row.bookedFte))).toBe(1);
    expect(item(project(input, 'no-general', 0), 'chronicle').startMonth).toBe(0);
    expect(result.expenses.filter(row => row.kind === 'payroll')).toHaveLength(6);
  });
  it('preserves ongoing start semantics and never invents its completion', () => {
    const result = project(portfolio({ resources: [resource('r'), resource('service', { capacityFte: .25 })], work: [work('prep'), work('service', { mode: 'ongoing', durationMonths: undefined, demands: [demand('d', ['service'], .25)], dependencies: [{ workId: 'prep' }] }), work('consumer', { demands: [demand('d', ['r'], .5)], dependencies: [{ workId: 'service', on: 'start' }] }), work('after-service', { dependencies: [{ workId: 'service' }] })] }), 'base', 0);
    expect([item(result, 'service').startMonth, item(result, 'service').completionMonth, item(result, 'service').status]).toEqual([1,null,'ongoing']);
    expect(item(result, 'service').bookings.map(row => row.month)).toEqual([1,2,3,4,5]);
    expect([item(result, 'consumer').startMonth,item(result, 'consumer').completionMonth]).toEqual([1,2]);
    expect(item(result, 'after-service').blockers.some(row => row.message.includes('ongoing work has no finish'))).toBe(true);
  });
  it('requires every future month for movable ongoing, but retains fixed ongoing shortfalls', () => {
    const input = portfolio({ resources: [resource('r', { endMonth: 4 })], work: [work('service', { mode: 'ongoing', durationMonths: undefined })], scenarios: [{ id: 'base', label: 'Base' }] });
    const result = project(input, 'base', 0);
    expect(item(result, 'service').status).toBe('unscheduled'); expect(result.bookings).toHaveLength(0);
    expect(item(result, 'service').blockers.some(row => row.months?.includes(4))).toBe(true);
    input.work[0].fixed = true; input.work[0].fixedStartMonth = 0;
    const fixed = project(input, 'base', 0);
    expect(item(fixed, 'service').status).toBe('unresolved'); expect(fixed.bookings).toHaveLength(6);
    expect(item(fixed, 'service').startMonth).toBeNull(); expect(fixed.bookings.find(row=>row.month===4)?.shortfallFte).toBe(1);
    expect(fixed.findings.some(row => row.code === 'fixed-shortage' && row.month === 4)).toBe(true);
  });
  it('keeps partial effort after an exit and allows a final fraction below minimum', () => {
    const effort = work('E', { mode: 'effort', durationMonths: undefined, effortFteMonths: 3, minStaffingFte: 1, maxStaffingFte: 1 });
    const result = project(portfolio({ resources: [resource('r', { endMonth: 2 })], work: [effort,work('duration', { durationMonths: 3, priority: 1 })] }), 'base', 0);
    expect([item(result, 'E').status,item(result, 'E').allocatedEffortFteMonths,item(result, 'E').remainingEffortFteMonths,item(result, 'E').completionMonth]).toEqual(['partial',2,1,null]);
    expect(item(result, 'duration').bookings).toHaveLength(0);
    const fraction = project(portfolio({ work: [{ ...effort, effortFteMonths: 1.2, minStaffingFte: .5 }] }), 'base', 0);
    expect(item(fraction, 'E').bookings.map(row => row.fte)).toEqual([1,.2]); expect(item(fraction, 'E').completionMonth).toBe(2);
  });
  it('effort speeds up with more staff while duration stays elapsed-time driven', () => {
    const input = portfolio({ resources: [resource('r'),resource('s', { employment: 'planned' })], work: [work('effort', { mode: 'effort', durationMonths: undefined, effortFteMonths: 4, minStaffingFte: 1, maxStaffingFte: 2, demands: [demand('d',['r','s'],1)] })], scenarios: [{ id: 'base', label: 'Base' },{ id: 'one', label: 'One', resources: [{ resourceId: 's', remove: true }] }] });
    expect(item(project(input,'base',0),'effort').completionMonth).toBe(2);
    expect(item(project(input,'one',0),'effort').completionMonth).toBe(4);
    input.work[0] = work('duration', { durationMonths: 2, demands: [demand('d',['r','s'],1)] });
    expect(item(project(input,'base',0),'duration').completionMonth).toBe(2); expect(item(project(input,'one',0),'duration').completionMonth).toBe(2);
  });
  it('applies monthly profiles, holds the last value, and retains mixed components', () => {
    const input = portfolio({ work: [work('profile', { durationMonths: 3, demands: [demand('d',['r'], .5, { profile: [.5,.75], components: [{ id: 'assumed', fte: .25, profile: [.25,.5], basis: 'assumed', sourceIds },{ id: 'derived', fte: .25, basis: 'derived', sourceIds }] })] })], scenarios: [{ id:'base',label:'Base' },{ id:'half',label:'Half',work:[{workId:'profile',demandMultiplier:.5,durationMultiplier:1.5}] }] });
    const base = project(input,'base',0), half = project(input,'half',0);
    expect(item(base,'profile').bookings.map(row => row.fte)).toEqual([.5,.75,.75]);
    expect(item(half,'profile').bookings.map(row => row.fte)).toEqual([.25,.375,.375,.375,.375]);
    expect(item(base,'profile').bookings[1].components.map(row => [row.basis,row.fte])).toEqual([['assumed',.5],['derived',.25]]);
    expect(project(reverseCollections(input) as Portfolio,'base',0)).toEqual(base);
  });
});

describe('portfolio actuals, scenarios and source gaps', () => {
  it('preserves actual bookings while advancing as-of without manufacturing last forecast actuals', () => {
    const input = portfolio({ work: [work('E', { mode: 'effort', durationMonths: undefined, effortFteMonths: 3, minStaffingFte: 1, maxStaffingFte: 1, actuals: { startMonth: 0, bookings: [{ resourceId:'r',month:0,fte:.5,sourceIds },{ resourceId:'r',month:1,fte:.5,sourceIds }], remainingEffort:2, sourceIds } })], scenarios: [{ id:'base',label:'Base' },{ id:'half',label:'Half remainder',work:[{workId:'E',effortMultiplier:.5}] }] });
    const before = JSON.stringify(input), result = project(input,'base',2), advanced = project(input,'base',3), scaled = project(input,'half',2);
    expect(item(result,'E').completionMonth).toBe(4); expect(item(advanced,'E').completionMonth).toBe(5);
    expect(advanced.bookings.filter(row => row.kind === 'actual')).toEqual(result.bookings.filter(row => row.kind === 'actual'));
    expect(advanced.bookings.some(row => row.month === 2)).toBe(false);
    expect(scaled.bookings.filter(row => row.kind === 'actual')).toEqual(result.bookings.filter(row => row.kind === 'actual'));
    expect(item(scaled,'E').completionMonth).toBe(3); expect(JSON.stringify(input)).toBe(before);
  });
  it('keeps evidenced completions exactly at as-of invariant and leaves expired pins unresolved', () => {
    const input = portfolio({ work: [work('done',{actuals:{startMonth:0,completionMonth:2,sourceIds}}),work('pin',{mode:'fixed',fixedStartMonth:0,durationMonths:2}),work('empty',{mode:'milestone',demands:[],durationMonths:undefined})] });
    for (const asOf of [2,3,5]) expect([item(project(input,'base',asOf),'done').status,item(project(input,'base',asOf),'done').completionMonth]).toEqual(['actual-complete',2]);
    const result = project(input,'base',2);
    expect(item(result,'pin').status).toBe('unresolved'); expect(item(result,'pin').bookings).toHaveLength(0);
    expect(item(result,'empty').status).toBe('unresolved'); expect(item(result,'empty').completionMonth).toBeNull();
    const doneEffort = project(portfolio({work:[work('done',{mode:'effort',durationMonths:undefined,effortFteMonths:3,minStaffingFte:1,maxStaffingFte:1,actuals:{startMonth:0,completionMonth:2,sourceIds}})]}),'base',2);
    expect(item(doneEffort,'done').remainingEffortFteMonths).toBe(0);
  });
  it('retains original elapsed duration when actual bookings establish the start', () => {
    const input = portfolio({work:[work('started',{durationMonths:4,actuals:{bookings:[{resourceId:'r',month:0,fte:1,sourceIds}],sourceIds}})],scenarios:[{id:'base',label:'Shorter',work:[{workId:'started',durationMultiplier:.5}]}]});
    const result = project(input,'base',2);
    expect(item(result,'started').actualStartMonth).toBe(0); expect(item(result,'started').completionMonth).toBe(4);
    expect(item(result,'started').bookings.filter(row=>row.kind==='fixed').map(row=>row.month)).toEqual([2,3]);
  });
  it('rejects future or out-of-employment actuals and effort over-completion', () => {
    const cases: Partial<Work>[] = [{actuals:{startMonth:2,sourceIds}},{actuals:{completionMonth:3,sourceIds}},{actuals:{bookings:[{resourceId:'r',month:2,fte:1,sourceIds}],sourceIds}},{actuals:{bookings:[{resourceId:'r',month:0,fte:1,sourceIds:[]}],sourceIds}},{mode:'effort',effortFteMonths:1,minStaffingFte:1,maxStaffingFte:1,actuals:{bookings:[{resourceId:'r',month:0,fte:2,sourceIds}],sourceIds}}];
    for (const extra of cases) expect(() => project(portfolio({work:[work('w',extra)]}),'base',2)).toThrow();
    expect(() => project(portfolio({resources:[resource('r',{startMonth:1})],work:[work('w',{actuals:{bookings:[{resourceId:'r',month:0,fte:1,sourceIds}],sourceIds}})]}),'base',2)).toThrow(/employment/);
  });
  it('requires remaining-work evidence and never infers elapsed effort', () => {
    const result = project(portfolio({work:[work('E',{mode:'effort',durationMonths:undefined,effortFteMonths:3,minStaffingFte:1,maxStaffingFte:1,actuals:{startMonth:0,sourceIds}})]}),'base',2);
    expect(item(result,'E').status).toBe('unresolved'); expect(result.bookings).toHaveLength(0);
    const evidenced = portfolio({work:[work('E',{mode:'effort',durationMonths:undefined,effortFteMonths:3,minStaffingFte:1,maxStaffingFte:1,actuals:{startMonth:0,remainingEffort:3,sourceIds}})]});
    expect(item(project(evidenced,'base',2),'E').bookings.reduce((sum,row)=>sum+row.fte,0)).toBe(3);
    evidenced.work[0].actuals!.remainingEffort = 2;
    expect(()=>project(evidenced,'base',2)).toThrow(/minus evidenced actual bookings/);
  });
  it('retains fixed shortages as commitments while withholding infeasible completion from successors', () => {
    const input = portfolio({resources:[resource('r',{employment:'planned'})],work:[work('fixed',{mode:'fixed',fixedStartMonth:1}),work('next',{dependencies:[{workId:'fixed'}]})],scenarios:[{id:'base',label:'Removed',resources:[{resourceId:'r',remove:true}]}]});
    const result = project(input,'base',0);
    expect(item(result,'fixed').bookings).toMatchObject([{kind:'fixed',resourceId:null,fte:1,shortfallFte:1}]);
    expect(item(result,'fixed').status).toBe('unresolved'); expect(item(result,'fixed').completionMonth).toBeNull();
    expect(item(result,'next').status).toBe('unresolved'); expect(item(result,'next').bookings).toHaveLength(0);
    expect(item(result,'fixed').blockers.some(row=>row.message.includes('r (removed)'))).toBe(true);
  });
  it('keeps a pooled window unresolved when only its first month is short, without naming an unhired carrier', () => {
    const ids = ['a-unhired','z-existing'];
    const input = portfolio({resources:[resource('a-unhired',{employment:'planned',startMonth:1}),resource('z-existing')],work:[work('fixed',{mode:'fixed',fixedStartMonth:0,durationMonths:3,demands:[demand('pool',ids,2)]}),work('next',{dependencies:[{workId:'fixed'}],demands:[demand('pool',ids,1)]})]});
    const result = project(input,'base',0), fixed = item(result,'fixed');
    expect(fixed.bookings.filter(row=>row.resourceId===null)).toEqual([expect.objectContaining({month:0,demandId:'pool',kind:'fixed',fte:1,shortfallFte:1})]);
    expect(fixed.bookings.filter(row=>row.resourceId!==null).map(row=>[row.month,row.resourceId,row.fte])).toEqual([[0,'z-existing',1],[1,'a-unhired',1],[1,'z-existing',1],[2,'a-unhired',1],[2,'z-existing',1]]);
    expect(fixed.allocatedEffortFteMonths).toBe(6);
    expect(fixed.status).toBe('unresolved'); expect(fixed.completionMonth).toBeNull();
    expect(item(result,'next').status).toBe('unresolved'); expect(item(result,'next').bookings).toHaveLength(0);
    expect(result.resourceMonths.find(row=>row.resourceId==='a-unhired'&&row.month===0)).toMatchObject({employed:false,capacityFte:0,bookedFte:0});
    expect(result.resourceMonths.every(row=>row.bookedFte<=row.capacityFte)).toBe(true);
    expect(result.findings.filter(row=>row.code==='fixed-shortage').map(row=>row.month)).toEqual([0]);
    expect(result.findings.some(row=>row.code==='fixed-overload')).toBe(false);
    expect(project(reverseCollections(input) as Portfolio,'base',0)).toEqual(result);
  });
  it('requires a named resource for actual bookings and retains evidenced actual overload separately', () => {
    const input = portfolio({work:[work('observed',{actuals:{bookings:[{resourceId:'r',month:0,fte:1.25,sourceIds}],sourceIds}})]});
    const result = project(input,'base',1);
    expect(result.bookings.filter(row=>row.kind==='actual')).toMatchObject([{resourceId:'r',fte:1.25}]);
    expect(result.resourceMonths.find(row=>row.month===0)?.actualFte).toBe(1.25);
    expect(result.findings.some(row=>row.code==='fixed-overload'&&row.resourceId==='r'&&row.month===0)).toBe(true);
    const invalid = structuredClone(input) as unknown as { work: { actuals: { bookings: { resourceId: string | null }[] } }[] };
    invalid.work[0].actuals.bookings[0].resourceId = null;
    expect(validatePortfolio(invalid).some(issue=>issue.path.endsWith('.resourceId'))).toBe(true);
  });
  it('rejects historical employment edits, retains stale hire provenance, and permits editing unconfirmed hires', () => {
    const input = portfolio({ resources:[resource('r'),resource('hire',{employment:'planned',startMonth:1}),resource('exited',{startMonth:0,endMonth:1})], scenarios:[{id:'base',label:'Base'},{id:'later',label:'Later',resources:[{resourceId:'hire',startMonth:4}]},{id:'illegal',label:'Illegal',resources:[{resourceId:'r',remove:true}]},{id:'exit',label:'Exit',resources:[{resourceId:'exited',startMonth:4}]}] });
    const result = project(input,'base',3);
    expect(result.resources.find(row=>row.id==='hire')).toMatchObject({startMonth:1,effectiveStartMonth:3});
    expect(project(input,'later',3).resources.find(row=>row.id==='hire')?.effectiveStartMonth).toBe(4);
    expect(() => project(input,'illegal',3)).toThrow(/existing or exited/); expect(() => project(input,'exit',3)).toThrow(/existing or exited/);
  });
  it('propagates source-gap identities without treating related work as completion evidence', () => {
    const result = project(portfolio({work:[work('related'),work('claim',{mode:'milestone',durationMonths:undefined,demands:[],unresolvedReason:'No signed release.',relatedWorkIds:['related']}),work('dependent',{dependencies:[{workId:'claim'}]}),work('alias',{mode:'milestone',durationMonths:undefined,demands:[],dependencies:[{workId:'related'}]})]}),'base',0);
    expect(item(result,'dependent').sourceGapIds).toEqual(['claim']); expect(item(result,'dependent').completionMonth).toBeNull();
    expect(item(result,'claim').relatedWorkIds).toEqual(['related']); expect(item(result,'alias').completionMonth).toBe(1);
  });
});

describe('portfolio monthly economics', () => {
  it('calculates active payroll and resource overhead independently of assigned work', () => {
    const result = project(portfolio({ calendar:{startMonth:'2026-10',horizonMonths:12},resources:[resource('hire',{employment:'planned',startMonth:1,endMonth:7,costEvents:[{fromMonth:0,monthlyCents:3_207_075,sourceIds},{fromMonth:3,monthlyCents:3_333_888,sourceIds}]})] }),'base',0);
    expect(result.months.map(row=>row.payrollCents)).toEqual([0,3207075,3207075,3333888,3333888,3333888,3333888,0,0,0,0,0]);
    expect(result.months.reduce((sum,row)=>sum+row.payrollCents,0)).toBe(19_749_702);
    const input = portfolio({calendar:{startMonth:'2026-10',horizonMonths:12},resources:[resource('hire',{employment:'planned',startMonth:6,endMonth:9,costEvents:[{fromMonth:0,monthlyCents:3_333_888,sourceIds}]})],costs:[{id:'resource-ops',label:'Resource ops',programId:'p',kind:'recurring',startMonth:6,endMonth:9,monthlyCents:162_500,resourceIds:['hire'],sourceIds},{id:'indirect',label:'Indirect',programId:'p',kind:'recurring',startMonth:6,endMonth:9,monthlyCents:1_875_000,sourceIds}],scenarios:[{id:'base',label:'Base'},{id:'remove',label:'Remove',resources:[{resourceId:'hire',remove:true}]}]});
    expect(project(input,'base',0).months.reduce((sum,row)=>sum+row.expenseCents,0)).toBe(16_114_164);
    expect(project(input,'remove',0).months.reduce((sum,row)=>sum+row.expenseCents,0)).toBe(5_625_000);
  });
  it('conserves fixed totals over the original window before clipping', () => {
    const expected = [694444,694445,694444,694445,694444,694445,694444,694445,694444,694444,694445,694444,694445,694444,694445,694444,694445,694444];
    expect(distributeFixedTotal(12_500_000,18)).toEqual(expected);
    const result = project(portfolio({calendar:{startMonth:'2026-10',horizonMonths:24},resources:[],costs:[{id:'marketing',label:'Marketing',programId:'p',kind:'fixed-total',startMonth:0,endMonth:18,totalCents:12_500_000,sourceIds}]}),'base',0);
    expect(result.months.slice(0,18).map(row=>row.expenseCents)).toEqual(expected); expect(result.months.slice(18).every(row=>row.expenseCents===0)).toBe(true);
    expect(result.months.slice(0,12).reduce((sum,row)=>sum+row.expenseCents,0)).toBe(8_333_333);
    const clipped = project(portfolio({resources:[],costs:[{id:'marketing',label:'Marketing',programId:'p',kind:'fixed-total',startMonth:-12,endMonth:6,totalCents:12_500_000,sourceIds}]}),'base',0);
    expect(clipped.months.map(row=>row.expenseCents)).toEqual(expected.slice(12));
  });
  it('keeps restricted coverage, commitments, proposed coverage and receipts separate', () => {
    const input = portfolio({calendar:{startMonth:'2026-01',horizonMonths:2},costs:[{id:'ops',label:'Ops',programId:'p',kind:'recurring',startMonth:0,endMonth:2,monthlyCents:2000,sourceIds}],funding:[{id:'cover',label:'Restricted',kind:'coverage',status:'proposed',startMonth:0,endMonth:1,targetResourceIds:['r'],amountCents:15000,sourceIds},{id:'promise',label:'Promise',kind:'commitment',amountCents:50000,sourceIds},{id:'receipt',label:'Receipt',kind:'receipt',amountCents:50000,month:1,sourceIds}],cash:{openingBalanceCents:100000,receiptsKnown:true},scenarios:[{id:'base',label:'Base'},{id:'no-cover',label:'No coverage',funding:[{fundingId:'cover',include:false}]},{id:'no-receipt',label:'No receipt',funding:[{fundingId:'receipt',include:false}]},{id:'delay',label:'Delay',funding:[{fundingId:'receipt',receiptMonth:2}]}]});
    const result = project(input,'base',0);
    expect(result.months.map(row=>row.closingCashCents)).toEqual([88000,126000]);
    expect(result.funding.find(row=>row.id==='cover')).toMatchObject({requestedCents:15000,appliedCents:10000,excessCents:5000});
    expect(result.months.map(row=>row.proposedCoverageCents)).toEqual([10000,0]);
    expect(project(input,'no-cover',0).months.map(row=>row.closingCashCents)).toEqual([88000,126000]);
    expect(project(input,'no-receipt',0).months.map(row=>row.closingCashCents)).toEqual([88000,76000]);
    expect(project(input,'delay',0).resourceMonths).toEqual(result.resourceMonths);
    delete input.cash;
    expect(project(input,'base',0).months.map(row=>row.closingCashCents)).toEqual([null,null]);
  });
  it('prioritizes committed coverage, reports proposed separately, and never overcovers a cost', () => {
    const result = project(portfolio({funding:[{id:'proposal',label:'Proposal',kind:'coverage',status:'proposed',startMonth:0,endMonth:6,targetResourceIds:['r'],share:'1',sourceIds},{id:'committed',label:'Committed coverage',kind:'coverage',status:'committed',startMonth:0,endMonth:6,targetResourceIds:['r'],share:'0.25',sourceIds}],cash:{openingBalanceCents:100000,receiptsKnown:true}}),'base',0);
    expect(result.months[0]).toMatchObject({committedCoverageCents:2500,proposedCoverageCents:7500,uncoveredCents:0,closingCashCents:90000});
    expect(result.funding.find(row=>row.id==='proposal')?.excessCents).toBe(15000);
  });
  it('rounds exact half-cent ties and protects safe integer arithmetic', () => {
    expect(halfUp(1n,2n)).toBe(1); expect(halfUp(2n,3n)).toBe(1); expect(decimalShareCents(5,'0.5')).toBe(3);
    expect(distributeFixedTotal(1,2)).toEqual([1,0]); expect(() => halfUp(BigInt(Number.MAX_SAFE_INTEGER)+1n,1n)).toThrow(/safe integer/);
    expect(() => project(portfolio({resources:[resource('r',{costEvents:[{fromMonth:0,monthlyCents:Number.MAX_SAFE_INTEGER,sourceIds}]}),resource('s')]}),'base',0)).toThrow(/safe integer/);
  });
});

describe('portfolio validation and portable identity', () => {
  it('rejects malformed numbers, references, duplicates, cycles, unknown scenarios and invalid as-of', () => {
    const cases = [portfolio({resources:[resource('r'),resource('r')]}),portfolio({resources:[resource('r',{capacityFte:NaN})]}),portfolio({resources:[resource('r',{capacityFte:1.1})]}),portfolio({resources:[resource('r',{costEvents:[{fromMonth:0,monthlyCents:-1,sourceIds}]})]}),portfolio({work:[work('w',{demands:[demand('d',['missing'],1)]})]}),portfolio({work:[work('a',{dependencies:[{workId:'b'}]}),work('b',{dependencies:[{workId:'a'}]})]})];
    for (const value of cases) { expect(validatePortfolio(value).length).toBeGreaterThan(0); expect(() => project(value,'base',0)).toThrow(/\$/); }
    for (const asOf of [-1,6,1.5,Infinity]) expect(() => project(portfolio(),'base',asOf)).toThrow(/As-of/);
    expect(() => project(portfolio(),'missing',0)).toThrow(/Unknown scenario/);
  });
  it('makes JSON and YAML equivalent, is immutable, and safely accepts prototype-looking IDs', () => {
    const input = portfolio({id:'__proto__',resources:[resource('__proto__')],work:[work('constructor',{demands:[demand('__proto__',['__proto__'],1)]})],scenarios:[{id:'__proto__',label:'Base'}]});
    const before = JSON.stringify(input), fromJson = project(parsePortfolioText(JSON.stringify(input)),'__proto__',0), fromYaml = project(parsePortfolioText(yaml(input)),'__proto__',0);
    expect(fromJson).toEqual(fromYaml); expect(fromJson.fingerprint).toMatch(/^fnv1a64-utf16:[0-9a-f]{16}$/);
    expect(JSON.stringify(input)).toBe(before); expect(fromJson.work[0].completionMonth).toBe(1);
    fromJson.resources[0].sourceIds.push('new'); expect(input.resources[0].sourceIds).toEqual(['s']);
  });
  it('matches an independent BigInt FNV-1a64 digest for Unicode content', () => {
    const value = { id:'\u{1f30d}é\u0000', resources:['constructor','__proto__'], profile:[.5,.1,1] }, text = canonicalStringify(value);
    let expected = 0xcbf29ce484222325n;
    for (let i=0;i<text.length;i++) for (const byte of [text.charCodeAt(i)&255,text.charCodeAt(i)>>>8]) expected = BigInt.asUintN(64,(expected^BigInt(byte))*0x100000001b3n);
    expect(contentFingerprint(value)).toBe(`fnv1a64-utf16:${expected.toString(16).padStart(16,'0')}`);
  });
  it('includes the versioned projection behavior in its canonical input identity', () => {
    const input = portfolio(), result = project(input,'base',0);
    expect(result.algorithmVersion).toBe('monthly-greedy/2');
    expect(result.fingerprint).not.toBe(contentFingerprint({portfolio:input,scenarioId:'base',asOfMonth:0,algorithmVersion:'monthly-greedy/1'}));
  });
  it('preserves every ordered source metadata array and fingerprints changes in its order', () => {
    const metadata = { byMonth:[20,10,30], stages:[{name:'second',values:[5,2]},{name:'first',values:[3,1]}] };
    const input = portfolio({metadata,work:[work('w',{metadata})]});
    const result = project(input,'base',0);
    expect(result.metadata).toEqual(metadata); expect(result.work[0].metadata).toEqual(metadata);
    const changed = structuredClone(input); (changed.metadata!.byMonth as number[]).reverse();
    expect(project(changed,'base',0).fingerprint).not.toBe(result.fingerprint);
  });
  it('rejects all overrides on exited resources and derived scenario overflow', () => {
    const exited = portfolio({resources:[resource('r',{endMonth:1})],scenarios:[{id:'base',label:'Base',resources:[{resourceId:'r',capacityFte:.5}]}]});
    expect(()=>project(exited,'base',2)).toThrow(/already-exited/);
    for (const field of ['demandMultiplier','durationMultiplier','effortMultiplier'] as const) {
      const input = portfolio({work:[work('w',{...(field==='effortMultiplier'?{mode:'effort',effortFteMonths:2,minStaffingFte:1,maxStaffingFte:1}:{}),demands:[demand('d',['r'],2)]})],scenarios:[{id:'base',label:'Base',work:[{workId:'w',[field]:Number.MAX_VALUE}]}]});
      expect(()=>project(input,'base',0)).toThrow(/\$\.scenarios.*safe/);
    }
  });
});
