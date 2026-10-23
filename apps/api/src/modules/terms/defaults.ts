import type { BankTerms, InsurerTerms, PlatformTerms } from './schema';

/** Seeded platform defaults (illustrative, fictional; POC plan BR-1 to BR-5, BR-9, BR-11). */
export const PLATFORM_DEFAULT: PlatformTerms = {
  benchmarkRatePct: 4.1,
  disputeWindowHours: 24,
  assignmentNoticeRequired: true,
  sanctionsBlocksFunding: true,
  maxAllInCostSmallPct: 18,
  maxFxSpreadPct: 1.0,
  platformFee: { bps: 3, payer: 'bank' },
  earlyPayment: { bankCommissionSharePct: 20, buyerCashYieldPct: 4.0 },
  freeTierInvoicesPerMonth: 5,
};

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

/** BR-6 exactly. */
export const BANK_TERMS: Record<string, BankTerms> = {
  aurelia: {
    advancePct: 90, pricing: { type: 'benchmark', spreadPctByTier: { AA: 1.75, A: 1.75, BBB: 2.75 } },
    processingFee: { pct: 0.1, minUsd: 25 }, invoiceSizeUsd: { min: 5000, max: 2000000 }, maxTenorDays: 120, currencies: ['USD', 'SGD'], buyerCountries: ['US', 'SG'],
    goods: {}, offerValidityHours: 24, cutoff: { time: '15:00', timezone: 'Asia/Kolkata' }, settlementDays: 1, fxSpreadPct: 0.3, minCoverPct: 85, graceDays: 0,
    platformFeePayer: 'bank', eligibility: AURELIA_RULE,
  },
  kestrel: {
    advancePct: 85, pricing: { type: 'fixed', ratePct: 7.25 },
    processingFee: { pct: 0.25, minUsd: 0 }, invoiceSizeUsd: { min: 10000, max: 500000 }, maxTenorDays: 90, currencies: ['USD'], buyerCountries: ['US', 'SG'],
    goods: {}, offerValidityHours: 12, cutoff: { time: '14:00', timezone: 'Asia/Kolkata' }, settlementDays: 1, fxSpreadPct: 0.45, minCoverPct: 80, graceDays: 0,
    platformFeePayer: 'bank',
    eligibility: { id: 'kestrel-tier-a-and-above', all: [{ field: 'buyer.tier', in: ['A', 'AA'] }], reasonIfFalse: 'This lender funds buyers rated A or better.' },
  },
  harbour: {
    advancePct: 80, pricing: { type: 'benchmark', spreadPctByTier: { AA: 1.4, A: 1.4, BBB: 1.4 } },
    processingFee: { pct: 0.15, minUsd: 0 }, invoiceSizeUsd: { min: 25000, max: 5000000 }, maxTenorDays: 150, currencies: ['USD', 'SGD'], buyerCountries: ['SG'],
    goods: {}, offerValidityHours: 48, cutoff: { time: '17:00', timezone: 'Asia/Singapore' }, settlementDays: 2, fxSpreadPct: 0.25, minCoverPct: 80, graceDays: 0,
    platformFeePayer: 'bank',
    eligibility: { id: 'harbour-sg-buyers', all: [{ field: 'buyer.country', eq: 'SG' }], reasonIfFalse: 'This bank funds Singapore buyers only.' },
  },
};

/** BR-7 exactly. */
export const INSURER_TERMS: Record<string, InsurerTerms> = {
  exportshield: {
    coverPct: 90, coverPctByTier: { BBB: 85 }, insuredEvents: ['insolvency', 'protracted_default'], waitingPeriodDays: { protractedDefault: 90, insolvency: 0 },
    exclusions: ['disputes', 'documentation_defects', 'shipment_before_limit_approval', 'sanctions_breach'],
    claimDocuments: ['invoice', 'acceptance', 'delivery_proof', 'statement'], claimDeadlineDays: 60,
    premium: { mode: 'per_period', periodDays: 90, ratePctByTier: { AA: 0.2, A: 0.2, BBB: 0.35 }, payer: 'supplier' },
    limits: { perBuyerUsd: 3_000_000, portfolioUsd: 25_000_000 },
  },
  sentinel: {
    coverPct: 85, coverPctByTier: {}, insuredEvents: ['insolvency', 'protracted_default'], waitingPeriodDays: { protractedDefault: 120, insolvency: 0 },
    exclusions: ['disputes', 'documentation_defects', 'shipment_before_limit_approval', 'sanctions_breach', 'fx_movements'],
    claimDocuments: ['invoice', 'acceptance', 'delivery_proof', 'statement'], claimDeadlineDays: 45,
    premium: { mode: 'flat', flatRatePct: 0.28, payer: 'bank' },
    limits: { perBuyerUsd: 5_000_000, portfolioUsd: 40_000_000 },
  },
};
