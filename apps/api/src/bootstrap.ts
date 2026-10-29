import { Db } from './db/pool';
import { migrate } from './db/migrate';
import { loadConfig, isDevLike, type Config } from './kernel/config';
import { SystemClock, VirtualClock, type Clock } from './kernel/clock';
import { defaultAdapters } from './adapters';
import type { Services } from './services';
import { seedDemo } from './modules/identity/seed';

export interface Bootstrapped {
  svc: Services;
  clock: Clock;
}

/** Build services from config. Requires DATABASE_URL (apps/api/.env, else the environment) pointing at a running Postgres. */
export async function bootstrap(overrides: Partial<Config> = {}): Promise<Bootstrapped & { stop: () => Promise<void> }> {
  const config = loadConfig(overrides);
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set. Define it in apps/api/.env or as an environment variable.');
  await migrate(config.migrateDatabaseUrl || config.databaseUrl);
  const clock = isDevLike(config) ? new VirtualClock() : new SystemClock();
  const db = new Db(config.databaseUrl);
  const svc: Services = { config, db, clock, adapters: defaultAdapters(config) };
  if (isDevLike(config) && config.env !== 'test') {
    await db.system((tx) => seedDemo(tx, svc, { platform: true, correlationId: 'seed' }));
  }
  return { svc, clock, stop: async () => { await db.close(); } };
}
