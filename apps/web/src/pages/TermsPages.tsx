import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, DataTable, SelectField, TabPanel, Tabs, TextField, TextareaField } from '@yaneshtyagi/design-system';
import { api, ensureOk, problemOf } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { diffJson } from '../shared/diff';
import { DiffTable } from './GovernancePages';
import { Hint, Loading, Notice, Page, Panel, Section as Sub, StatusChip, dd, dt, noRows, type Msg } from '../ui';

type Body = Record<string, any>;
type Owner = 'platform' | 'bank' | 'insurer';

const getP = (o: any, path: string): any => path.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
function setP(o: Body, path: string, v: unknown): Body {
  const [h, ...t] = path.split('.');
  const c: Body = { ...o };
  if (!t.length) { if (v === undefined) delete c[h!]; else c[h!] = v; return c; }
  const child = setP(o[h!] ?? {}, t.join('.'), v);
  if (Object.keys(child).length === 0) delete c[h!]; else c[h!] = child;
  return c;
}

// ---------------------------------------------------------------------------------------------- form editor
interface Fld { path: string; label: string; kind: 'number' | 'text' | 'bool' | 'select' | 'csv' | 'time'; options?: string[]; hint?: string }
interface FormSection { title: string; fields: Fld[] }
const TIERS = ['AA', 'A', 'BBB'];

const BANK: FormSection[] = [
  { title: 'Money', fields: [
    { path: 'advancePct', label: 'Advance (% of invoice)', kind: 'number' }, { path: 'processingFee.pct', label: 'Processing fee (%)', kind: 'number' }, { path: 'processingFee.minUsd', label: 'Processing fee minimum (USD)', kind: 'number' },
    { path: 'fxSpreadPct', label: 'FX margin (%)', kind: 'number', hint: 'Platform cap applies.' }, { path: 'platformFeePayer', label: 'Platform fee paid by', kind: 'select', options: ['bank', 'supplier'] },
  ] },
  { title: 'What the bank funds', fields: [
    { path: 'invoiceSizeUsd.min', label: 'Smallest invoice (USD)', kind: 'number' }, { path: 'invoiceSizeUsd.max', label: 'Largest invoice (USD)', kind: 'number' }, { path: 'maxTenorDays', label: 'Longest tenor (days)', kind: 'number' },
    { path: 'currencies', label: 'Currencies', kind: 'csv', hint: 'USD, SGD' }, { path: 'buyerCountries', label: 'Buyer countries', kind: 'csv', hint: 'US, SG' }, { path: 'minCoverPct', label: 'Minimum insurance cover (%)', kind: 'number' },
  ] },
  { title: 'Timing', fields: [
    { path: 'offerValidityHours', label: 'Offer valid for (hours)', kind: 'number' }, { path: 'cutoff.time', label: 'Daily cut-off (HH:MM)', kind: 'time' }, { path: 'cutoff.timezone', label: 'Cut-off time zone', kind: 'text' },
    { path: 'settlementDays', label: 'Settlement days', kind: 'number' }, { path: 'graceDays', label: 'Grace days after due date', kind: 'number' },
  ] },
];
const INSURER: FormSection[] = [
  { title: 'Cover', fields: [
    { path: 'coverPct', label: 'Cover (% of invoice)', kind: 'number' }, ...TIERS.map((t) => ({ path: `coverPctByTier.${t}`, label: `Cover for ${t} buyers (%)`, kind: 'number' as const })),
    { path: 'insuredEvents', label: 'Insured events', kind: 'csv', hint: 'insolvency, protracted_default' },
  ] },
  { title: 'Waiting and claims', fields: [
    { path: 'waitingPeriodDays.protractedDefault', label: 'Waiting period, non-payment (days)', kind: 'number' }, { path: 'waitingPeriodDays.insolvency', label: 'Waiting period, insolvency (days)', kind: 'number' },
    { path: 'claimDeadlineDays', label: 'Claim deadline after waiting (days)', kind: 'number' }, { path: 'exclusions', label: 'Exclusions', kind: 'csv' }, { path: 'claimDocuments', label: 'Claim documents', kind: 'csv', hint: 'invoice, acceptance, delivery_proof, statement' },
  ] },
  { title: 'Premium and limits', fields: [
    { path: 'premium.mode', label: 'Premium mode', kind: 'select', options: ['per_period', 'flat'] }, { path: 'premium.payer', label: 'Premium paid by', kind: 'select', options: ['supplier', 'bank'] },
    { path: 'premium.periodDays', label: 'Premium period (days)', kind: 'number' }, { path: 'premium.flatRatePct', label: 'Flat premium (%)', kind: 'number' },
    ...TIERS.map((t) => ({ path: `premium.ratePctByTier.${t}`, label: `Premium for ${t} buyers (% per period)`, kind: 'number' as const })),
    { path: 'limits.perBuyerUsd', label: 'Limit per buyer (USD)', kind: 'number' }, { path: 'limits.portfolioUsd', label: 'Portfolio limit (USD)', kind: 'number' },
  ] },
];
const PLATFORM: FormSection[] = [
  { title: 'Fees and benchmark', fields: [
    { path: 'benchmarkRatePct', label: 'Benchmark rate (%)', kind: 'number' }, { path: 'platformFee.bps', label: 'Platform fee (basis points)', kind: 'number' }, { path: 'platformFee.payer', label: 'Platform fee paid by', kind: 'select', options: ['bank', 'supplier'] },
    { path: 'freeTierInvoicesPerMonth', label: 'Free invoices per month for small suppliers', kind: 'number' }, { path: 'earlyPayment.bankCommissionSharePct', label: 'Early payment: share of commission (%)', kind: 'number' }, { path: 'earlyPayment.buyerCashYieldPct', label: 'Early payment: buyer cash yield (%)', kind: 'number' },
  ] },
  { title: 'Guarded limits', fields: [
    { path: 'disputeWindowHours', label: 'Dispute window (hours, at least 24)', kind: 'number' }, { path: 'maxFxSpreadPct', label: 'Maximum FX margin (%, at most 1.00)', kind: 'number' }, { path: 'maxAllInCostSmallPct', label: 'Cost cap for small suppliers (%, at most 18)', kind: 'number' },
    { path: 'assignmentNoticeRequired', label: 'Assignment notice required (cannot be switched off)', kind: 'bool' }, { path: 'sanctionsBlocksFunding', label: 'Sanctions hit blocks funding (cannot be switched off)', kind: 'bool' },
  ] },
];

function Csv({ value, onCommit, label, disabled, hint }: { value: string[] | undefined; onCommit: (v: string[] | undefined) => void; label: string; disabled?: boolean; hint?: string }) {
  const [t, setT] = useState((value ?? []).join(', '));
  useEffect(() => setT((value ?? []).join(', ')), [JSON.stringify(value)]);
  return <TextField label={label} value={t} disabled={disabled} placeholder={hint} onChange={(e) => setT(e.target.value)} onBlur={() => { const a = t.split(',').map((x) => x.trim()).filter(Boolean); onCommit(a.length ? a : undefined); }} />;
}

function FormEditor({ owner, body, setBody, partial, disabled }: { owner: Owner; body: Body; setBody: (b: Body) => void; partial: boolean; disabled: boolean }) {
  const sections = owner === 'bank' ? BANK : owner === 'insurer' ? INSURER : PLATFORM;
  const field = (f: Fld) => {
    const v = getP(body, f.path);
    const off = partial && v === undefined;
    const dis = disabled || off;
    const control = f.kind === 'number' ? <TextField label={f.label} type="number" step="any" disabled={dis} value={v ?? ''} onChange={(e) => setBody(setP(body, f.path, e.target.value === '' ? undefined : Number(e.target.value)))} />
      : f.kind === 'bool' ? <SelectField label={f.label} disabled={dis} value={String(v ?? '')} onChange={(e) => setBody(setP(body, f.path, e.target.value === '' ? undefined : e.target.value === 'true'))}><option value="">—</option><option value="true">Yes</option><option value="false">No</option></SelectField>
      : f.kind === 'select' ? <SelectField label={f.label} disabled={dis} value={v ?? ''} onChange={(e) => setBody(setP(body, f.path, e.target.value || undefined))}><option value="">—</option>{f.options!.map((o) => <option key={o}>{o}</option>)}</SelectField>
      : f.kind === 'csv' ? <Csv value={v} label={f.label} disabled={dis} hint={f.hint} onCommit={(a) => setBody(setP(body, f.path, a))} />
      : <TextField label={f.label} type={f.kind === 'time' ? 'time' : 'text'} disabled={dis} value={v ?? ''} onChange={(e) => setBody(setP(body, f.path, e.target.value || undefined))} />;
    return (
      <div key={f.path} className="stack-3">
        {control}
        {partial && !disabled && <Checkbox label={`Override ${f.label}`} checked={!off} onChange={(e) => setBody(setP(body, f.path, e.target.checked ? (f.kind === 'number' ? 0 : f.kind === 'csv' ? [] : f.kind === 'bool' ? true : f.options?.[0] ?? '') : undefined))} />}
      </div>
    );
  };
  return (
    <div className="stack-3">
      {sections.map((s) => <Panel key={s.title} level={3} title={s.title}><div className="field-grid">{s.fields.map(field)}</div></Panel>)}
      {owner === 'bank' && <PricingEditor body={body} setBody={setBody} disabled={disabled} />}
      {partial && <Hint>This is an override: only the settings ticked “override” replace the default; everything else is inherited.</Hint>}
    </div>
  );
}

function PricingEditor({ body, setBody, disabled }: { body: Body; setBody: (b: Body) => void; disabled: boolean }) {
  const p = body.pricing as { type: 'fixed' | 'benchmark'; ratePct?: number; spreadPctByTier?: Record<string, number> } | undefined;
  return (
    <Panel level={3} title="Price">
      <SelectField label="Pricing" disabled={disabled} value={p?.type ?? ''} onChange={(e) => setBody({ ...body, pricing: e.target.value === 'fixed' ? { type: 'fixed', ratePct: 8 } : e.target.value === 'benchmark' ? { type: 'benchmark', spreadPctByTier: { AA: 2, A: 2, BBB: 3 } } : undefined })}>
        <option value="">—</option><option value="fixed">Fixed annual rate</option><option value="benchmark">Benchmark + margin by buyer rating</option></SelectField>
      {p?.type === 'fixed' && <TextField label="Annual rate (%)" type="number" step="any" disabled={disabled} value={p.ratePct ?? ''} onChange={(e) => setBody({ ...body, pricing: { type: 'fixed', ratePct: Number(e.target.value) } })} />}
      {p?.type === 'benchmark' && <div className="field-grid">{TIERS.map((t) => (
        <TextField key={t} label={`Margin for ${t} buyers (%)`} type="number" step="any" disabled={disabled} value={p.spreadPctByTier?.[t] ?? ''} onChange={(e) => setBody({ ...body, pricing: { type: 'benchmark', spreadPctByTier: { ...p.spreadPctByTier, [t]: Number(e.target.value) } } })} />
      ))}</div>}
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------- eligibility rule builder (CT-3)
const FACTS: [string, string][] = [['invoice.tenorDays', 'Tenor (days)'], ['invoice.amountUsdEq', 'Invoice amount (USD)'], ['invoice.currency', 'Currency'], ['invoice.goods', 'Goods category'], ['buyer.country', 'Buyer country'], ['buyer.tier', 'Buyer rating'], ['supplier.country', 'Supplier country'], ['supplier.small', 'Small supplier'], ['corridor', 'Corridor']];
const OPS: [string, string][] = [['in', 'is one of'], ['nin', 'is none of'], ['eq', 'is'], ['neq', 'is not'], ['lt', 'is below'], ['lte', 'is at most'], ['gt', 'is above'], ['gte', 'is at least'], ['exists', 'is known']];
type Cond = any;
const opOf = (c: Cond) => OPS.find(([o]) => o in c)?.[0] ?? 'eq';
const parseScalar = (s: string) => (s === 'true' ? true : s === 'false' ? false : s.trim() !== '' && Number.isFinite(Number(s)) ? Number(s) : s);
const groupKey = (c: Cond) => (c.all ? 'all' : c.any ? 'any' : c.not ? 'not' : null);
const children = (c: Cond): Cond[] => { const k = groupKey(c); return k === 'not' ? [c.not] : k ? c[k] : []; };
const leafDefault = (): Cond => ({ field: 'buyer.country', in: ['US'] });

function RuleNode({ c, onChange, onRemove, disabled, root }: { c: Cond; onChange: (c: Cond) => void; onRemove?: () => void; disabled: boolean; root?: boolean }) {
  const k = groupKey(c);
  if (k) {
    const kids = children(c);
    const rebuild = (key: string, list: Cond[]) => (key === 'not' ? { not: list[0] ?? leafDefault() } : { [key]: list });
    return (
      <div className="rule">
        <div className="rule-row">
          <SelectField label="Combine with" disabled={disabled} value={k} onChange={(e) => onChange(rebuild(e.target.value, kids))}>
            <option value="all">All of these (AND)</option><option value="any">Any of these (OR)</option><option value="not">None of these (NOT)</option></SelectField>
          {!root && !disabled && <Button size="sm" variant="ghost" onClick={onRemove}>Remove group</Button>}
        </div>
        {kids.map((kid, i) => <RuleNode key={i} c={kid} disabled={disabled} onChange={(n) => onChange(rebuild(k, kids.map((x, j) => (j === i ? n : x))))} onRemove={() => onChange(rebuild(k, kids.filter((_, j) => j !== i)))} />)}
        {!disabled && !(k === 'not' && kids.length >= 1) && <div className="row-actions">
          <Button size="sm" onClick={() => onChange(rebuild(k, [...kids, leafDefault()]))}>+ Condition</Button>
          <Button size="sm" onClick={() => onChange(rebuild(k, [...kids, { all: [leafDefault()] }]))}>+ Group</Button></div>}
        {kids.length === 0 && <Hint>An empty group passes everything.</Hint>}
      </div>
    );
  }
  const op = opOf(c);
  const val = c[op];
  const setLeaf = (field: string, o: string, v: unknown) => onChange({ field, [o]: v });
  return (
    <div className="rule">
      <div className="rule-row">
        <SelectField label="Fact" disabled={disabled} value={c.field} onChange={(e) => setLeaf(e.target.value, op, val)}>{FACTS.map(([f, l]) => <option key={f} value={f}>{l}</option>)}{!FACTS.some(([f]) => f === c.field) && <option value={c.field}>{c.field}</option>}</SelectField>
        <SelectField label="Operator" disabled={disabled} value={op} onChange={(e) => setLeaf(c.field, e.target.value, e.target.value === 'in' || e.target.value === 'nin' ? [] : e.target.value === 'exists' ? true : ['lt', 'lte', 'gt', 'gte'].includes(e.target.value) ? 0 : '')}>{OPS.map(([o, l]) => <option key={o} value={o}>{l}</option>)}</SelectField>
        {op === 'exists' ? <SelectField label="Value" disabled={disabled} value={String(val)} onChange={(e) => setLeaf(c.field, op, e.target.value === 'true')}><option value="true">yes</option><option value="false">no</option></SelectField>
          : op === 'in' || op === 'nin' ? <CsvAny value={val} disabled={disabled} onCommit={(v) => setLeaf(c.field, op, v)} />
          : <TextField label="Value" disabled={disabled} value={String(val ?? '')} onChange={(e) => setLeaf(c.field, op, ['lt', 'lte', 'gt', 'gte'].includes(op) ? Number(e.target.value) : parseScalar(e.target.value))} />}
        {!disabled && <Button size="sm" variant="ghost" onClick={onRemove} aria-label="Remove condition">Remove</Button>}
      </div>
    </div>
  );
}
function CsvAny({ value, onCommit, disabled }: { value: unknown[]; onCommit: (v: unknown[]) => void; disabled: boolean }) {
  const [t, setT] = useState((value ?? []).join(', '));
  return <TextField label="Values" disabled={disabled} value={t} placeholder="US, SG" onChange={(e) => setT(e.target.value)} onBlur={() => onCommit(t.split(',').map((x) => x.trim()).filter(Boolean).map(parseScalar))} />;
}

function RuleEditor({ body, setBody, disabled }: { body: Body; setBody: (b: Body) => void; disabled: boolean }) {
  const e = (body.eligibility ?? { all: [] }) as Cond;
  const { id, reasonIfFalse, ...cond } = e;
  const put = (c: Cond, i = id, r = reasonIfFalse) => setBody({ ...body, eligibility: { ...(i ? { id: i } : {}), ...c, ...(r ? { reasonIfFalse: r } : {}) } });
  return (
    <Panel level={3} title="Eligibility rules" sub="Invoices that fail these conditions are not offered to your bank; the supplier sees the sentence below instead of a bare “no”.">
      <RuleNode c={cond} root disabled={disabled} onChange={(c) => put(c)} />
      <TextField label="Rule name" disabled={disabled} value={id ?? ''} onChange={(ev) => put(cond, ev.target.value || undefined)} />
      <TextField label="What a supplier is told when an invoice does not qualify" disabled={disabled} value={reasonIfFalse ?? ''} onChange={(ev) => put(cond, id, ev.target.value || undefined)} />
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------- custom fields (CT-10)
const DOCS = ['commercial_invoice', 'delivery_proof', 'packing_list', 'shipping_bill', 'transport_document'];
function FieldsEditor({ owner, body, setBody, disabled }: { owner: Owner; body: Body; setBody: (b: Body) => void; disabled: boolean }) {
  const fields: any[] = body.customFields ?? [];
  const put = (f: any[]) => setBody({ ...body, customFields: f.length ? f : undefined });
  const upd = (i: number, patch: any) => put(fields.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const applies = owner === 'bank' ? 'financing_request' : 'claim';
  return (
    <Panel level={3} title="Required information" sub={owner === 'bank' ? 'Extra questions your supplier answers when giving consent, and papers they must attach first.' : 'Extra information the bank provides when filing a claim.'}>
      {fields.map((f, i) => (
        <div className="rule" key={i}>
          <div className="rule-row">
            <TextField label="Field key" placeholder="key (letters, digits)" disabled={disabled} value={f.key} onChange={(e) => upd(i, { key: e.target.value })} />
            <TextField label="Field label" placeholder="Label shown on the form" disabled={disabled} value={f.label} onChange={(e) => upd(i, { label: e.target.value })} />
            <SelectField label="Field type" disabled={disabled} value={f.type} onChange={(e) => upd(i, { type: e.target.value, options: e.target.value === 'select' ? f.options ?? ['yes', 'no'] : undefined })}>{['text', 'number', 'date', 'select'].map((t) => <option key={t}>{t}</option>)}</SelectField>
            <Checkbox label="required" disabled={disabled} checked={f.required} onChange={(e) => upd(i, { required: e.target.checked })} />
            {!disabled && <Button size="sm" variant="ghost" onClick={() => put(fields.filter((_, j) => j !== i))}>Remove</Button>}
          </div>
          {f.type === 'select' && <CsvAny value={f.options ?? []} disabled={disabled} onCommit={(v) => upd(i, { options: v.map(String) })} />}
        </div>
      ))}
      {!disabled && <div><Button onClick={() => put([...fields, { key: `field${fields.length + 1}`, label: 'New question', type: 'text', required: false, appliesTo: applies }])}>+ Add a field</Button></div>}
      {owner === 'bank' && (
        <Sub title="Papers the supplier must attach before consent" level={4}>
          <div className="row-actions">
            {DOCS.map((d) => <Checkbox key={d} label={d.replace(/_/g, ' ')} disabled={disabled} checked={(body.requiredDocuments ?? []).includes(d)}
              onChange={(e) => { const cur: string[] = body.requiredDocuments ?? []; const next = e.target.checked ? [...cur, d] : cur.filter((x) => x !== d); setBody({ ...body, requiredDocuments: next.length ? next : undefined }); }} />)}
          </div>
        </Sub>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------- studio list
export function TermsStudioPage() {
  const { me } = useAuth();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['terms-sets'], queryFn: async () => (await api.GET('/api/v1/terms/sets')).data?.items ?? [] });
  const [name, setName] = useState(''); const [kind, setKind] = useState<'default' | 'corridor' | 'buyerOrgId' | 'supplierOrgId'>('default'); const [target, setTarget] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const orgType = me?.activeOrg?.type;
  const dir = useQuery({ queryKey: ['directory', kind], enabled: kind === 'buyerOrgId' || kind === 'supplierOrgId', queryFn: async () => (await api.GET('/api/v1/directory/organisations', { params: { query: { type: kind === 'buyerOrgId' ? 'buyer' : 'supplier' } } })).data?.items ?? [] });
  const canEdit = me?.permissions.includes('terms:edit');
  async function create() {
    setErr(null);
    const scope = kind === 'default' ? {} : { [kind]: target };
    const r = await api.POST('/api/v1/terms/sets', { body: { name, scope } });
    if (r.data) nav(`/terms/${r.data.id}`); else setErr(problemOf(r.error).message);
  }
  return (
    <>
      <Page title="Terms studio" description={`${orgType === 'insurer' ? 'Cover, premiums, waiting periods and limits' : orgType === 'bank' ? 'Pricing, eligibility and timing' : 'Platform defaults'} live here as versioned terms. Changes are drafted, checked by a second person, then take effect on their effective date. Invoices already priced keep the version they were priced on.`} />
      <DataTable aria-label="Terms sets" noun="terms sets" loading={q.isLoading} rowKey={(s) => s.id} rows={q.data ?? []} empty={noRows('No terms sets yet')}
        columns={[
          { id: 'name', header: 'Name', rowHeader: true, cell: (s) => `${s.ownerName && me?.activeOrg?.type === 'platform' ? `${s.ownerName} — ` : ''}${s.name}` },
          { id: 'applies', header: 'Applies to', cell: (s) => <>{Object.keys(s.scope).length ? Object.entries(s.scope).map(([k, v]) => `${k.replace('OrgId', '')}: ${String(v).slice(0, 8)}`).join(', ') : 'Everyone (default)'}<div className="hint">{s.layer.replace(/_/g, ' ')}</div></> },
          { id: 'force', header: 'In force', cell: (s) => s.activeVersion ? <>v{s.activeVersion.version} <span className="hint">since {dt(s.activeVersion.effectiveFrom)}</span></> : <span className="hint">none yet</span> },
          { id: 'latest', header: 'Latest', numeric: true, cell: (s) => `v${s.latestVersion}` },
          { id: 'open', header: <span className="bv-sr-only">Open</span>, cell: (s) => <Link to={`/terms/${s.id}`}>Open</Link> },
        ]} />
      {canEdit && orgType !== 'platform' && (
        <Panel title="New terms set" sub="A default set applies to everyone. An override changes only some settings for one buyer, one supplier or one corridor.">
          {err && <Alert tone="danger" title={err} />}
          <div className="toolbar-fields">
            <TextField label="Name" placeholder="Name, e.g. Northwind override" value={name} onChange={(e) => setName(e.target.value)} />
            <SelectField label="Applies to" value={kind} onChange={(e) => { setKind(e.target.value as typeof kind); setTarget(''); }}><option value="default">Default for everyone</option><option value="corridor">A corridor</option><option value="buyerOrgId">One buyer</option><option value="supplierOrgId">One supplier</option></SelectField>
            {kind === 'corridor' && <SelectField label="Corridor" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Choose…</option>{['IN-US', 'IN-SG'].map((c) => <option key={c}>{c}</option>)}</SelectField>}
            {(kind === 'buyerOrgId' || kind === 'supplierOrgId') && <SelectField label="Organisation" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">Choose…</option>{(dir.data ?? []).map((o) => <option key={o.id} value={o.id}>{o.legalName}</option>)}</SelectField>}
            <Button variant="primary" disabled={name.trim().length < 2 || (kind !== 'default' && !target)} onClick={create}>Create</Button>
          </div>
        </Panel>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------- the editor
type Tab = 'form' | 'rules' | 'fields' | 'json' | 'preview' | 'simulate' | 'compare';

export function TermsSetPage() {
  const { id = '' } = useParams();
  const { me } = useAuth();
  const qc = useQueryClient();
  const set = useQuery({ queryKey: ['terms-set', id], queryFn: async () => (await api.GET('/api/v1/terms/sets/{id}', { params: { path: { id } } })).data });
  const tpl = useQuery({ queryKey: ['templates', set.data?.ownerType], enabled: !!set.data, queryFn: async () => (await api.GET('/api/v1/terms/templates/{owner}', { params: { path: { owner: set.data!.ownerType } } })).data?.items ?? [] });
  const [body, setBody] = useState<Body | null>(null);
  const [tab, setTab] = useState<Tab>('form');
  const [json, setJson] = useState(''); const [jsonErr, setJsonErr] = useState<string | null>(null);
  const [note, setNote] = useState(''); const [eff, setEff] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [check, setCheck] = useState<{ valid: boolean; error: string | null; guardrailBreaches: { guardrail: string; message: string }[] } | null>(null);
  const [preview, setPreview] = useState<{ supplier: string[]; buyer: string[]; notes: string[] } | null>(null);
  const [sim, setSim] = useState<any[] | null>(null);
  const [vdiff, setVdiff] = useState<{ version: number; against: number | null; changes: any[] } | null>(null);
  const [previewLang, setPreviewLang] = useState<'en' | 'hi'>('en');
  const fileRef = useRef<HTMLInputElement>(null);
  const s = set.data;
  const active = useMemo(() => s?.versions.filter((v) => v.status === 'active').sort((a, b) => b.version - a.version)[0], [s]);
  useEffect(() => { if (s && body === null) setBody(structuredClone((s.versions[0]?.body as Body) ?? {})); }, [s, body]);
  useEffect(() => { if (tab === 'json' && body) { setJson(JSON.stringify(body, null, 2)); setJsonErr(null); } }, [tab]);
  if (!s || !body) return <Loading />;
  const cur: Body = body;
  const partial = Object.keys(s.scope).length > 0;
  const canEdit = !!me?.permissions.includes('terms:edit');
  const flash = (kind: 'ok' | 'err', text: string) => setMsg({ ok: kind === 'ok', text });
  const reload = () => qc.invalidateQueries({ queryKey: ['terms-set', id] }).then(() => qc.invalidateQueries({ queryKey: ['terms-sets'] }));

  async function validate() {
    const r = await api.POST('/api/v1/terms/validate', { body: { ownerType: s!.ownerType, body: cur, scoped: partial } });
    if (r.data) setCheck(r.data); else flash('err', problemOf(r.error).message);
  }
  async function saveDraft() {
    setMsg(null);
    const r = await api.POST('/api/v1/terms/sets/{id}/versions', { params: { path: { id } }, body: { body: cur, note: note || undefined } });
    if (r.data) { flash('ok', `Saved as draft version ${r.data.version}. Submit it for approval when ready.`); await reload(); } else flash('err', problemOf(r.error).message);
  }
  async function submit(versionId: string) {
    try { await ensureOk(await api.POST('/api/v1/terms/versions/{id}/submit', { params: { path: { id: versionId } }, body: { effectiveFrom: eff ? new Date(eff).toISOString() : undefined } })); flash('ok', 'Submitted. A different approver must publish it.'); await reload(); } catch (e) { flash('err', (e as Error).message); }
  }
  async function withdraw(versionId: string) {
    try { await ensureOk(await api.POST('/api/v1/terms/versions/{id}/reject', { params: { path: { id: versionId } }, body: { reason: 'Withdrawn by the maker' } })); flash('ok', 'Withdrawn back to draft.'); await reload(); } catch (e) { flash('err', (e as Error).message); }
  }
  async function runPreview(lang: 'en' | 'hi' = previewLang) {
    const r = await api.POST('/api/v1/terms/preview', { body: { ownerType: s!.ownerType, body: cur, lang } });
    if (r.data) setPreview(r.data); else flash('err', problemOf(r.error).message);
  }
  async function runSim() {
    setSim(null);
    const r = await api.POST('/api/v1/terms/simulate', { body: { body: cur } });
    if (r.data) setSim(r.data.rows); else flash('err', problemOf(r.error).message);
  }
  async function exportVersion(versionId: string) {
    const r = await api.GET('/api/v1/terms/sets/{id}/export', { params: { path: { id }, query: { version: versionId } } });
    if (!r.data) return flash('err', problemOf(r.error).message);
    const url = URL.createObjectURL(new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `${s!.name.replace(/\W+/g, '-').toLowerCase()}-v${r.data.version}.json`; a.click(); URL.revokeObjectURL(url);
  }
  async function importFile(file: File) {
    try {
      const doc = JSON.parse(await file.text());
      const r = await api.POST('/api/v1/terms/sets/{id}/import', { params: { path: { id } }, body: doc });
      if (r.data) { flash('ok', `Imported as draft version ${r.data.version}.`); await reload(); } else flash('err', problemOf(r.error).message);
    } catch { flash('err', 'That file is not valid JSON.'); }
  }
  async function showDiff(versionId: string) {
    const r = await api.GET('/api/v1/terms/versions/{id}/diff', { params: { path: { id: versionId } } });
    if (r.data) setVdiff(r.data); else flash('err', problemOf(r.error).message);
  }
  const tabs: { id: Tab; label: string }[] = [
    { id: 'form', label: 'Settings' },
    ...(s.ownerType === 'bank' ? [{ id: 'rules' as Tab, label: 'Eligibility rules' }] : []),
    ...(s.ownerType !== 'platform' ? [{ id: 'fields' as Tab, label: 'Required information' }] : []),
    { id: 'json', label: 'JSON' }, { id: 'preview', label: 'What they will see' },
    ...(s.ownerType !== 'platform' ? [{ id: 'simulate' as Tab, label: 'Simulator' }] : []),
    { id: 'compare', label: 'Compare' },
  ];
  const localDiff = diffJson(active?.body ?? {}, body);
  const P = 'terms';
  const panel = (t: Tab, children: React.ReactNode) => <TabPanel tabId={t} activeTab={tab} idPrefix={P}>{children}</TabPanel>;

  return (
    <>
      <Page title={s.name} breadcrumbs={[{ label: 'Terms studio', href: '/terms' }, { label: s.name }]}
        description={`${s.layer.replace(/_/g, ' ')} · ${active ? `version ${active.version} in force since ${dt(active.effectiveFrom)}` : 'nothing in force yet'}`} />
      <Notice msg={msg} />

      {canEdit && (
        <div className="toolbar-fields">
          <SelectField label="Start from" aria-label="Template" defaultValue="" onChange={(e) => { const t = tpl.data?.find((x) => x.id === e.target.value); if (t) { setBody(structuredClone(t.body as Body)); flash('ok', `Loaded the “${t.name}” template. Nothing is saved until you save a draft.`); } e.target.value = ''; }}>
            <option value="">a template…</option>{tpl.data?.map((t) => <option key={t.id} value={t.id}>{t.name} — {t.description}</option>)}</SelectField>
          {s.versions[0] && <Button onClick={() => setBody(structuredClone(s.versions[0]!.body as Body))}>Reset to latest version</Button>}
          <Button icon="upload" onClick={() => fileRef.current?.click()}>Import JSON…</Button>
          <input ref={fileRef} type="file" accept="application/json,.json" hidden aria-label="Terms JSON file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f); }} />
        </div>
      )}

      <Tabs aria-label="Terms editor" idPrefix={P} value={tab} items={tabs} onValueChange={(t) => { setTab(t as Tab); if (t === 'preview') void runPreview(); }} />

      {tab === 'form' && panel('form', <FormEditor owner={s.ownerType} body={body} setBody={setBody} partial={partial} disabled={!canEdit} />)}
      {tab === 'rules' && panel('rules', <RuleEditor body={body} setBody={setBody} disabled={!canEdit} />)}
      {tab === 'fields' && panel('fields', <FieldsEditor owner={s.ownerType} body={body} setBody={setBody} disabled={!canEdit} />)}
      {tab === 'json' && panel('json',
        <Panel level={3} title="Terms as JSON">
          <TextareaField label="Terms JSON" className="mono" rows={18} value={json} disabled={!canEdit}
            onChange={(e) => { setJson(e.target.value); try { setBody(JSON.parse(e.target.value)); setJsonErr(null); } catch (x) { setJsonErr((x as Error).message); } }} />
          {jsonErr ? <Alert tone="danger" title={`Not valid JSON yet: ${jsonErr}`} /> : <Hint>Valid JSON. The Settings tab shows the same values.</Hint>}
          <div><a href="#schema" onClick={async (e) => { e.preventDefault(); const r = await api.GET('/api/v1/terms/schema/{owner}', { params: { path: { owner: s.ownerType } } }); if (r.data) setJson(JSON.stringify(r.data, null, 2)); setJsonErr('This is the JSON Schema for reference; switch tabs to return to your terms.'); }}>Show the JSON Schema</a></div>
        </Panel>)}
      {tab === 'preview' && panel('preview',
        <Panel level={3} title="What they will see" actions={<>
          <Button size="sm" onClick={() => runPreview()}>Refresh preview</Button>
          <Button size="sm" onClick={() => { const l = previewLang === 'en' ? 'hi' : 'en'; setPreviewLang(l); void runPreview(l); }}>{previewLang === 'en' ? 'Summary in Hindi' : 'Summary in English'}</Button></>}>
          {preview && <div className="split">
            <Sub title="A supplier will see" level={4}><ul>{preview.supplier.map((x, i) => <li key={i}>{x}</li>)}</ul></Sub>
            <Sub title="A buyer will see" level={4}><ul>{preview.buyer.map((x, i) => <li key={i}>{x}</li>)}</ul>{preview.notes.length > 0 && <><h4 className="bv-heading-xs">Also</h4><ul>{preview.notes.map((x, i) => <li key={i}>{x}</li>)}</ul></>}</Sub>
          </div>}
        </Panel>)}
      {tab === 'simulate' && panel('simulate',
        <Panel level={3} title="Simulator" sub="Runs this draft against 20 sample invoices and shows what would change against the terms in force." actions={<Button variant="primary" onClick={runSim}>Run simulator</Button>}>
          {sim && (() => {
            const cell = (x: any) => (x.eligible ? `Eligible · net ${x.netCash ?? '—'} · ${x.allInPct ?? '—'}%` : `Not eligible — ${x.reasons?.[0] ?? ''}`);
            return (
              <DataTable aria-label="Simulation results" noun="samples" rowKey={(r: any) => r.sampleId} rows={sim}
                columns={[
                  { id: 'sample', header: 'Sample', rowHeader: true, cell: (r: any) => r.label },
                  { id: 'before', header: 'In force', cell: (r: any) => cell(r.before) },
                  { id: 'after', header: 'This draft', cell: (r: any) => cell(r.after) },
                  { id: 'change', header: 'Change', cell: (r: any) => {
                    const delta = r.before.netCash && r.after.netCash ? (Number(r.after.netCash) - Number(r.before.netCash)).toFixed(2) : null;
                    return r.changed ? (r.before.eligible !== r.after.eligible ? (r.after.eligible ? 'now eligible' : 'no longer eligible') : delta ? `net cash ${Number(delta) >= 0 ? '+' : ''}${delta}` : 'changed') : '—';
                  } },
                ]} />
            );
          })()}
        </Panel>)}
      {tab === 'compare' && panel('compare',
        <Panel level={3} title="Compare" sub={`Your working copy compared with ${active ? `version ${active.version}, in force now` : 'an empty start'}.`}>
          <DiffTable changes={localDiff} empty="Your working copy matches what is in force." />
        </Panel>)}

      {canEdit && (
        <Panel title="Save and submit">
          <div className="toolbar-fields">
            <Button onClick={validate}>Check</Button>
            <TextField label="Note for the approver" placeholder="Note for the approver" value={note} onChange={(e) => setNote(e.target.value)} />
            <Button variant="primary" onClick={saveDraft} disabled={!!jsonErr}>Save as draft</Button>
          </div>
          {check && (check.valid
            ? <Alert tone="success" title="Valid, and within every platform guardrail." />
            : <Alert tone="danger" title={check.error ?? 'Guardrail breached:'}><ul>{check.guardrailBreaches.map((b) => <li key={b.guardrail}>{b.message}</li>)}</ul></Alert>)}
          <TextField label="Effective from (optional — defaults to the moment it is published)" type="datetime-local" value={eff} onChange={(e) => setEff(e.target.value)} />
        </Panel>
      )}

      <Panel title="Versions">
        <DataTable aria-label="Versions" noun="versions" rowKey={(v) => v.id} rows={s.versions}
          columns={[
            { id: 'version', header: 'Version', rowHeader: true, numeric: true, cell: (v) => `v${v.version}` },
            { id: 'status', header: 'Status', cell: (v) => <StatusChip status={v.status} /> },
            { id: 'eff', header: 'Effective', cell: (v) => <>{dt(v.effectiveFrom)}{v.effectiveTo && ` → ${dt(v.effectiveTo)}`}</> },
            { id: 'note', header: 'Note', cell: (v) => <span className="hint">{v.note}</span> },
            { id: 'act', header: <span className="bv-sr-only">Actions</span>, cell: (v) => (
              <div className="row-actions">
                <Button size="sm" variant="ghost" onClick={() => { setBody(structuredClone(v.body as Body)); setTab('form'); window.scrollTo({ top: 0 }); }}>Load</Button>
                <Button size="sm" variant="ghost" onClick={() => showDiff(v.id)}>What changed</Button>
                <Button size="sm" variant="ghost" onClick={() => exportVersion(v.id)}>Export</Button>
                {canEdit && v.status === 'draft' && <Button size="sm" variant="ghost" onClick={() => submit(v.id)}>Submit for approval</Button>}
                {canEdit && v.status === 'pending' && <Button size="sm" variant="ghost" onClick={() => withdraw(v.id)}>Withdraw</Button>}
              </div>) },
          ]} />
        {vdiff && <Sub title={`Version ${vdiff.version} compared with ${vdiff.against ? `version ${vdiff.against}` : 'nothing'}`} level={4}><DiffTable changes={vdiff.changes} empty="Identical." /></Sub>}
        <Hint>Once a version is in force it can never be edited — a change is always a new version. Pending versions appear in the <Link to="/approvals">approvals inbox</Link>.</Hint>
      </Panel>
    </>
  );
}
