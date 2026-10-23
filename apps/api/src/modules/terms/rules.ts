/**
 * Eligibility rule engine (CT-3, BR-8). Pure and deterministic: no DB, no clock.
 * A condition is a leaf ({field, in|nin|eq|neq|lt|lte|gt|gte|exists}) or a combinator ({all}|{any}|{not}).
 */
export type Scalar = string | number | boolean | null;
export type Leaf =
  | { field: string; in: Scalar[] } | { field: string; nin: Scalar[] } | { field: string; eq: Scalar } | { field: string; neq: Scalar }
  | { field: string; lt: number } | { field: string; lte: number } | { field: string; gt: number } | { field: string; gte: number } | { field: string; exists: boolean };
export type Condition = Leaf | { all: Condition[] } | { any: Condition[] } | { not: Condition };
export interface Rule { id?: string; reasonIfFalse?: string; when: Condition }
export type RuleInput = Condition & { id?: string; reasonIfFalse?: string };

export type Facts = Record<string, unknown>;
export interface Evaluation { pass: boolean; reasons: string[] }

const get = (facts: Facts, path: string): unknown => path.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), facts);

/** How facts are described in plain language. */
const LABELS: Record<string, { label: string; unit?: string; limitOwner?: string }> = {
  'invoice.tenorDays': { label: 'Tenor', unit: ' days' },
  'invoice.amountUsdEq': { label: 'Invoice amount', unit: ' USD' },
  'invoice.currency': { label: 'Currency' },
  'invoice.goods': { label: 'Goods category' },
  'buyer.country': { label: 'Buyer country' },
  'buyer.tier': { label: 'Buyer rating tier' },
  'supplier.country': { label: 'Supplier country' },
  'supplier.small': { label: 'Small-supplier status' },
  'corridor': { label: 'Corridor' },
};
const label = (f: string) => LABELS[f]?.label ?? f;
const unit = (f: string) => LABELS[f]?.unit ?? '';
const show = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v));

function leafOps(c: any): string[] {
  return ['in', 'nin', 'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'exists'].filter((k) => k in c);
}

export function isLeaf(c: Condition): c is Leaf { return 'field' in c; }

export function evalLeaf(c: Leaf, facts: Facts): Evaluation {
  const actual = get(facts, c.field);
  const l = label(c.field), u = unit(c.field);
  const ops = leafOps(c);
  if (ops.length !== 1) throw new Error(`Condition on ${c.field} must have exactly one operator`);
  const op = ops[0]!;
  const val = (c as any)[op];
  const num = typeof actual === 'number' ? actual : actual == null ? NaN : Number(actual);
  let pass: boolean, why: string;
  switch (op) {
    case 'in': pass = (val as Scalar[]).includes(actual as Scalar); why = `${l} ${actual === undefined ? 'is not known' : `"${show(actual)}"`} is not one of the accepted values (${show(val)}).`; break;
    case 'nin': pass = !(val as Scalar[]).includes(actual as Scalar); why = `${l} "${show(actual)}" is not accepted.`; break;
    case 'eq': pass = actual === val; why = `${l} must be ${show(val)}${u} (it is ${show(actual)}).`; break;
    case 'neq': pass = actual !== val; why = `${l} must not be ${show(val)}.`; break;
    case 'lt': pass = num < val; why = `${l} of ${show(actual)}${u} must be below ${show(val)}${u}.`; break;
    case 'lte': pass = num <= val; why = `${l} of ${show(actual)}${u} is above this bank's maximum of ${show(val)}${u}.`; break;
    case 'gt': pass = num > val; why = `${l} of ${show(actual)}${u} must be above ${show(val)}${u}.`; break;
    case 'gte': pass = num >= val; why = `${l} of ${show(actual)}${u} is below the minimum of ${show(val)}${u}.`; break;
    case 'exists': pass = (actual !== undefined && actual !== null) === val; why = `${l} is ${val ? 'required' : 'not allowed'}.`; break;
    default: throw new Error(`unknown operator ${op}`);
  }
  return { pass, reasons: pass ? [] : [why] };
}

export function evaluateCondition(c: Condition, facts: Facts): Evaluation {
  if (isLeaf(c)) return evalLeaf(c, facts);
  if ('all' in c) {
    const rs = c.all.map((x) => evaluateCondition(x, facts));
    const failed = rs.filter((r) => !r.pass);
    return { pass: failed.length === 0, reasons: failed.flatMap((r) => r.reasons) };
  }
  if ('any' in c) {
    const rs = c.any.map((x) => evaluateCondition(x, facts));
    const pass = rs.some((r) => r.pass);
    return { pass, reasons: pass ? [] : [`None of these conditions hold: ${rs.flatMap((r) => r.reasons).join(' ')}`] };
  }
  if ('not' in c) {
    const r = evaluateCondition(c.not, facts);
    return { pass: !r.pass, reasons: r.pass ? ['A condition that must not hold is met.'] : [] };
  }
  throw new Error('Invalid condition');
}

/** Evaluate a rule. If `reasonIfFalse` is set it is the headline reason, followed by the specific failures. */
export function evaluateRule(rule: RuleInput, facts: Facts): Evaluation {
  const { id: _id, reasonIfFalse, ...cond } = rule;
  const r = evaluateCondition(cond as Condition, facts);
  if (r.pass) return r;
  return { pass: false, reasons: reasonIfFalse ? [reasonIfFalse, ...r.reasons] : r.reasons };
}

/** Structural validation (used when a rule is saved). Returns an error message or null. */
export function validateCondition(c: unknown, depth = 0): string | null {
  if (depth > 8) return 'Rules are nested too deeply (maximum 8 levels).';
  if (typeof c !== 'object' || c === null) return 'A condition must be an object.';
  const o = c as Record<string, unknown>;
  if ('all' in o || 'any' in o) {
    const k = 'all' in o ? 'all' : 'any';
    const arr = o[k];
    if (!Array.isArray(arr) || arr.length === 0) return `"${k}" needs a non-empty list of conditions.`;
    for (const x of arr) { const e = validateCondition(x, depth + 1); if (e) return e; }
    return null;
  }
  if ('not' in o) return validateCondition(o.not, depth + 1);
  if (typeof o.field !== 'string') return 'A condition needs a "field" or one of all / any / not.';
  const ops = leafOps(o);
  if (ops.length !== 1) return `The condition on ${o.field} needs exactly one operator (in, nin, eq, neq, lt, lte, gt, gte, exists).`;
  const op = ops[0]!;
  if ((op === 'in' || op === 'nin') && !Array.isArray(o[op])) return `"${op}" on ${o.field} needs a list.`;
  if (['lt', 'lte', 'gt', 'gte'].includes(op) && typeof o[op] !== 'number') return `"${op}" on ${o.field} needs a number.`;
  return null;
}
