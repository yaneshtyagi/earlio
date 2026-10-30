import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, DataTable, DescriptionList } from '@yaneshtyagi/design-system';
import { api, ensureOk, problemOf, uploadFile } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Loading, Notice, Page, Panel, StatusChip, type Msg } from '../ui';

const LABELS: Record<string, string> = {
  incorporation: 'Certificate of incorporation', tax_id: 'Tax registration (PAN / EIN / UEN)', address_proof: 'Proof of address', director_id: 'Director ID',
  bank_statement: 'Bank statement', licence: 'Banking / insurance licence',
};

export function OnboardingPage() {
  const qc = useQueryClient();
  const { me } = useAuth();
  const q = useQuery({ queryKey: ['kyc-case'], queryFn: async () => (await api.GET('/api/v1/onboarding/case')).data });
  const [msg, setMsg] = useState<Msg>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState<string>('');
  const c = q.data;
  if (!c) return <Loading />;
  const draft = c.status === 'draft' || c.status === 'not_started';

  async function upload(type: string, file: File) {
    setMsg(null);
    try {
      const fileId = await uploadFile(file);
      await ensureOk(await api.POST('/api/v1/onboarding/documents', { body: { docType: type, fileId } }));
    } catch (e) { return setMsg({ ok: false, text: (e as Error).message }); }
    qc.invalidateQueries({ queryKey: ['kyc-case'] });
  }
  async function submit() {
    setMsg(null);
    const { data, error } = await api.POST('/api/v1/onboarding/submit');
    if (error || !data) return setMsg({ ok: false, text: problemOf(error).message });
    setMsg({ ok: data.status !== 'rejected', text: data.status === 'rejected' ? `Rejected: ${data.reasons.join('; ')}` : 'Submitted. A platform reviewer will decide shortly.' });
    qc.invalidateQueries({ queryKey: ['kyc-case'] });
  }

  return (
    <>
      <Page title="KYC application" actions={draft ? <Button variant="primary" onClick={submit}>Submit for review</Button> : undefined} />
      <Notice msg={msg} />
      <Panel title="Status">
        <DescriptionList columns={3} items={[
          { label: 'Application', value: <StatusChip status={c.status} /> },
          { label: 'Sanctions screening', value: <StatusChip status={c.org.sanctionsStatus} />, },
          ...(c.org.blocked ? [{ label: 'Access', value: <StatusChip status="BLOCKED" /> }] : []),
          { label: 'Reviewer note', value: c.decisionReason, wide: true },
        ]} />
      </Panel>
      <DataTable aria-label="Required documents" noun="documents" rowKey={(t) => t} rows={c.required}
        columns={[
          { id: 'doc', header: 'Document', rowHeader: true, cell: (t) => LABELS[t] ?? t },
          { id: 'file', header: 'File', cell: (t) => {
            const d = c.documents.find((x) => x.docType === t);
            return d ? <>{d.filename} <span className="hint">sha256 {d.sha256.slice(0, 10)}…</span></> : <StatusChip status="missing">missing</StatusChip>;
          } },
          { id: 'act', header: <span className="bv-sr-only">Action</span>, cell: (t) => {
            const d = c.documents.find((x) => x.docType === t);
            return draft ? <Button size="sm" variant="secondary" icon="upload" onClick={() => { setDocType(t); fileRef.current?.click(); }}>{d ? 'Replace' : 'Upload'}</Button> : null;
          } },
        ]} />
      <input ref={fileRef} type="file" hidden aria-label="Choose a document" onChange={(e) => { const f = e.target.files?.[0]; if (f && docType) void upload(docType, f); e.target.value = ''; }} />
    </>
  );
}
