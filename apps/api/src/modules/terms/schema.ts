import { z } from 'zod';
import { validateCondition } from './rules';

/** Bump when the shape of a terms body changes; versions store the schema version they were written against. */
export const TERMS_SCHEMA_VERSION = 1;

const pct = (max = 100) => z.number().min(0).max(max);
const tier = z.enum(['AA', 'A', 'BBB']);
const condition = z.custom<any>((v) => validateCondition(v) === null, { message: 'Invalid eligibility rule' });

export const platformTermsShape = z.object({
  benchmarkRatePct: pct(50),
  disputeWindowHours: z.number().min(1),
  assignmentNoticeRequired: z.boolean(),
  sanctionsBlocksFunding: z.boolean(),
  maxAllInCostSmallPct: pct(100),
  maxFxSpreadPct: pct(10),
  platformFee: z.object({ bps: z.number().min(0).max(500), payer: z.enum(['bank', 'supplier']) }),
  earlyPayment: z.object({ bankCommissionSharePct: pct(), buyerCashYieldPct: pct(50) }),
  freeTierInvoicesPerMonth: z.number().int().min(0),
});

export const bankTermsShape = z.object({
  advancePct: z.number().gt(0).max(100),
  pricing: z.discriminatedUnion('type', [
    z.object({ type: z.literal('fixed'), ratePct: pct(60) }),
    z.object({ type: z.literal('benchmark'), spreadPctByTier: z.partialRecord(tier, pct(60)) }),
  ]),
  processingFee: z.object({ pct: pct(10), minUsd: z.number().min(0) }),
  invoiceSizeUsd: z.object({ min: z.number().min(0), max: z.number().gt(0) }),
  maxTenorDays: z.number().int().min(1).max(365),
  currencies: z.array(z.enum(['USD', 'SGD'])).min(1),
  buyerCountries: z.array(z.string().length(2)).min(1),
  goods: z.object({ allowed: z.array(z.string()).optional(), excluded: z.array(z.string()).optional() }),
  offerValidityHours: z.number().min(1).max(168),
  cutoff: z.object({ time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timezone: z.string().min(3) }),
  settlementDays: z.number().int().min(0).max(5),
  fxSpreadPct: pct(10),
  minCoverPct: pct(),
  graceDays: z.number().int().min(0).max(30),
  platformFeePayer: z.enum(['bank', 'supplier']),
  eligibility: condition,
});

export const insurerTermsShape = z.object({
  coverPct: pct(),
  coverPctByTier: z.partialRecord(tier, pct()),
  insuredEvents: z.array(z.enum(['insolvency', 'protracted_default'])).min(1),
  waitingPeriodDays: z.object({ protractedDefault: z.number().int().min(0), insolvency: z.number().int().min(0) }),
  exclusions: z.array(z.string()),
  claimDocuments: z.array(z.string()),
  claimDeadlineDays: z.number().int().min(1),
  premium: z.object({
    mode: z.enum(['per_period', 'flat']), periodDays: z.number().int().min(1).optional(),
    ratePctByTier: z.partialRecord(tier, pct(20)).optional(), flatRatePct: pct(20).optional(), payer: z.enum(['supplier', 'bank']),
  }).refine((p) => (p.mode === 'flat' ? p.flatRatePct != null : !!p.ratePctByTier), { message: 'Premium needs flatRatePct (flat) or ratePctByTier (per period).' }),
  limits: z.object({ perBuyerUsd: z.number().gt(0), portfolioUsd: z.number().gt(0) }),
});

export type PlatformTerms = z.infer<typeof platformTermsShape>;
export type BankTerms = z.infer<typeof bankTermsShape>;
export type InsurerTerms = z.infer<typeof insurerTermsShape>;
export type OwnerType = 'platform' | 'bank' | 'insurer';

/** Defaults sets (no scope) must be complete; scoped layers are partial overrides of the same keys. */
export function validateBody(owner: OwnerType, body: unknown, partial: boolean): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const shape = owner === 'platform' ? platformTermsShape : owner === 'bank' ? bankTermsShape : insurerTermsShape;
  const schema = (partial ? shape.partial() : shape).strict();
  const r = schema.safeParse(body);
  if (r.success) return { ok: true, body: r.data as Record<string, unknown> };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || 'terms'}: ${i.message}`).join('; ') };
}

export const jsonSchemaFor = (owner: OwnerType) => z.toJSONSchema((owner === 'platform' ? platformTermsShape : owner === 'bank' ? bankTermsShape : insurerTermsShape));
