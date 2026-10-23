import type { Config } from './kernel/config';
import type { Clock } from './kernel/clock';
import type { Db } from './db/pool';

/** Everything modules need from the outside world. Adapters are added here as milestones land. */
export interface Services {
  config: Config;
  db: Db;
  clock: Clock;
  adapters: Adapters;
}

// Filled in progressively by later milestones (kyc, sanctions, fx, payments, ...).
export interface Adapters {
  [name: string]: unknown;
}
