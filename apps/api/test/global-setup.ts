import pg from 'pg';
import { migrate } from '../src/db/migrate';
import { startPostgres, type RunningPostgres } from '../src/testing/pgserver';

let server: RunningPostgres;

/** One Postgres per test run; a fully migrated template database that each test file clones. */
export async function setup() {
  server = await startPostgres();
  const c = new pg.Client({ connectionString: server.baseAdminUrl('postgres') });
  await c.connect();
  await c.query('create database earlio_template');
  await c.end();
  await migrate(server.baseAdminUrl('earlio_template'));
  process.env.EARLIO_TEST_PG_PORT = String(server.port);
}

export async function teardown() {
  await server?.stop();
}
