import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app';
import { loadConfig } from './kernel/config';
import { SystemClock } from './kernel/clock';
import { Db } from './db/pool';

// The contract between API and web: docs/openapi.json (no database needed to generate it).
const config = loadConfig({ env: 'test', databaseUrl: 'postgres://unused@localhost/unused' });
const db = new Db(config.databaseUrl, 1);
const app = await buildApp({ config, db, clock: new SystemClock(), adapters: {} });
await app.ready();
const out = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/openapi.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(app.swagger(), null, 2) + '\n');
console.log('wrote', out);
await app.close();
await db.close();
