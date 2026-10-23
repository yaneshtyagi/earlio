import { z } from 'zod';
import type { Ctx, Tx } from '../../db/pool';
import type { Services } from '../../services';
import { DomainError, conflict, forbidden, invalid, notFound } from '../../kernel/errors';
import { audit } from '../../platform/audit';
import { emit } from '../../platform/outbox';
import { diffJson } from './diff';

const timers = z.object({ responseHours: z.number().positive(), escalateAfterHours: z.number().positive(), timeoutAfterHours: z.number().positive() })
  .refine((t) => t.escalateAfterHours >= t.responseHours && t.timeoutAfterHours > t.escalateAfterHours, { message: 'Timers must satisfy: response ≤ escalation < timeout.' });

/** Platform settings that change behaviour. Each is governed: a proposal by one administrator, a decision by another. */
export const SETTINGS = {
  dispute_timers: { label: 'Dispute timers', help: 'Hours before a quiet dispute escalates and before an undecided one times out.', schema: timers, fallback: { responseHours: 48, escalateAfterHours: 72, timeoutAfterHours: 240 } },
  dunning_days: { label: 'Reminder days after the due date', help: 'Days overdue on which the buyer is reminded.', schema: z.array(z.number().int().min(1).max(365)).min(1).max(6).refine((a) => a.every((x, i) => i === 0 || x > a[i - 1]!), { message: 'Days must be increasing.' }), fallback: [1, 7, 30] },
  export_realisation_months: { label: 'Export realisation period (months)', help: 'Months from shipment to realise export proceeds. Confirm with counsel.', schema: z.number().int().min(1).max(24), fallback: 9 },
  recourse_causes: { label: 'Supplier-caused dispute causes', help: 'Decision causes that create recourse to the bank.', schema: z.array(z.string().regex(/^[a-z_]{3,40}$/)).min(1).max(12), fallback: ['non_delivery', 'quality_failure', 'wrong_documents', 'misrepresentation'] },
  dispute_window_hours: { label: 'Dispute window after acceptance (hours)', help: 'Cannot be set below the platform guardrail of 24 hours.', schema: z.number().min(24).max(720), fallback: 24 },
  governing_law: { label: 'Governing law text', help: 'Appears in the assignment notice. Needs counsel review.', schema: z.string().min(10).max(300), fallback: 'the laws of India, with the courts at Mumbai having jurisdiction' },
  mode: { label: 'Operating mode', help: 'Network: every invited bank can offer. White-label: only the partner bank.', schema: z.enum(['network', 'white-label']), fallback: 'network' },
} as const;
export type SettingKey = keyof typeof SETTINGS;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

export async function currentSetting(tx: Tx, svc: Services, key: SettingKey): Promise<any> {
  const r = await tx.elevated(() => tx.maybe<{ value: any }>('select value from platform.settings where key = $1', [key]));
  if (r) return r.value;
  return key === 'mode' ? svc.config.mode : SETTINGS[key].fallback;
}

export const currentMode = async (tx: Tx, svc: Services): Promise<'network' | 'white-label'> => currentSetting(tx, svc, 'mode');

export interface ChangeRow { id: string; key: SettingKey; before: any; after: any; status: string; note: string | null; proposed_by: string; proposed_at: Date; decided_by: string | null; decided_at: Date | null; decision_note: string | null }

export async function proposeSetting(tx: Tx, svc: Services, ctx: Ctx, key: string, value: unknown, note?: string): Promise<ChangeRow> {
  if (!(key in SETTINGS)) throw invalid(`"${key}" is not a governed setting.`);
  const def = SETTINGS[key as SettingKey];
  const parsed = def.schema.safeParse(value);
  if (!parsed.success) throw new DomainError('invalid_setting', parsed.error.issues.map((i) => i.message).join('; '), 422);
  const now = svc.clock.now();
  const before = await currentSetting(tx, svc, key as SettingKey);
  if (JSON.stringify(before) === JSON.stringify(parsed.data)) throw conflict('no_change', 'That is already the current value.');
  await tx.query("update platform.setting_changes set status = 'withdrawn', decided_by = $2, decided_at = $3, decision_note = 'Replaced by a newer proposal' where key = $1 and status = 'pending'", [key, ctx.userId, now]);
  const row = await tx.one<ChangeRow>(
    `insert into platform.setting_changes (key, before, after, note, proposed_by, proposed_at) values ($1,$2,$3,$4,$5,$6) returning *`,
    [key, JSON.stringify(before), JSON.stringify(parsed.data), note ?? null, ctx.userId, now]);
  await audit(tx, ctx, now, { action: 'settings.proposed', entityType: 'setting', entityId: key, before, after: parsed.data });
  await emit(tx, now, 'settings.pending', { changeId: row.id, key }, []);
  return row;
}

/** The checker must be a different person from the maker. Approving applies the value. */
export async function decideSetting(tx: Tx, svc: Services, ctx: Ctx, id: string, approve: boolean, note?: string): Promise<ChangeRow> {
  const c = await tx.maybe<ChangeRow>('select * from platform.setting_changes where id = $1 for update', [id]);
  if (!c) throw notFound('Settings change');
  if (c.status !== 'pending') throw conflict('not_pending', `This change is already ${c.status}.`);
  if (c.proposed_by === ctx.userId) throw forbidden('You proposed this change, so a different administrator must decide it.');
  const now = svc.clock.now();
  if (approve) {
    await tx.query('insert into platform.settings (key, value, updated_at) values ($1,$2,$3) on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at', [c.key, JSON.stringify(c.after), now]);
  }
  const row = await tx.one<ChangeRow>("update platform.setting_changes set status = $2, decided_by = $3, decided_at = $4, decision_note = $5 where id = $1 returning *", [id, approve ? 'applied' : 'rejected', ctx.userId, now, note ?? null]);
  await audit(tx, ctx, now, { action: approve ? 'settings.applied' : 'settings.rejected', entityType: 'setting', entityId: c.key, before: c.before, after: approve ? c.after : null });
  await emit(tx, now, approve ? 'settings.applied' : 'settings.rejected', { changeId: id, key: c.key }, []);
  return row;
}

export const settingChanges = (tx: Tx, status?: string) =>
  tx.query<ChangeRow & { proposer: string | null; decider: string | null }>(
    `select c.*, u.name as proposer, d.name as decider from platform.setting_changes c left join identity.users u on u.id = c.proposed_by left join identity.users d on d.id = c.decided_by
      where ($1::text is null or c.status = $1) order by c.proposed_at desc limit 100`, [status ?? null]);

export const changeDiff = (c: ChangeRow) => diffJson(c.before, c.after, c.key);
