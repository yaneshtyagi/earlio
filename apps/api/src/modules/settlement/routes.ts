import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { platformCtx, requireOrgType, requirePerm, requireUser } from '../../http/context';
import { DomainError, forbidden, invalid, notFound } from '../../kernel/errors';
import { isDevLike } from '../../kernel/config';
import { VirtualClock } from '../../kernel/clock';
import { DEFAULT_FAULTS, signWebhook, verifySignature, webhookSecret } from '../../adapters/payments';
import { audit } from '../../platform/audit';
import type { Ctx } from '../../db/pool';
import { HOLIDAYS, HOLIDAYS_VERIFY } from './calendars';
import { ingestBankTransaction, resolveException } from './collection';
import { simFaults } from './disbursement';

const iso = (d: any) => (d == null ? null : d instanceof Date ? d.toISOString() : String(d));
const day = (d: any) => (d == null ? null : String(d).slice(0, 10));
const money = z.string();
const WEBHOOK_TOLERANCE_MS = 5 * 60_000;

const expOut = z.object({
  id: z.string(), invoiceId: z.string(), invoiceNumber: z.string(), reference: z.string(), status: z.string(), currency: z.string(),
  expectedAmount: money, receivedAmount: money, dueDate: z.string(), late: z.boolean(), advanceAmount: money, retentionAmount: money,
  collectionAccount: z.object({ name: z.string(), number: z.string(), swift: z.string(), bankName: z.string() }),
  buyerName: z.string(), supplierName: z.string(), createdAt: z.string(),
});
const excOut = z.object({ id: z.string(), type: z.string(), invoiceNumber: z.string().nullable(), amount: z.string().nullable(), currency: z.string().nullable(), detail: z.string(), status: z.string(), resolution: z.string().nullable(), createdAt: z.string(), resolvedAt: z.string().nullable(), allowedActions: z.array(z.string()) });
const ALLOWED: Record<string, string[]> = {
  Unmatched: ['assign'], ShortPaid: ['wait', 'accept_short'], OverPaid: ['refund'], Late: ['acknowledge'],
  AmountMismatch: ['accept_credit', 'acknowledge'], DisbursementFailed: ['acknowledge'], DisbursementReturned: ['acknowledge'],
};
const webhookBody = z.object({ bankTxnId: z.string().min(1).max(80), reference: z.string().max(80).nullable().optional(), currency: z.enum(['USD', 'SGD']), amount: z.string().regex(/^\d+(\.\d{1,2})?$/), valueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), payer: z.string().max(120).nullable().optional() });

export function settlementRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const svc = app.svc;
  const ctxOf = (req: FastifyRequest): Ctx => (req.auth!.orgType === 'platform' ? platformCtx(req) : req.ctx);
  const opsOnly = async (req: FastifyRequest, reply: any) => {
    await requirePerm('settlement:operate')(req, reply);
    if (!['bank', 'platform'].includes(req.auth!.orgType!)) throw forbidden('Settlement operations are for banks and platform staff.');
  };

  const EXP_SQL = `select e.*, a.account_name, a.account_number, a.swift, bk.legal_name as bank_name, b.legal_name as buyer_name, s.legal_name as supplier_name
    from settlement.expectations e join settlement.collection_accounts a on a.id = e.collection_account_id
    join identity.organisations bk on bk.id = e.bank_org_id join identity.organisations b on b.id = e.buyer_org_id join identity.organisations s on s.id = e.supplier_org_id`;
  const toExp = (e: any) => ({
    id: e.id, invoiceId: e.invoice_id, invoiceNumber: e.invoice_number, reference: e.reference, status: e.status, currency: e.currency, expectedAmount: e.expected_amount, receivedAmount: e.received_amount,
    dueDate: day(e.due_date)!, late: e.late, advanceAmount: e.advance_amount, retentionAmount: e.retention_amount,
    collectionAccount: { name: e.account_name, number: e.account_number, swift: e.swift, bankName: e.bank_name }, buyerName: e.buyer_name, supplierName: e.supplier_name, createdAt: iso(e.created_at)!,
  });

  // ---------------- what the buyer must pay (BUY-07) and where
  r.get('/api/v1/settlement/payments-due', {
    preHandler: requireOrgType('buyer'),
    schema: { tags: ['settlement'], summary: 'Invoices I must pay, with the payment reference and collection account', response: { 200: z.object({ items: z.array(expOut) }) } },
  }, async (req) => svc.db.tx(req.ctx, async (tx) => ({
    items: (await tx.query<any>(`${EXP_SQL} where e.buyer_org_id = app.org_id() order by e.due_date, e.invoice_number`)).map(toExp),
  })));

  r.get('/api/v1/settlement/expectations', {
    preHandler: opsOnly,
    schema: { tags: ['settlement'], summary: 'Expected buyer payments (bank operations / platform)', querystring: z.object({ status: z.string().optional() }), response: { 200: z.object({ items: z.array(expOut) }) } },
  }, async (req) => svc.db.tx(ctxOf(req), async (tx) => ({
    items: (await tx.query<any>(`${EXP_SQL} ${req.query.status ? 'where e.status = $1' : ''} order by e.due_date, e.invoice_number`, req.query.status ? [req.query.status] : [])).map(toExp),
  })));

  r.get('/api/v1/settlement/transactions', {
    preHandler: opsOnly,
    schema: { tags: ['settlement'], summary: 'Bank transactions received (callbacks and statement lines)',
      response: { 200: z.object({ items: z.array(z.object({ id: z.string(), source: z.string(), bankTxnId: z.string(), reference: z.string().nullable(), currency: z.string(), amount: z.string(), valueDate: z.string(), payer: z.string().nullable(), matchStatus: z.string(), invoiceNumber: z.string().nullable() })) }) } },
  }, async (req) => svc.db.tx(ctxOf(req), async (tx) => ({
    items: (await tx.query<any>(`select t.*, e.invoice_number from settlement.bank_transactions t left join settlement.expectations e on e.id = t.expectation_id order by t.created_at desc, t.id limit 300`))
      .map((t) => ({ id: t.id, source: t.source, bankTxnId: t.bank_txn_id, reference: t.reference, currency: t.currency, amount: t.amount, valueDate: day(t.value_date)!, payer: t.payer, matchStatus: t.match_status, invoiceNumber: t.invoice_number })),
  })));

  r.get('/api/v1/settlement/exceptions', {
    preHandler: opsOnly,
    schema: { tags: ['settlement'], summary: 'Settlement exceptions queue', querystring: z.object({ status: z.enum(['open', 'resolved']).optional() }), response: { 200: z.object({ items: z.array(excOut) }) } },
  }, async (req) => svc.db.tx(ctxOf(req), async (tx) => ({
    items: (await tx.query<any>(`select * from settlement.exceptions ${req.query.status ? 'where status = $1' : ''} order by created_at desc, id`, req.query.status ? [req.query.status] : []))
      .map((e) => ({ id: e.id, type: e.type, invoiceNumber: e.invoice_number, amount: e.amount, currency: e.currency, detail: e.detail, status: e.status, resolution: e.resolution, createdAt: iso(e.created_at)!, resolvedAt: iso(e.resolved_at), allowedActions: e.status === 'open' ? ALLOWED[e.type] ?? [] : [] })),
  })));

  r.post('/api/v1/settlement/exceptions/:id/resolve', {
    preHandler: opsOnly,
    schema: { tags: ['settlement'], summary: 'Resolve an exception (assign, wait, accept short payment, refund, acknowledge)', params: z.object({ id: z.string().uuid() }),
      body: z.object({ action: z.enum(['assign', 'wait', 'accept_short', 'refund', 'acknowledge', 'accept_credit']), note: z.string().max(500).optional(), invoiceNumber: z.string().max(40).optional() }),
      response: { 200: z.object({ resolution: z.string() }) } },
  }, async (req) => svc.db.tx(ctxOf(req), (tx) => resolveException(tx, svc, req.ctx, req.auth!.orgType === 'bank' ? req.auth!.orgId : null, req.params.id, req.body.action, req.body)));

  r.get('/api/v1/settlement/disbursements', {
    preHandler: requireUser,
    schema: { tags: ['settlement'], summary: 'Disbursements to suppliers with their status history (bank, supplier, platform)',
      querystring: z.object({ invoiceId: z.string().uuid().optional() }),
      response: { 200: z.object({ items: z.array(z.object({
        id: z.string(), invoiceId: z.string(), invoiceNumber: z.string(), status: z.string(), currency: z.string(), amountForeign: z.string(), fxRate: z.string(), fxMid: z.string(), fxSpreadPct: z.string(), amountInr: z.string(),
        valueDate: z.string(), cutoffMissed: z.boolean(), attempts: z.number(), failureReason: z.string().nullable(), reference: z.string(), creditedAt: z.string().nullable(), bankName: z.string(),
        events: z.array(z.object({ status: z.string(), note: z.string().nullable(), at: z.string() })) })) }) } },
  }, async (req) => svc.db.tx(ctxOf(req), async (tx) => {
    const rows = await tx.query<any>(`select d.*, b.legal_name as bank_name from settlement.disbursements d join identity.organisations b on b.id = d.bank_org_id ${req.query.invoiceId ? 'where d.invoice_id = $1' : ''} order by d.instructed_at desc limit 200`, req.query.invoiceId ? [req.query.invoiceId] : []);
    const items = [];
    for (const d of rows) {
      const ev = await tx.query<any>('select status, note, at from settlement.disbursement_events where disbursement_id = $1 order by id', [d.id]);
      items.push({ id: d.id, invoiceId: d.invoice_id, invoiceNumber: d.invoice_number, status: d.status, currency: d.currency, amountForeign: d.amount_foreign, fxRate: d.fx_rate, fxMid: d.fx_mid, fxSpreadPct: String(Number(d.fx_spread_pct)),
        amountInr: d.amount_inr, valueDate: day(d.value_date)!, cutoffMissed: d.cutoff_missed, attempts: d.attempts, failureReason: d.failure_reason, reference: d.reference, creditedAt: iso(d.credited_at), bankName: d.bank_name,
        events: ev.map((e) => ({ status: e.status, note: e.note, at: iso(e.at)! })) });
    }
    return { items };
  }));

  r.get('/api/v1/settlement/ledger/:invoiceId', {
    preHandler: requireUser,
    schema: { tags: ['settlement'], summary: 'Settlement ledger for one invoice', params: z.object({ invoiceId: z.string().uuid() }),
      response: { 200: z.object({ items: z.array(z.object({ id: z.string(), kind: z.string(), party: z.string(), currency: z.string(), amount: z.string(), amountInr: z.string().nullable(), fxRate: z.string().nullable(), note: z.string().nullable(), at: z.string() })) }) } },
  }, async (req) => svc.db.tx(ctxOf(req), async (tx) => ({
    items: (await tx.query<any>('select * from settlement.ledger_entries where invoice_id = $1 order by id', [req.params.invoiceId]))
      .map((l) => ({ id: l.id, kind: l.kind, party: l.party, currency: l.currency, amount: l.amount, amountInr: l.amount_inr, fxRate: l.fx_rate, note: l.note, at: iso(l.at)! })),
  })));

  // ---------------- signed bank webhook (public; the signature is the credential)
  app.register(async (a) => {
    a.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    a.post<{ Params: { bankId: string } }>('/api/v1/webhooks/bank/:bankId', {
      schema: { tags: ['settlement'], summary: 'Bank payment callback. Signed with HMAC-SHA256 over "timestamp.nonce.body" (headers x-earlio-timestamp, x-earlio-nonce, x-earlio-signature); replays are rejected.', hide: false },
    }, async (req, reply) => {
      const bankId = req.params.bankId;
      const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
      const ts = Number(req.headers['x-earlio-timestamp']);
      const nonce = String(req.headers['x-earlio-nonce'] ?? '');
      const sig = String(req.headers['x-earlio-signature'] ?? '');
      const unauth = (m: string) => new DomainError('bad_signature', m, 401);
      if (!/^[0-9a-f-]{36}$/i.test(bankId)) throw notFound('Bank');
      if (!ts || !nonce || !sig) throw unauth('Missing signature headers.');
      if (Math.abs(svc.clock.now().getTime() - ts) > WEBHOOK_TOLERANCE_MS) throw unauth('The timestamp is outside the allowed window.');
      const bank = await svc.db.system((tx) => tx.maybe<any>("select id from identity.organisations where id = $1 and type = 'bank'", [bankId]));
      if (!bank) throw notFound('Bank');
      if (!verifySignature(webhookSecret(svc.config.webhookKey, bankId), ts, nonce, raw, sig)) throw unauth('The signature does not match.');
      let parsed;
      try { parsed = webhookBody.parse(JSON.parse(raw)); } catch { throw invalid('The callback body is not valid.'); }
      const result = await svc.db.system(async (tx) => {
        const fresh = await tx.query("insert into platform.webhook_nonces (nonce, bank_org_id, received_at) values ($1,$2,$3) on conflict do nothing returning nonce", [nonce, bankId, svc.clock.now()]);
        if (!fresh.length) throw new DomainError('replay', 'This callback was already received (replay rejected).', 409);
        await tx.query('insert into platform.integration_messages (adapter, direction, reference, payload, created_at) values ($1,$2,$3,$4,$5)', ['payments', 'callback', parsed.reference ?? null, raw, svc.clock.now()]);
        return ingestBankTransaction(tx, svc, { platform: true, correlationId: `webhook-${nonce}` }, bankId, { source: 'callback', ...parsed, reference: parsed.reference ?? null });
      }, `webhook-${nonce}`);
      return reply.code(200).send({ received: true, outcome: result.outcome });
    });
  });

  // ---------------- statement import (bank operations)
  r.post('/api/v1/settlement/statements/import', {
    preHandler: async (req, reply) => { await requireOrgType('bank')(req, reply); await requirePerm('settlement:operate')(req, reply); },
    schema: { tags: ['settlement'], summary: 'Import statement lines now (also fetched automatically each day)', body: z.object({ lines: z.array(webhookBody.extend({ amount: z.string() })).min(1).max(500) }),
      response: { 200: z.object({ imported: z.number(), duplicates: z.number() }) } },
  }, async (req) => {
    let imported = 0, duplicates = 0;
    await svc.db.tx(req.ctx, async (tx) => {
      for (const l of req.body.lines) {
        const x = await ingestBankTransaction(tx, svc, req.ctx, req.auth!.orgId!, { source: 'statement', ...l, reference: l.reference ?? null });
        x.duplicate ? duplicates++ : imported++;
      }
    });
    return { imported, duplicates };
  });

  // ---------------- simulator & control room (development / demo / test only)
  if (isDevLike(svc.config)) {
    const admin = requirePerm('platform:admin');
    r.post('/api/v1/sim/pay', {
      preHandler: admin,
      schema: { tags: ['sim'], summary: 'Simulate the buyer paying an invoice (callback and/or statement line)', body: z.object({
        invoiceNumber: z.string().optional(), reference: z.string().optional(), amount: z.string().optional(), via: z.enum(['both', 'callback', 'statement']).default('both'), payer: z.string().optional() }),
        response: { 200: z.object({ bankTxnId: z.string(), reference: z.string().nullable(), amount: z.string(), callbackOutcome: z.string().nullable() }) } },
    }, async (req) => {
      const c = platformCtx(req);
      const info = await svc.db.tx(c, async (tx) => {
        const e = req.body.invoiceNumber ? await tx.maybe<any>('select * from settlement.expectations where invoice_number = $1', [req.body.invoiceNumber.toUpperCase()]) : undefined;
        if (!e && !req.body.reference) throw notFound('Collection for that invoice');
        const bankId = e?.bank_org_id ?? (await tx.one<any>("select id from identity.organisations where type = 'bank' order by legal_name limit 1")).id;
        const n = (await tx.one<any>('select count(*)::int as n from settlement.sim_bank_feed')).n + 1;
        const txn = {
          bankId, bankTxnId: `SIMTXN-${String(n).padStart(5, '0')}`, reference: req.body.reference ?? e?.reference ?? null, currency: e?.currency ?? 'USD',
          amount: req.body.amount ?? e?.expected_amount ?? '0.00', valueDate: svc.clock.now().toISOString().slice(0, 10), payer: req.body.payer ?? (e ? `${e.buyer_org_id.slice(0, 8)} remittance` : 'Unknown payer'),
        };
        await tx.query('insert into settlement.sim_bank_feed (bank_org_id, bank_txn_id, reference, currency, amount, value_date, payer, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8)',
          [txn.bankId, txn.bankTxnId, txn.reference, txn.currency, txn.amount, txn.valueDate, txn.payer, svc.clock.now()]);
        await audit(tx, c, svc.clock.now(), { action: 'sim.pay', entityType: 'bank_transaction', entityId: txn.bankTxnId, orgId: txn.bankId, after: txn });
        return txn;
      });
      let outcome: string | null = null;
      if (req.body.via !== 'statement') {
        const body = JSON.stringify({ bankTxnId: info.bankTxnId, reference: info.reference, currency: info.currency, amount: info.amount, valueDate: info.valueDate, payer: info.payer });
        const ts = svc.clock.now().getTime(), nonce = randomUUID();
        const res = await app.inject({ method: 'POST', url: `/api/v1/webhooks/bank/${info.bankId}`, payload: body,
          headers: { 'content-type': 'application/json', 'x-earlio-timestamp': String(ts), 'x-earlio-nonce': nonce, 'x-earlio-signature': signWebhook(webhookSecret(svc.config.webhookKey, info.bankId), ts, nonce, body) } });
        if (res.statusCode !== 200) throw new DomainError('sim_callback_failed', `Callback rejected: ${res.body}`, 502);
        outcome = res.json().outcome;
      }
      return { bankTxnId: info.bankTxnId, reference: info.reference, amount: info.amount, callbackOutcome: outcome };
    });

    r.get('/api/v1/admin/sim-settings', {
      preHandler: admin, schema: { tags: ['sim'], summary: 'Fault-injection settings', response: { 200: z.object({ disbursement: z.enum(['none', 'reject', 'timeout', 'mismatch', 'return', 'random']), seed: z.number() }) } },
    }, async (req) => svc.db.tx(platformCtx(req), (tx) => simFaults(tx)));
    r.put('/api/v1/admin/sim-settings', {
      preHandler: admin, schema: { tags: ['sim'], summary: 'Set fault injection for the simulated bank', body: z.object({ disbursement: z.enum(['none', 'reject', 'timeout', 'mismatch', 'return', 'random']), seed: z.number().int().optional() }),
        response: { 200: z.object({ disbursement: z.string(), seed: z.number() }) } },
    }, async (req) => svc.db.tx(platformCtx(req), async (tx) => {
      const v = { disbursement: req.body.disbursement, seed: req.body.seed ?? DEFAULT_FAULTS.seed };
      await tx.query(`insert into platform.settings (key, value, updated_at) values ('sim.faults', $1, $2) on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`, [JSON.stringify(v), svc.clock.now()]);
      await audit(tx, platformCtx(req), svc.clock.now(), { action: 'sim.faults_set', entityType: 'settings', entityId: 'sim.faults', after: v });
      return v;
    }));

    r.get('/api/v1/admin/clock', {
      preHandler: admin, schema: { tags: ['sim'], summary: 'Platform time', response: { 200: z.object({ now: z.string(), virtual: z.boolean() }) } },
    }, async () => ({ now: svc.clock.now().toISOString(), virtual: svc.clock instanceof VirtualClock }));
    r.post('/api/v1/admin/clock', {
      preHandler: admin, schema: { tags: ['sim'], summary: 'Move the virtual clock (development / demo only)',
        body: z.object({ advanceHours: z.number().min(0).max(24 * 400).optional(), advanceDays: z.number().min(0).max(400).optional(), setTo: z.string().optional(), reset: z.boolean().optional() }),
        response: { 200: z.object({ now: z.string() }) } },
    }, async (req) => {
      if (!(svc.clock instanceof VirtualClock)) throw new DomainError('clock_fixed', 'This environment runs on real time.', 409);
      const b = req.body;
      if (b.reset) svc.clock.reset();
      if (b.setTo) { const d = new Date(b.setTo); if (isNaN(d.getTime())) throw invalid('That is not a valid date-time.'); svc.clock.setTo(d); }
      if (b.advanceDays) svc.clock.advanceDays(b.advanceDays);
      if (b.advanceHours) svc.clock.advanceHours(b.advanceHours);
      await svc.db.tx(platformCtx(req), (tx) => audit(tx, platformCtx(req), svc.clock.now(), { action: 'sim.clock_moved', entityType: 'clock', entityId: 'virtual', after: b }));
      return { now: svc.clock.now().toISOString() };
    });
  }

  // ---------------- read-only admin views
  r.get('/api/v1/admin/calendars', {
    preHandler: requirePerm('platform:admin'),
    schema: { tags: ['admin'], summary: 'Holiday calendars used for value dates', response: { 200: z.object({ verifyBeforeProduction: z.boolean(), calendars: z.record(z.string(), z.array(z.object({ date: z.string(), name: z.string() }))) }) } },
  }, async () => ({ verifyBeforeProduction: HOLIDAYS_VERIFY, calendars: Object.fromEntries(Object.entries(HOLIDAYS).map(([k, v]) => [k, Object.entries(v).map(([date, name]) => ({ date, name }))])) }));

  r.get('/api/v1/admin/integration-messages', {
    preHandler: requirePerm('audit:read'),
    schema: { tags: ['admin'], summary: 'Messages sent to and received from simulated external systems', querystring: z.object({ adapter: z.string().optional() }),
      response: { 200: z.object({ items: z.array(z.object({ id: z.string(), adapter: z.string(), direction: z.string(), reference: z.string().nullable(), payload: z.any(), createdAt: z.string() })) }) } },
  }, async (req) => svc.db.tx(platformCtx(req), async (tx) => ({
    items: (await tx.query<any>(`select * from platform.integration_messages ${req.query.adapter ? 'where adapter = $1' : ''} order by id desc limit 200`, req.query.adapter ? [req.query.adapter] : []))
      .map((m) => ({ id: String(m.id), adapter: m.adapter, direction: m.direction, reference: m.reference, payload: m.payload, createdAt: iso(m.created_at)! })),
  })));
}
