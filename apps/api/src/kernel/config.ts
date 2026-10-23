import { envSecrets, requireSecret } from './secrets';
export type EarlioEnv = 'development' | 'demo' | 'test' | 'production';

export interface Config {
  env: EarlioEnv;
  port: number;
  host: string;
  /** Connection used by the application (non-superuser, subject to RLS). */
  databaseUrl: string;
  /** Connection used only to run migrations (owner). Falls back to databaseUrl. */
  migrateDatabaseUrl: string;
  cookieSecure: boolean;
  corsOrigins: string[];
  /** Platform-wide default: 'network' (multi-bank) or 'white-label' (one partner bank). */
  mode: 'network' | 'white-label';
  simulatedBanner: boolean;
  /** Directory for the local-disk object store (development/test). */
  objectStoreDir: string;
  /** Master key from which per-bank webhook secrets are derived. Must be set in production. */
  webhookKey: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = (process.env.EARLIO_ENV ?? 'development') as EarlioEnv;
  const databaseUrl = process.env.DATABASE_URL ?? '';
  return {
    env,
    port: Number(process.env.PORT ?? 4000),
    host: process.env.HOST ?? '0.0.0.0',
    databaseUrl,
    migrateDatabaseUrl: process.env.MIGRATE_DATABASE_URL ?? databaseUrl,
    cookieSecure: env === 'production',
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(','),
    mode: (process.env.EARLIO_MODE as Config['mode']) ?? 'network',
    simulatedBanner: env !== 'production',
    objectStoreDir: process.env.OBJECT_STORE_DIR ?? '.data/objects',
    webhookKey: requireSecret(envSecrets, 'WEBHOOK_KEY', env),
    ...overrides,
  };
}

export const isDevLike = (c: Config) => c.env === 'development' || c.env === 'demo' || c.env === 'test';
