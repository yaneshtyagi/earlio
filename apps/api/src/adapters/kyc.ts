export interface KycRequest {
  orgName: string;
  orgType: string;
  country: string;
  documents: { docType: string; filename: string }[];
  requiredDocTypes: string[];
}
export interface KycResult { outcome: 'pass' | 'refer' | 'fail'; reasons: string[]; reference: string }
export interface KycProvider { submit(req: KycRequest): Promise<KycResult> }

export const REQUIRED_KYC_DOCS: Record<string, string[]> = {
  supplier: ['incorporation_certificate', 'gst_registration', 'iec_code', 'bank_account_proof'],
  buyer: ['incorporation_certificate', 'tax_registration'],
  bank: ['banking_licence', 'authorised_signatory'],
  insurer: ['insurance_licence', 'authorised_signatory'],
  platform: [],
};

/**
 * Simulated KYC reliance check (seeded rules): missing documents fail; a name containing "REFER" is referred
 * to manual review; one containing "FAIL" fails. Everything else passes.
 */
export class SimKycProvider implements KycProvider {
  async submit(req: KycRequest): Promise<KycResult> {
    const reference = 'SIMKYC-' + Buffer.from(req.orgName).toString('hex').slice(0, 10).toUpperCase();
    const have = new Set(req.documents.map((d) => d.docType));
    const missing = req.requiredDocTypes.filter((t) => !have.has(t));
    if (missing.length) return { outcome: 'fail', reasons: [`Missing documents: ${missing.join(', ')}`], reference };
    if (/FAIL/.test(req.orgName)) return { outcome: 'fail', reasons: ['Registry check failed (simulated).'], reference };
    if (/REFER/.test(req.orgName)) return { outcome: 'refer', reasons: ['Registry details need a manual check (simulated).'], reference };
    return { outcome: 'pass', reasons: [], reference };
  }
}
