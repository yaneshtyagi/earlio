import { createHash } from 'node:crypto';

export interface InsurerCoverRequest {
  reference: string; invoiceId: string; humanId: string; buyerName: string; buyerTier: string; buyerCountry: string; amount: string; currency: string;
  requestedCoverPct: number; requestedAt: Date;
}
export type InsurerDecision =
  | { decision: 'approve'; coverPct: number; reason?: string } | { decision: 'decline'; reason: string };

/** Insurer integration (XB-5). The manual underwriter workflow is the default; the API and file gateways are stubs. */
export interface InsurerGateway {
  /** Returns a decision once the (simulated) insurer has answered, otherwise null. */
  poll(req: InsurerCoverRequest, now: Date): Promise<InsurerDecision | null>;
}

/** Auto-decides after a deterministic delay (1 to 3 hours): approves the requested cover, declines very large BBB exposures. */
export class SimInsurerApi implements InsurerGateway {
  delayMs(reference: string) { return (1 + (createHash('sha256').update(reference).digest()[0]! % 3)) * 3_600_000; }
  async poll(req: InsurerCoverRequest, now: Date): Promise<InsurerDecision | null> {
    if (now.getTime() < req.requestedAt.getTime() + this.delayMs(req.reference)) return null;
    if (req.buyerTier === 'BBB' && Number(req.amount) > 500_000) return { decision: 'decline', reason: 'Exposure to a BBB-rated buyer above 500,000 needs manual underwriting.' };
    return { decision: 'approve', coverPct: req.requestedCoverPct };
  }
}
