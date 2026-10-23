import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../kernel/config';
import { LocalDiskObjectStore, SimFileScanner, type FileScanner, type ObjectStore } from './object-store';
import { SimSanctionsProvider, type SanctionsProvider } from './sanctions';
import { SimKycProvider, type KycProvider } from './kyc';
import { SimEInvoiceService, SimErpInvoiceSource, type EInvoiceService, type ErpInvoiceSource } from './erp';
import { SimFxRateProvider, type FxRateProvider } from './fx';
import { SimTimestampAuthority, type TimestampAuthority } from '../platform/audit';

/** Every external dependency behind an interface (ADR-004). Later milestones add fx, payments, insurer, erp, notifications. */
export interface Adapters {
  objectStore: ObjectStore;
  fileScanner: FileScanner;
  kyc: KycProvider;
  sanctions: SanctionsProvider;
  tsa: TimestampAuthority;
  einvoice: EInvoiceService;
  erp: ErpInvoiceSource;
  fx: FxRateProvider;
}

export function defaultAdapters(config: Config, overrides: Partial<Adapters> = {}): Adapters {
  return {
    objectStore: new LocalDiskObjectStore(config.objectStoreDir || join(tmpdir(), 'earlio-objects')),
    fileScanner: new SimFileScanner(),
    kyc: new SimKycProvider(),
    sanctions: new SimSanctionsProvider(),
    tsa: new SimTimestampAuthority(),
    einvoice: new SimEInvoiceService(),
    erp: new SimErpInvoiceSource(),
    fx: new SimFxRateProvider(),
    ...overrides,
  };
}
