import { BANK_TERMS, INSURER_TERMS, PLATFORM_DEFAULT } from '../terms/defaults';
import type { OwnerType } from '../terms/schema';

export interface Change { path: string; before: unknown; after: unknown; kind: 'added' | 'removed' | 'changed' }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Structural diff of two JSON values. Objects are compared key by key; arrays and scalars as whole values. */
export function diffJson(before: unknown, after: unknown, path = ''): Change[] {
  if (isObj(before) && isObj(after)) {
    const out: Change[] = [];
    for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      out.push(...diffJson(before[k], after[k], path ? `${path}.${k}` : k));
    }
    return out;
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const kind = before === undefined ? 'added' : after === undefined ? 'removed' : 'changed';
  return [{ path, before, after, kind }];
}

// ---------------------------------------------------------------------------------------- plain language (CT-8)
const TIER = (m: Record<string, number> | undefined, suffix = '%') => Object.entries(m ?? {}).map(([t, v]) => `${t}: ${v}${suffix}`).join(', ');
const money = (n: number) => n.toLocaleString('en-US');

export interface Preview { supplier: string[]; buyer: string[]; notes: string[] }

/** What suppliers and buyers will see for a given terms body (CT-8). Deliberately simple sentences. */
export function describeTerms(owner: OwnerType, b: Record<string, any>, benchmarkPct = 4.1): Preview {
  const p: Preview = { supplier: [], buyer: [], notes: [] };
  if (owner === 'bank') {
    if (b.advancePct != null) p.supplier.push(`You receive up to ${b.advancePct}% of the invoice up front, in rupees; the rest (minus charges) follows when the buyer pays.`);
    if (b.pricing?.type === 'fixed') p.supplier.push(`You pay ${b.pricing.ratePct}% a year for the days the money is out.`);
    else if (b.pricing?.type === 'benchmark') p.supplier.push(`You pay the benchmark rate (${benchmarkPct}% today) plus a margin that depends on the buyer's rating — ${TIER(b.pricing.spreadPctByTier)}.`);
    if (b.processingFee) p.supplier.push(`A processing fee of ${b.processingFee.pct}% applies${b.processingFee.minUsd ? ` (at least USD ${b.processingFee.minUsd})` : ''}.`);
    if (b.fxSpreadPct != null) p.supplier.push(`Dollars are converted to rupees at the market rate less a ${b.fxSpreadPct}% margin.`);
    if (b.invoiceSizeUsd) p.supplier.push(`Invoices from USD ${money(b.invoiceSizeUsd.min)} to USD ${money(b.invoiceSizeUsd.max)}, up to ${b.maxTenorDays} days, in ${(b.currencies ?? []).join(' or ')}, for buyers in ${(b.buyerCountries ?? []).join(' or ')}.`);
    if (b.cutoff) p.supplier.push(`Money is sent the same banking day if the financing is confirmed before ${b.cutoff.time} (${b.cutoff.timezone}); otherwise on the next banking day${b.settlementDays ? `, plus ${b.settlementDays} settlement day${b.settlementDays > 1 ? 's' : ''}` : ''}.`);
    if (b.offerValidityHours) p.supplier.push(`Each offer stays open for ${b.offerValidityHours} hours.`);
    if (b.minCoverPct != null) p.supplier.push(`The bank only funds invoices where insurance covers at least ${b.minCoverPct}%.`);
    if (b.requiredDocuments?.length) p.supplier.push(`You must attach: ${b.requiredDocuments.map((d: string) => d.replace(/_/g, ' ')).join(', ')}.`);
    for (const f of b.customFields ?? []) if (f.appliesTo === 'financing_request') p.supplier.push(`The bank asks: "${f.label}"${f.required ? ' (required)' : ''}.`);
    p.buyer.push('You see the invoice, your payment undertaking and the bank to pay. You never see the rate, fees or the supplier\'s net cash.');
    if (b.graceDays) p.buyer.push(`A payment up to ${b.graceDays} day${b.graceDays > 1 ? 's' : ''} after the due date is not treated as late.`);
    if (b.eligibility?.reasonIfFalse) p.notes.push(`If an invoice does not qualify, suppliers are told: "${b.eligibility.reasonIfFalse}"`);
    if (b.platformFeePayer) p.notes.push(`The Earlio platform fee is paid by the ${b.platformFeePayer}.`);
  } else if (owner === 'insurer') {
    if (b.coverPct != null) p.supplier.push(`The invoice is insured for ${b.coverPct}% of its value${Object.keys(b.coverPctByTier ?? {}).length ? ` (${TIER(b.coverPctByTier)} for specific buyer ratings)` : ''}.`);
    if (b.premium?.mode === 'flat') p.supplier.push(`The premium is ${b.premium.flatRatePct}% of the invoice, paid by the ${b.premium.payer}.`);
    else if (b.premium?.mode === 'per_period') p.supplier.push(`The premium is charged per ${b.premium.periodDays}-day period by buyer rating (${TIER(b.premium.ratePctByTier)}), paid by the ${b.premium.payer}.`);
    if (b.waitingPeriodDays) p.supplier.push(`If the buyer simply does not pay, a claim opens after ${b.waitingPeriodDays.protractedDefault} days; on insolvency ${b.waitingPeriodDays.insolvency === 0 ? 'immediately' : `after ${b.waitingPeriodDays.insolvency} days`}.`);
    if (b.exclusions?.length) p.supplier.push(`Not covered: ${b.exclusions.map((e: string) => e.replace(/_/g, ' ')).join(', ')}.`);
    if (b.claimDeadlineDays) p.supplier.push(`The bank must claim within ${b.claimDeadlineDays} days after the waiting period.`);
    if (b.claimDocuments?.length) p.notes.push(`Claim file must contain: ${b.claimDocuments.map((d: string) => d.replace(/_/g, ' ')).join(', ')}.`);
    if (b.limits) p.notes.push(`Limits: USD ${money(b.limits.perBuyerUsd)} per buyer, USD ${money(b.limits.portfolioUsd)} in total.`);
    p.buyer.push('Insurance protects the bank and supplier; it does not change what you owe or when.');
  } else {
    if (b.disputeWindowHours != null) p.buyer.push(`You have ${b.disputeWindowHours} hours after accepting an invoice to raise a dispute before it can be financed.`);
    if (b.platformFee) p.notes.push(`Platform fee: ${b.platformFee.bps} basis points, paid by the ${b.platformFee.payer}.`);
    if (b.freeTierInvoicesPerMonth != null) p.supplier.push(`Small suppliers finance ${b.freeTierInvoicesPerMonth} invoices a month without platform charges.`);
    if (b.maxAllInCostSmallPct != null) p.supplier.push(`Small suppliers are never offered an all-in cost above ${b.maxAllInCostSmallPct}% a year.`);
    if (b.maxFxSpreadPct != null) p.supplier.push(`No bank may charge more than ${b.maxFxSpreadPct}% over the market FX rate.`);
    if (b.benchmarkRatePct != null) p.notes.push(`Benchmark rate used for benchmark-priced offers: ${b.benchmarkRatePct}%.`);
  }
  return p;
}

// ---------------------------------------------------------------------------------------- templates (CT-1)
export interface Template { id: string; name: string; description: string; body: Record<string, any> }
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export function templatesFor(owner: OwnerType): Template[] {
  if (owner === 'bank') {
    const base = clone(BANK_TERMS.aurelia!) as Record<string, any>;
    delete base.customFields;
    const conservative = { ...clone(base), advancePct: 80, maxTenorDays: 90, minCoverPct: 90, invoiceSizeUsd: { min: 10000, max: 1000000 }, pricing: { type: 'benchmark', spreadPctByTier: { AA: 2.0, A: 2.25, BBB: 3.5 } }, buyerCountries: ['US'] };
    const growth = { ...clone(base), advancePct: 90, maxTenorDays: 150, minCoverPct: 80, invoiceSizeUsd: { min: 2000, max: 3000000 }, offerValidityHours: 48, pricing: { type: 'benchmark', spreadPctByTier: { AA: 1.5, A: 1.75, BBB: 2.5 } },
      eligibility: { id: 'growth', all: [{ field: 'buyer.country', in: ['US', 'SG'] }, { field: 'invoice.tenorDays', lte: 150 }], reasonIfFalse: 'This bank funds US and Singapore buyers up to 150 days.' } };
    return [
      { id: 'standard', name: 'Standard', description: 'US and Singapore buyers rated BBB or better, up to 120 days, 90% advance.', body: base },
      { id: 'conservative', name: 'Conservative', description: 'US buyers only, 80% advance, up to 90 days, wider margins.', body: conservative },
      { id: 'growth', name: 'Growth', description: 'Small tickets welcome, 90% advance, up to 150 days, tight margins.', body: growth },
    ];
  }
  if (owner === 'insurer') {
    const std = clone(INSURER_TERMS.exportshield!) as Record<string, any>;
    return [
      { id: 'standard', name: 'Standard', description: '90% cover, 90-day waiting period, per-period premium.', body: std },
      { id: 'cautious', name: 'Cautious', description: '80% cover, 120-day waiting period, extra exclusions.', body: { ...clone(std), coverPct: 80, coverPctByTier: { BBB: 70 }, waitingPeriodDays: { protractedDefault: 120, insolvency: 0 }, exclusions: [...std.exclusions, 'fx_movements'], claimDeadlineDays: 45 } },
    ];
  }
  return [{ id: 'defaults', name: 'Current seed defaults', description: 'The platform starting point.', body: clone(PLATFORM_DEFAULT) as Record<string, any> }];
}
