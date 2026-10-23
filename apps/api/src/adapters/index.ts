import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../kernel/config';
import { LocalDiskObjectStore, SimFileScanner, type FileScanner, type ObjectStore } from './object-store';
import { SimSanctionsProvider, type SanctionsProvider } from './sanctions';
import { SimKycProvider, type KycProvider } from './kyc';
import { SimTimestampAuthority, type TimestampAuthority } from '../platform/audit';

/** Every external dependency behind an interface (ADR-004). Later milestones add fx, payments, insurer, erp, notifications. */
export interface Adapters {
  objectStore: ObjectStore;
  fileScanner: FileScanner;
  kyc: KycProvider;
  sanctions: SanctionsProvider;
  tsa: TimestampAuthority;
}

export function defaultAdapters(config: Config, overrides: Partial<Adapters> = {}): Adapters {
  return {
    objectStore: new LocalDiskObjectStore(config.objectStoreDir || join(tmpdir(), 'earlio-objects')),
    fileScanner: new SimFileScanner(),
    kyc: new SimKycProvider(),
    sanctions: new SimSanctionsProvider(),
    tsa: new SimTimestampAuthority(),
    ...overrides,
  };
}
