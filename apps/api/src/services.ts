import type { Config } from './kernel/config';
import type { Clock } from './kernel/clock';
import type { Db } from './db/pool';
import type { Adapters } from './adapters';

/** Everything modules need from the outside world. Adapters are added here as milestones land. */
export interface Services {
  config: Config;
  db: Db;
  clock: Clock;
  adapters: Adapters;
}

