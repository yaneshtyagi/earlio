import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { evaluateCondition, evaluateRule, validateCondition, type Condition } from '../src/modules/terms/rules';

const AURELIA_RULE = {
  id: 'aurelia-us-sg-standard',
  all: [
    { field: 'buyer.country', in: ['US', 'SG'] },
    { field: 'invoice.currency', in: ['USD', 'SGD'] },
    { field: 'invoice.tenorDays', lte: 120 },
    { any: [
      { field: 'buyer.tier', in: ['A', 'AA'] },
      { all: [{ field: 'buyer.tier', eq: 'BBB' }, { field: 'invoice.amountUsdEq', lte: 500000 }] },
    ] },
  ],
  reasonIfFalse: 'This bank funds US and Singapore buyers rated BBB or better, up to 120 days.',
};
const facts = (o: Record<string, any> = {}) => ({
  buyer: { country: 'US', tier: 'A', ...(o.buyer ?? {}) }, invoice: { currency: 'USD', tenorDays: 60, amountUsdEq: 100000, ...(o.invoice ?? {}) },
});

describe('BR-8 example rule', () => {
  it('passes a US tier-A 60-day USD invoice', () => { expect(evaluateRule(AURELIA_RULE as any, facts())).toEqual({ pass: true, reasons: [] }); });
  it('passes a BBB buyer up to USD 500,000 and fails above', () => {
    expect(evaluateRule(AURELIA_RULE as any, facts({ buyer: { tier: 'BBB' }, invoice: { amountUsdEq: 500000 } })).pass).toBe(true);
    const r = evaluateRule(AURELIA_RULE as any, facts({ buyer: { tier: 'BBB' }, invoice: { amountUsdEq: 500001 } }));
    expect(r.pass).toBe(false);
    expect(r.reasons[0]).toBe(AURELIA_RULE.reasonIfFalse);
  });
  it('renders the failed leaf in plain language', () => {
    const r = evaluateRule(AURELIA_RULE as any, facts({ invoice: { tenorDays: 135 } }));
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain("Tenor of 135 days is above this bank's maximum of 120 days.");
  });
  it('rejects a buyer outside US/SG', () => {
    const r = evaluateRule(AURELIA_RULE as any, facts({ buyer: { country: 'DE' } }));
    expect(r.pass).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/Buyer country "DE"/);
  });
  it('is deterministic and does not mutate the rule or the facts', () => {
    const f = facts(); const before = JSON.stringify([AURELIA_RULE, f]);
    evaluateRule(AURELIA_RULE as any, f); evaluateRule(AURELIA_RULE as any, f);
    expect(JSON.stringify([AURELIA_RULE, f])).toBe(before);
  });
});

describe('operators and validation', () => {
  it.each([
    [{ field: 'invoice.tenorDays', lt: 60 }, false], [{ field: 'invoice.tenorDays', gte: 60 }, true], [{ field: 'invoice.tenorDays', gt: 60 }, false],
    [{ field: 'buyer.country', nin: ['IR'] }, true], [{ field: 'buyer.country', neq: 'US' }, false], [{ field: 'invoice.goods', exists: false }, true],
  ])('%j -> %s', (c, expected) => { expect(evaluateCondition(c as Condition, facts()).pass).toBe(expected); });
  it('not inverts', () => { expect(evaluateCondition({ not: { field: 'buyer.country', eq: 'US' } }, facts()).pass).toBe(false); });
  it('validateCondition catches malformed rules', () => {
    expect(validateCondition({ field: 'x' })).toMatch(/exactly one operator/);
    expect(validateCondition({ all: [] })).toMatch(/non-empty/);
    expect(validateCondition({ field: 'x', lte: 'a' })).toMatch(/needs a number/);
    expect(validateCondition(AURELIA_RULE)).toBeNull();
  });
});

// ---- property-based composition ----
const leafArb = fc.record({ n: fc.integer({ min: 0, max: 100 }), t: fc.integer({ min: 0, max: 100 }) })
  .map(({ n, t }): Condition => ({ field: 'x', lte: t })); // truth depends on the fact x
const condArb: fc.Arbitrary<Condition> = fc.letrec((tie) => ({
  node: fc.oneof({ depthSize: 'small' },
    leafArb,
    fc.array(tie('node') as fc.Arbitrary<Condition>, { minLength: 1, maxLength: 4 }).map((all): Condition => ({ all })),
    fc.array(tie('node') as fc.Arbitrary<Condition>, { minLength: 1, maxLength: 4 }).map((any): Condition => ({ any })),
    (tie('node') as fc.Arbitrary<Condition>).map((c): Condition => ({ not: c }))),
})).node;
const pass = (c: Condition, x: number) => evaluateCondition(c, { x }).pass;

describe('property: and/or/not composition', () => {
  it('all = AND of children, any = OR of children', () => {
    fc.assert(fc.property(fc.array(condArb, { minLength: 1, maxLength: 5 }), fc.integer({ min: 0, max: 100 }), (cs, x) => {
      expect(pass({ all: cs }, x)).toBe(cs.every((c) => pass(c, x)));
      expect(pass({ any: cs }, x)).toBe(cs.some((c) => pass(c, x)));
    }), { numRuns: 300 });
  });
  it('double negation, De Morgan and idempotence hold', () => {
    fc.assert(fc.property(condArb, condArb, fc.integer({ min: 0, max: 100 }), (a, b, x) => {
      expect(pass({ not: { not: a } }, x)).toBe(pass(a, x));
      expect(pass({ not: { all: [a, b] } }, x)).toBe(pass({ any: [{ not: a }, { not: b }] }, x));
      expect(pass({ not: { any: [a, b] } }, x)).toBe(pass({ all: [{ not: a }, { not: b }] }, x));
      expect(pass({ all: [a, a] }, x)).toBe(pass(a, x));
    }), { numRuns: 300 });
  });
  it('reasons are empty exactly when the condition passes', () => {
    fc.assert(fc.property(condArb, fc.integer({ min: 0, max: 100 }), (c, x) => {
      const r = evaluateCondition(c, { x });
      expect(r.reasons.length === 0).toBe(r.pass);
    }), { numRuns: 300 });
  });
  it('order of children does not change the result', () => {
    fc.assert(fc.property(fc.array(condArb, { minLength: 2, maxLength: 5 }), fc.integer({ min: 0, max: 100 }), (cs, x) => {
      expect(pass({ all: [...cs].reverse() }, x)).toBe(pass({ all: cs }, x));
      expect(pass({ any: [...cs].reverse() }, x)).toBe(pass({ any: cs }, x));
    }), { numRuns: 200 });
  });
});
