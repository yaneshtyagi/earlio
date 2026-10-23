import { DomainError } from '../../kernel/errors';
import type { CustomField } from '../terms/schema';

/** Validate the answers to a bank's or insurer's custom fields (CT-10). Returns the cleaned answers. */
export function validateAnswers(fields: CustomField[], extra: Record<string, unknown> | undefined, appliesTo: CustomField['appliesTo']): Record<string, string | number> {
  const mine = fields.filter((f) => f.appliesTo === appliesTo);
  const out: Record<string, string | number> = {};
  const problems: string[] = [];
  for (const f of mine) {
    const raw = extra?.[f.key];
    const empty = raw === undefined || raw === null || String(raw).trim() === '';
    if (empty) { if (f.required) problems.push(`"${f.label}" is required.`); continue; }
    if (f.type === 'number') { const n = Number(raw); if (!Number.isFinite(n)) { problems.push(`"${f.label}" must be a number.`); continue; } out[f.key] = n; }
    else if (f.type === 'date') { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw)) || Number.isNaN(Date.parse(String(raw)))) { problems.push(`"${f.label}" must be a date (YYYY-MM-DD).`); continue; } out[f.key] = String(raw); }
    else if (f.type === 'select') { if (!f.options?.includes(String(raw))) { problems.push(`"${f.label}" must be one of: ${f.options?.join(', ')}.`); continue; } out[f.key] = String(raw); }
    else { const s = String(raw).trim(); if (s.length > 500) { problems.push(`"${f.label}" is too long.`); continue; } out[f.key] = s; }
  }
  if (problems.length) throw new DomainError('missing_information', problems.join(' '), 422, { fields: problems });
  return out;
}
