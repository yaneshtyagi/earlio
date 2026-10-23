import { DomainError } from '../../kernel/errors';
import { D } from '../../kernel/money';
import { priceFinancing } from '../pricing/financing';
import type { OwnerType } from './schema';

/** Non-overridable platform guardrails (CT-7, BR-9). Hard limits are code, not data. */
export const GUARDRAILS = {
  minDisputeWindowHours: 24,
  maxFxSpreadPct: 1.0,
  maxAllInCostSmallPct: 18,
} as const;

export interface Breach { guardrail: string; message: string }

/** Check a terms body at save time. Returns every breach with the guardrail named. */
export function checkTermsGuardrails(owner: OwnerType, body: Record<string, any>, benchmarkRatePct = 4.1): Breach[] {
  const out: Breach[] = [];
  if (owner === 'platform') {
    if ('disputeWindowHours' in body && body.disputeWindowHours < GUARDRAILS.minDisputeWindowHours)
      out.push({ guardrail: 'min_dispute_window', message: `Guardrail "Minimum dispute window": the window cannot be shorter than ${GUARDRAILS.minDisputeWindowHours} hours (you set ${body.disputeWindowHours}).` });
    if ('assignmentNoticeRequired' in body && body.assignmentNoticeRequired !== true)
      out.push({ guardrail: 'assignment_notice_mandatory', message: 'Guardrail "Assignment notice is mandatory": it cannot be switched off.' });
    if ('sanctionsBlocksFunding' in body && body.sanctionsBlocksFunding !== true)
      out.push({ guardrail: 'sanctions_block', message: 'Guardrail "Sanctions hit blocks funding": it cannot be switched off.' });
    if ('maxFxSpreadPct' in body && body.maxFxSpreadPct > GUARDRAILS.maxFxSpreadPct)
      out.push({ guardrail: 'max_fx_spread', message: `Guardrail "Maximum FX spread": the cap cannot be raised above ${GUARDRAILS.maxFxSpreadPct.toFixed(2)}%.` });
    if ('maxAllInCostSmallPct' in body && body.maxAllInCostSmallPct > GUARDRAILS.maxAllInCostSmallPct)
      out.push({ guardrail: 'max_all_in_cost_small', message: `Guardrail "Cost cap for small suppliers": the cap cannot be raised above ${GUARDRAILS.maxAllInCostSmallPct}%.` });
  }
  if (owner === 'bank') {
    if ('fxSpreadPct' in body && body.fxSpreadPct > GUARDRAILS.maxFxSpreadPct)
      out.push({ guardrail: 'max_fx_spread', message: `Guardrail "Maximum FX spread" (${GUARDRAILS.maxFxSpreadPct.toFixed(2)}%): your FX spread of ${Number(body.fxSpreadPct).toFixed(2)}% is too high.` });
    if (body.pricing && body.advancePct != null) {
      const rates: number[] = body.pricing.type === 'fixed' ? [body.pricing.ratePct] : Object.values<number>(body.pricing.spreadPctByTier ?? {}).map((s) => s + benchmarkRatePct);
      const worst = Math.max(...rates, 0);
      const est = priceFinancing({
        faceAmount: 100000, advancePct: body.advancePct, ratePct: worst, tenorDays: 60, processingPct: body.processingFee?.pct ?? 0, processingMin: body.processingFee?.minUsd ?? 0,
        platformFeeBps: 0, platformFeePayer: 'bank',
      });
      if (D(est.allInAnnualisedPct).gt(GUARDRAILS.maxAllInCostSmallPct))
        out.push({ guardrail: 'max_all_in_cost_small', message: `Guardrail "Cost cap for small suppliers" (${GUARDRAILS.maxAllInCostSmallPct}% a year): these terms price a typical 60-day invoice at ${est.allInAnnualisedPct}% all-in.` });
    }
  }
  return out;
}

export function assertGuardrails(owner: OwnerType, body: Record<string, any>, benchmark?: number) {
  const b = checkTermsGuardrails(owner, body, benchmark);
  if (b.length) throw new DomainError('guardrail_breach', b.map((x) => x.message).join(' '), 422, { guardrails: b.map((x) => x.guardrail) });
}
