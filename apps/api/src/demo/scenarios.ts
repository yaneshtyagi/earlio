import type { FastifyInstance } from 'fastify';
import type { Services } from '../services';
import { Driver, type Sess } from './driver';

/** The pilot "today". Every scenario invoice is dated relative to it. */
export const DEMO_TODAY = '2026-11-02T04:00:00.000Z';
const START = '2026-04-25T04:00:00.000Z';
const day = (iso: string) => iso.slice(0, 10);
const addDays = (iso: string, n: number) => new Date(new Date(iso).getTime() + n * 86_400_000).toISOString();

export interface ScenarioInvoice { label: string; id: string; humanId: string; state: string }

interface Spec { label: string; supplier: string; buyer: string; ccy: 'USD' | 'SGD'; amount: string; issue: string; due: string; po?: string }

/**
 * Appendix A of the POC plan: thirteen invoices in thirteen states, produced by driving the real API and moving the virtual clock,
 * so every record, audit entry, ledger line and notification is genuine. Labels INV-1001..INV-1013 map to the generated invoice numbers.
 */
export async function seedScenarios(app: FastifyInstance, svc: Services): Promise<ScenarioInvoice[]> {
  const d = new Driver(app, svc);
  const done = await svc.db.system((tx) => tx.maybe<{ value: ScenarioInvoice[] }>("select value from platform.settings where key = 'demo_scenarios'"));
  if (done) return done.value;
  const out: ScenarioInvoice[] = [];
  const record = (label: string, inv: { id: string; humanId: string }, state: string) => { out.push({ label, id: inv.id, humanId: inv.humanId, state }); };

  // ---- building blocks (all through the API)
  async function create(s: Spec) {
    const sup = await d.as(s.supplier, 'FinanceUser');
    const b = await orgId(s.buyer);
    const inv = await d.ok(`create ${s.label}`, sup.req('POST', '/api/v1/invoices', { buyerOrgId: b, number: s.label, currency: s.ccy, amount: s.amount, issueDate: day(s.issue), dueDate: day(s.due), ...(s.po ? { poNumber: s.po } : {}) }));
    return { id: inv.id as string, humanId: inv.humanId as string, spec: s };
  }
  const orgIds: Record<string, string> = {};
  async function orgId(slug: string) {
    if (orgIds[slug]) return orgIds[slug]!;
    const names: Record<string, string> = { shree: 'Shree Textiles', kumar: 'Kumar Precision', anand: 'Anand Handicrafts', deccan: 'Deccan Agro Exports', northwind: 'Northwind Retail Inc.', lakeshore: 'Lakeshore Outfitters LLC', merlion: 'Merlion Electronics Pte Ltd', kallang: 'Kallang Home Pte Ltd', zarnitsa: 'Zarnitsa Trading Ltd' };
    const r = await svc.db.system((tx) => tx.one<{ id: string }>('select id from identity.organisations where legal_name = $1', [names[slug]]));
    return (orgIds[slug] = r.id);
  }
  async function docs(inv: { id: string; spec: Spec }) {
    const sup = await d.as(inv.spec.supplier, 'FinanceUser');
    for (const t of ['commercial_invoice', 'delivery_proof']) await d.ok(`doc ${t}`, sup.req('POST', `/api/v1/invoices/${inv.id}/documents`, { docType: t, fileId: await d.upload(sup, t + '.pdf') }));
  }
  async function submit(inv: { id: string; spec: Spec }) { await docs(inv); await d.ok('submit', (await d.as(inv.spec.supplier, 'FinanceUser')).req('POST', `/api/v1/invoices/${inv.id}/submit`)); }
  async function accept(inv: { id: string; spec: Spec }) {
    await submit(inv);
    await d.ok('accept', (await d.as(inv.spec.buyer, 'Approver')).req('POST', `/api/v1/invoices/${inv.id}/decision`, { decision: 'accept', undertakingAccepted: true }));
    await d.work();
  }
  const insurerFor = (buyer: string) => (['northwind', 'lakeshore'].includes(buyer) ? 'exportshield' : 'sentinel');
  async function cover(inv: { id: string; spec: Spec }) {
    const ins = insurerFor(inv.spec.buyer);
    if (ins === 'exportshield') {
      const c = await d.ok('cover', (await d.as(inv.spec.supplier, 'FinanceUser')).req('GET', `/api/v1/invoices/${inv.id}/cover`));
      await d.ok('approve cover', (await d.as('exportshield', 'Underwriter')).req('POST', `/api/v1/insurance/requests/${c.id}/decision`, { decision: 'approve' }));
    } else { // the API insurer answers after a short delay: let the worker poll it
      for (let i = 0; i < 12; i++) { await d.work(); const c = await (await d.as(inv.spec.supplier, 'FinanceUser')).req('GET', `/api/v1/invoices/${inv.id}/cover`); if (c.json?.status && c.json.status !== 'requested') return; d.advanceHours(2); }
      throw new Error(`${inv.spec.label}: the insurer API did not answer`);
    }
  }
  async function open(inv: { id: string; spec: Spec }) {
    await cover(inv);
    await d.ok('open funding', (await d.as(inv.spec.supplier, 'FinanceUser')).req('POST', `/api/v1/invoices/${inv.id}/open-funding`));
  }
  const status = async (inv: { id: string; spec: Spec }) => (await (await d.as(inv.spec.supplier, 'FinanceUser')).req('GET', `/api/v1/invoices/${inv.id}`)).json.status as string;
  async function offerFrom(bank: string, inv: { id: string }, body: object = {}) {
    return d.ok(`offer ${bank}`, (await d.as(bank, 'CreditOfficer')).req('POST', `/api/v1/invoices/${inv.id}/offers`, body));
  }
  /** Accepted → covered → offered by the partner bank → chosen → consent → assignment acknowledged → bank confirms → disbursed. */
  async function fund(inv: { id: string; spec: Spec }, bank = 'aurelia') {
    await open(inv);
    const o = await offerFrom(bank, inv);
    const sup = await d.as(inv.spec.supplier, 'FinanceUser');
    const fr = await d.ok('select offer', sup.req('POST', `/api/v1/offers/${o.id}/select`));
    await d.ok('consent', (await d.as(inv.spec.supplier, 'Approver')).req('POST', `/api/v1/financing-requests/${fr.id}/consent`));
    await d.ok('assignment ack', (await d.as(inv.spec.buyer, 'Approver')).req('POST', `/api/v1/invoices/${inv.id}/assignment-ack`));
    d.advanceHours(25);
    await d.ok('confirm', (await d.as(bank, 'CreditOfficer')).req('POST', `/api/v1/financing-requests/${fr.id}/confirm`));
    for (let i = 0; i < 24 && (await status(inv)) !== 'Funded'; i++) { await d.work(); if ((await status(inv)) === 'Funded') break; d.advanceHours(6); }
    if ((await status(inv)) !== 'Funded') throw new Error(`${inv.spec.label} did not reach Funded`);
    return fr.id as string;
  }
  const paySettled = async (inv: { humanId: string }) => { await d.ok('buyer pays', (await d.as('earlio', 'PlatformAdmin')).req('POST', '/api/v1/sim/pay', { invoiceNumber: inv.humanId })); for (let i = 0; i < 6; i++) { await d.work(); d.advanceHours(12); } };
  const at = async (iso: string) => { if (new Date(iso) < d.now()) throw new Error(`scenario timeline is behind: wanted ${iso}, clock is ${d.now().toISOString()}`); d.setTo(iso); await d.work(); };

  d.setTo(START);

  // ---- late April: INV-1011, funded now, will go overdue and default (insured Singapore buyer)
  const i1011 = await create({ label: 'INV-1011', supplier: 'anand', buyer: 'kallang', ccy: 'SGD', amount: '40000.00', issue: START, due: addDays(START, 44), po: 'PO-KH-0042' });
  await accept(i1011); await fund(i1011);

  // ---- August: INV-1008 funded, paid on its due date, settled
  await at('2026-08-03T04:00:00.000Z');
  const i1008 = await create({ label: 'INV-1008', supplier: 'deccan', buyer: 'northwind', ccy: 'USD', amount: '250000.00', issue: d.now().toISOString(), due: addDays(d.now().toISOString(), 38), po: 'PO-NW-3310' });
  await accept(i1008); await fund(i1008);

  // ---- September: INV-1010 funded, will be 20 days overdue today
  await at('2026-09-01T04:00:00.000Z');
  const i1010 = await create({ label: 'INV-1010', supplier: 'shree', buyer: 'lakeshore', ccy: 'USD', amount: '55000.00', issue: d.now().toISOString(), due: '2026-10-13T00:00:00.000Z' });
  await accept(i1010); await fund(i1010);
  await at('2026-09-10T04:00:00.000Z'); await paySettled(i1008);

  // ---- October: INV-1011 defaults and the bank files its claim
  await at('2026-10-16T05:00:00.000Z'); await d.work(); await d.work();
  const bank = await d.as('aurelia', 'CreditOfficer');
  const claimDocs = [];
  for (const t of ['invoice', 'acceptance', 'delivery_proof', 'statement']) claimDocs.push({ docType: t, fileId: await d.upload(bank, `${t}.pdf`) });
  // the Singapore invoice was financed by the partner bank in this seed
  await d.ok('file claim', bank.req('POST', `/api/v1/invoices/${i1011.id}/claims`, { documents: claimDocs }));

  await at('2026-10-20T04:00:00.000Z');
  // INV-1009: funded, then the buyer disputes it (supplier-caused, still open)
  const i1009 = await create({ label: 'INV-1009', supplier: 'kumar', buyer: 'lakeshore', ccy: 'USD', amount: '70000.00', issue: d.now().toISOString(), due: addDays(d.now().toISOString(), 45) });
  await accept(i1009); await fund(i1009);

  // ---- the last week: funded invoices that mature in the future
  await at('2026-10-26T04:00:00.000Z');
  const i1006 = await create({ label: 'INV-1006', supplier: 'shree', buyer: 'northwind', ccy: 'USD', amount: '60000.00', issue: d.now().toISOString(), due: addDays(DEMO_TODAY, 40), po: 'PO-NW-2201' });
  await accept(i1006); await fund(i1006);
  const i1013 = await create({ label: 'INV-1013', supplier: 'shree', buyer: 'northwind', ccy: 'USD', amount: '60000.00', issue: d.now().toISOString(), due: addDays(DEMO_TODAY, 41), po: 'PO-NW-2201' });
  await accept(i1013); await fund(i1013);

  // INV-1009: the buyer disputes the funded invoice (supplier-caused); the dispute is still open today
  await d.ok('dispute', (await d.as('lakeshore', 'Approver')).req('POST', `/api/v1/invoices/${i1009.id}/disputes`, { reason: 'Part of the consignment was damaged; the supplier did not replace it.' }));

  // INV-1007: the buyer paid early
  const i1007 = await create({ label: 'INV-1007', supplier: 'anand', buyer: 'merlion', ccy: 'SGD', amount: '30000.00', issue: d.now().toISOString(), due: addDays(DEMO_TODAY, 50) });
  await accept(i1007); await cover(i1007);
  await d.ok('open', (await d.as('anand', 'FinanceUser')).req('POST', `/api/v1/invoices/${i1007.id}/open-funding`));
  await d.ok('schedule', (await d.as('anand', 'FinanceUser')).req('PUT', `/api/v1/invoices/${i1007.id}/discount-schedule`, { mode: 'table', entries: [{ payBy: day(addDays(DEMO_TODAY, 5)), discountPct: 1 }] }));
  d.advanceHours(26);
  await d.ok('early payment', (await d.as('merlion', 'Approver')).req('POST', `/api/v1/invoices/${i1007.id}/early-payment`, { payDate: day(addDays(DEMO_TODAY, 3)), fundingSource: 'cash' }));
  await d.work();

  // ---- today: the pipeline
  await at(DEMO_TODAY);
  const i1005 = await create({ label: 'INV-1005', supplier: 'kumar', buyer: 'merlion', ccy: 'USD', amount: '100000.00', issue: day(addDays(DEMO_TODAY, -2)), due: addDays(DEMO_TODAY, 55), po: 'PO-ML-0815' });
  await accept(i1005); await open(i1005);
  for (const b of ['aurelia', 'kestrel', 'harbour']) await offerFrom(b, i1005);
  const i1004 = await create({ label: 'INV-1004', supplier: 'shree', buyer: 'northwind', ccy: 'USD', amount: '100000.00', issue: day(addDays(DEMO_TODAY, -2)), due: addDays(DEMO_TODAY, 60), po: 'PO-NW-2201' });
  await accept(i1004);
  const i1003 = await create({ label: 'INV-1003', supplier: 'kumar', buyer: 'lakeshore', ccy: 'USD', amount: '85000.00', issue: day(addDays(DEMO_TODAY, -3)), due: addDays(DEMO_TODAY, 50) });
  await submit(i1003);
  await d.ok('reject', (await d.as('lakeshore', 'Approver')).req('POST', `/api/v1/invoices/${i1003.id}/decision`, { decision: 'reject', reason: 'Unit prices differ from the agreed price list.' }));
  const i1002 = await create({ label: 'INV-1002', supplier: 'anand', buyer: 'kallang', ccy: 'SGD', amount: '22500.00', issue: day(addDays(DEMO_TODAY, -1)), due: addDays(DEMO_TODAY, 45), po: 'PO-KH-0042' });
  await submit(i1002);
  const i1001 = await create({ label: 'INV-1001', supplier: 'shree', buyer: 'northwind', ccy: 'USD', amount: '48000.00', issue: day(DEMO_TODAY), due: addDays(DEMO_TODAY, 60), po: 'PO-NW-2201' });
  // INV-1012: the buyer was clear when the invoice was accepted; a later screening run confirms a sanctions hit, so funding is refused.
  const setSanctions = (hit: boolean) => svc.db.system((tx) => tx.query("update identity.organisations set blocked = $1, sanctions_status = $2 where legal_name = 'Zarnitsa Trading Ltd'", [hit, hit ? 'confirmed' : 'clear']));
  await setSanctions(false);
  const i1012 = await create({ label: 'INV-1012', supplier: 'kumar', buyer: 'zarnitsa', ccy: 'USD', amount: '35000.00', issue: day(addDays(DEMO_TODAY, -2)), due: addDays(DEMO_TODAY, 50) });
  await accept(i1012);
  await setSanctions(true);
  await d.ok('request funding (blocked)', (await d.as('kumar', 'FinanceUser')).req('POST', `/api/v1/invoices/${i1012.id}/open-funding`), 409, 422);

  // read back the real states
  for (const [l, inv] of [['INV-1001', i1001], ['INV-1002', i1002], ['INV-1003', i1003], ['INV-1004', i1004], ['INV-1005', i1005], ['INV-1006', i1006], ['INV-1007', i1007], ['INV-1008', i1008], ['INV-1009', i1009], ['INV-1010', i1010], ['INV-1011', i1011], ['INV-1012', i1012], ['INV-1013', i1013]] as const) {
    record(l, inv, await status(inv));
  }
  await svc.db.system((tx) => tx.query("insert into platform.settings (key, value, updated_at) values ('demo_scenarios', $1, $2) on conflict (key) do update set value = excluded.value", [JSON.stringify(out), d.now()]));
  return out;
}
