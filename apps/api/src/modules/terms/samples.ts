/** 20 deterministic sample invoices for the terms simulator (CT-9). Fictional. */
export interface SampleInvoice {
  id: string; label: string; amount: string; currency: 'USD' | 'SGD'; tenorDays: number; buyerCountry: 'US' | 'SG'; buyerTier: 'AA' | 'A' | 'BBB'; supplierSmall: boolean; goods?: string;
}
const mk = (n: number, label: string, amount: string, currency: 'USD' | 'SGD', tenorDays: number, buyerCountry: 'US' | 'SG', buyerTier: 'AA' | 'A' | 'BBB', supplierSmall: boolean): SampleInvoice =>
  ({ id: `S${String(n).padStart(2, '0')}`, label, amount, currency, tenorDays, buyerCountry, buyerTier, supplierSmall });
export const SAMPLE_INVOICES: SampleInvoice[] = [
  mk(1, 'Small US A, 45d', '8000', 'USD', 45, 'US', 'A', true), mk(2, 'US A, 60d', '100000', 'USD', 60, 'US', 'A', false), mk(3, 'US A, 90d', '250000', 'USD', 90, 'US', 'A', false),
  mk(4, 'US BBB, 60d', '60000', 'USD', 60, 'US', 'BBB', true), mk(5, 'US BBB large', '700000', 'USD', 60, 'US', 'BBB', false), mk(6, 'US AA, 120d', '400000', 'USD', 120, 'US', 'AA', false),
  mk(7, 'US A, 135d', '120000', 'USD', 135, 'US', 'A', false), mk(8, 'SG A SGD, 60d', '30000', 'SGD', 60, 'SG', 'A', true), mk(9, 'SG BBB SGD, 75d', '90000', 'SGD', 75, 'SG', 'BBB', false),
  mk(10, 'SG AA USD, 30d', '1500000', 'USD', 30, 'SG', 'AA', false), mk(11, 'SG A USD, 150d', '300000', 'USD', 150, 'SG', 'A', false), mk(12, 'US A, tiny', '3000', 'USD', 30, 'US', 'A', true),
  mk(13, 'US A, 90d small', '45000', 'USD', 90, 'US', 'A', true), mk(14, 'SG BBB, 120d', '200000', 'USD', 120, 'SG', 'BBB', false), mk(15, 'US AA, 45d', '55000', 'USD', 45, 'US', 'AA', true),
  mk(16, 'US BBB, 100d', '80000', 'USD', 100, 'US', 'BBB', true), mk(17, 'SG A SGD, 90d', '150000', 'SGD', 90, 'SG', 'A', false), mk(18, 'US A, 20d', '25000', 'USD', 20, 'US', 'A', false),
  mk(19, 'US A, 2M', '2000000', 'USD', 60, 'US', 'A', false), mk(20, 'SG AA SGD, 45d', '40000', 'SGD', 45, 'SG', 'AA', true),
];
