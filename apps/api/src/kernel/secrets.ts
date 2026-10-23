/**
 * Secret access goes through this interface so that a managed vault (AWS Secrets Manager, HashiCorp Vault, Azure Key Vault)
 * can replace environment variables without touching callers. Only the environment provider ships in the MVP.
 */
export interface SecretProvider { get(name: string): string | undefined }
export const envSecrets: SecretProvider = { get: (name) => process.env[name] };
const DEV_DEFAULTS: Record<string, string> = { WEBHOOK_KEY: 'earlio-dev-webhook-key' };

/** Production refuses to start on a development default or a missing secret. */
export function requireSecret(provider: SecretProvider, name: string, env: string): string {
  const v = provider.get(name);
  if (env === 'production') {
    if (!v || v === DEV_DEFAULTS[name] || v.length < 24) throw new Error(`${name} must be set to a strong secret (at least 24 characters) in production.`);
    return v;
  }
  return v ?? DEV_DEFAULTS[name] ?? '';
}
