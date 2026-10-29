import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/** The API app root (apps/api), independent of the process working directory. */
export const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let loaded = false;

/**
 * Load configuration into process.env. Order of precedence:
 *   1. the .env file in the API app root (apps/api/.env)
 *   2. real environment variables, used when the .env file is missing (or does not define a variable)
 * Safe to call more than once.
 */
export function loadEnv(file = join(API_ROOT, '.env')): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(file)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (value !== undefined) process.env[key] = value;
  }
}
