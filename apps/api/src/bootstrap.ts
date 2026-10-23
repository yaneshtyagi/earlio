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

/** Build services from config. In dev/demo without DATABASE_URL an embedded Postgres is started. */
export async function bootstrap(overrides: Partial<Config> = {}): Promise<Bootstrapped & { stop: () => Promise<void> }> {
  let config = loadConfig(overrides);
  let stopPg: () => Promise<void> = async () => {};
  if (!config.databaseUrl) {
    if (!isDevLike(config)) throw new Error('DATABASE_URL is required outside development');
    const { startPostgres } = await import('./testing/pgserver');
    const pg = await startPostgres({ persistentDir: process.env.EARLIO_PGDATA ?? '.pgdata' });
    stopPg = pg.stop;
    config = { ...config, migrateDatabaseUrl: pg.adminUrl, databaseUrl: pg.appUrl };
  }
  await migrate(config.migrateDatabaseUrl || config.databaseUrl);
  const clock = isDevLike(config) ? new VirtualClock() : new SystemClock();
  const db = new Db(config.databaseUrl);
  const svc: Services = { config, db, clock, adapters: defaultAdapters(config) };
  if (isDevLike(config) && config.env !== 'test') {
    await db.system((tx) => seedDemo(tx, svc, { platform: true, correlationId: 'seed' }));
  }
  return { svc, clock, stop: async () => { await db.close(); await stopPg(); } };
}
