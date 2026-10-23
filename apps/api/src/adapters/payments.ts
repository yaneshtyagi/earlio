import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type FaultMode = 'none' | 'reject' | 'timeout' | 'mismatch' | 'return' | 'random';
export interface SimFaults { disbursement: FaultMode; seed: number }
export const DEFAULT_FAULTS: SimFaults = { disbursement: 'none', seed: 42 };

export interface DisbursementInstruction { reference: string; bankOrgId: string; beneficiary: string; amountInr: string; valueDate: string; attempt: number }
export interface GatewayStatus { status: 'pending' | 'credited' | 'failed' | 'returned'; reason?: string; creditedInr?: string }
export interface StatementLine { bankTxnId: string; reference: string | null; currency: string; amount: string; valueDate: string; payer: string | null }

/** Payment rails behind an interface (A-12): the platform never holds funds. */
export interface PaymentGateway {
  instruct(i: DisbursementInstruction, now: Date, faults: SimFaults): Promise<{ accepted: boolean; gatewayRef: string; reason?: string }>;
  query(gatewayRef: string, instr: { amountInr: string }, now: Date, faults: SimFaults): Promise<GatewayStatus>;
}

function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Resolves the fault for one instruction deterministically: same seed + reference + attempt gives the same answer. */
export function faultFor(f: SimFaults, reference: string, attempt: number): Exclude<FaultMode, 'random'> {
  if (f.disbursement !== 'random') return f.disbursement;
  const h = createHash('sha256').update(`${f.seed}|${reference}|${attempt}`).digest().readUInt32BE(0);
  const r = mulberry32(h)();
  return r < 0.7 ? 'none' : r < 0.8 ? 'reject' : r < 0.9 ? 'timeout' : r < 0.95 ? 'mismatch' : 'return';
}

/** Simulated bank: credits an accepted instruction one hour after it was sent. State lives in the gateway reference, so restarts are safe. */
export class SimBankGateway implements PaymentGateway {
  async instruct(i: DisbursementInstruction, now: Date, faults: SimFaults) {
    const fault = faultFor(faults, i.reference, i.attempt);
    if (fault === 'reject') return { accepted: false, gatewayRef: '', reason: 'Beneficiary account rejected by the sending bank (simulated).' };
    return { accepted: true, gatewayRef: `SIMGW-${i.reference}-A${i.attempt}-${now.getTime()}-${fault}` };
  }
  async query(gatewayRef: string, instr: { amountInr: string }, now: Date): Promise<GatewayStatus> {
    const m = /-(\d+)-(none|reject|timeout|mismatch|return)$/.exec(gatewayRef);
    if (!m) return { status: 'failed', reason: 'Unknown gateway reference.' };
    const sentAt = Number(m[1]), fault = m[2];
    const age = now.getTime() - sentAt;
    if (fault === 'timeout') return age > 24 * 3_600_000 ? { status: 'failed', reason: 'The bank did not respond within 24 hours (simulated timeout).' } : { status: 'pending' };
    if (age < 3_600_000) return { status: 'pending' };
    if (fault === 'mismatch') return { status: 'credited', creditedInr: (Number(instr.amountInr) - 100).toFixed(2) };
    if (fault === 'return') return { status: 'returned', reason: 'Funds returned: beneficiary account closed (simulated).' };
    return { status: 'credited', creditedInr: instr.amountInr };
  }
}

// ---- signed webhooks (HMAC, with timestamp + nonce for replay protection)
export const webhookSecret = (masterKey: string, bankOrgId: string) => createHmac('sha256', masterKey).update(`webhook|${bankOrgId}`).digest('hex');
export const signWebhook = (secret: string, ts: number, nonce: string, body: string) => createHmac('sha256', secret).update(`${ts}.${nonce}.${body}`).digest('hex');
export function verifySignature(secret: string, ts: number, nonce: string, body: string, signature: string): boolean {
  const expected = Buffer.from(signWebhook(secret, ts, nonce, body), 'hex');
  let given: Buffer;
  try { given = Buffer.from(signature, 'hex'); } catch { return false; }
  return given.length === expected.length && timingSafeEqual(given, expected);
}
