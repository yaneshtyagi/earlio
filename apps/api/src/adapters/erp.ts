import { createHash } from 'node:crypto';

/** Simulated GST e-invoice portal: deterministic, plausible IRN (64 hex chars) and ack number. */
export interface EInvoiceService {
  register(input: { supplierName: string; invoiceNumber: string; issueDate: string; amount: string; currency: string }): Promise<{ irn: string; ackNo: string; ackDate: string }>;
}
export class SimEInvoiceService implements EInvoiceService {
  async register(i: { supplierName: string; invoiceNumber: string; issueDate: string; amount: string; currency: string }) {
    const irn = createHash('sha256').update(`${i.supplierName}|${i.invoiceNumber}|${i.issueDate}|${i.amount}|${i.currency}`).digest('hex');
    const ackNo = String(BigInt('0x' + irn.slice(0, 12)) % 1_000_000_000_000_000n).padStart(15, '1');
    return { irn, ackNo, ackDate: i.issueDate };
  }
}

export interface ErpInvoiceRow { buyer: string; number: string; currency: string; amount: string; issueDate: string; dueDate: string; poNumber?: string }
/** Simulated ERP: returns a seeded batch of invoices ready to import for a supplier. */
export interface ErpInvoiceSource { fetchBatch(supplierName: string): Promise<ErpInvoiceRow[]> }
export class SimErpInvoiceSource implements ErpInvoiceSource {
  async fetchBatch(supplierName: string): Promise<ErpInvoiceRow[]> {
    const initials = supplierName.split(/\s+/).map((w) => w[0]).join('').toUpperCase();
    return [
      { buyer: 'Northwind Retail Inc.', number: `${initials}/ERP/0001`, currency: 'USD', amount: '42500.00', issueDate: '2026-10-05', dueDate: '2026-12-04', poNumber: 'PO-NW-2201' },
      { buyer: 'Northwind Retail Inc.', number: `${initials}/ERP/0002`, currency: 'USD', amount: '18250.50', issueDate: '2026-10-12', dueDate: '2026-12-11' },
      { buyer: 'Not A Real Buyer Ltd', number: `${initials}/ERP/0003`, currency: 'USD', amount: '9000.00', issueDate: '2026-10-12', dueDate: '2026-12-11' },
    ];
  }
}
