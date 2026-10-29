import pg from 'pg';
import { migrate } from '../src/db/migrate';
import { loadEnv } from '../src/kernel/env';

const TEMPLATE = 'earlio_template';

/** Same server as the app, a different database name (the connection string's database is replaced). */
export const withDatabase = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = '/' + db;
  return u.toString();
};

/**
 * Tests run against the Postgres server configured in apps/api/.env (or the environment):
 * MIGRATE_DATABASE_URL must be a superuser (creates/drops databases), DATABASE_URL is the RLS-bound app role.
 * A fully migrated template database is built once; each test file clones it.
 */
export async function setup() {
  loadEnv();
  const admin = process.env.MIGRATE_DATABASE_URL;
  const app = process.env.DATABASE_URL;
  if (!admin || !app) throw new Error('Tests need MIGRATE_DATABASE_URL (superuser) and DATABASE_URL (app role) in apps/api/.env or the environment.');
  const c = new pg.Client({ connectionString: withDatabase(admin, 'postgres') });
  await c.connect();
  await c.query(`drop database if exists ${TEMPLATE} with (force)`);
  await c.query(`create database ${TEMPLATE}`);
  await c.end();
  await migrate(withDatabase(admin, TEMPLATE));
  process.env.EARLIO_TEST_ADMIN_URL = admin;
  process.env.EARLIO_TEST_APP_URL = app;
}

export async function teardown() {
  const admin = process.env.EARLIO_TEST_ADMIN_URL;
  if (!admin) return;
  const c = new pg.Client({ connectionString: withDatabase(admin, 'postgres') });
  await c.connect();
  await c.query(`drop database if exists ${TEMPLATE} with (force)`);
  await c.end();
}
