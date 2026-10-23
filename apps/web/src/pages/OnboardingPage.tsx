import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ensureOk, problemOf } from '../api/client';
import { useAuth } from '../auth/AuthContext';

const LABELS: Record<string, string> = {
  incorporation: 'Certificate of incorporation', tax_id: 'Tax registration (PAN / EIN / UEN)', address_proof: 'Proof of address', director_id: 'Director ID',
  bank_statement: 'Bank statement', licence: 'Banking / insurance licence',
};

export function OnboardingPage() {
  const qc = useQueryClient();
  const { me } = useAuth();
  const csrfToken = me?.csrfToken;
  const q = useQuery({ queryKey: ['kyc-case'], queryFn: async () => (await api.GET('/api/v1/onboarding/case')).data });
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState<string>('');
  const c = q.data;
  if (!c) return <p>Loading…</p>;
  const draft = c.status === 'draft' || c.status === 'not_started';

  async function upload(type: string, file: File) {
    setMsg(null);
    const r = await fetch(`/api/v1/files?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': csrfToken ?? '' }, body: await file.arrayBuffer(),
    });
    const j = await r.json();
    if (!r.ok) return setMsg({ kind: 'err', text: j.message ?? 'Upload failed.' });
    try { await ensureOk(await api.POST('/api/v1/onboarding/documents', { body: { docType: type, fileId: j.id } })); } catch (e) { return setMsg({ kind: 'err', text: (e as Error).message }); }
    qc.invalidateQueries({ queryKey: ['kyc-case'] });
  }
  async function submit() {
    setMsg(null);
    const { data, error } = await api.POST('/api/v1/onboarding/submit');
    if (error || !data) return setMsg({ kind: 'err', text: problemOf(error).message });
    setMsg({ kind: data.status === 'rejected' ? 'err' : 'ok', text: data.status === 'rejected' ? `Rejected: ${data.reasons.join('; ')}` : 'Submitted. A platform reviewer will decide shortly.' });
    qc.invalidateQueries({ queryKey: ['kyc-case'] });
  }

  return (
    <section>
      <h2>KYC application</h2>
      <p>Status: <strong>{c.status}</strong> · Sanctions: {c.org.sanctionsStatus}{c.org.blocked && ' · BLOCKED'}</p>
      {c.decisionReason && <p className="hint">Reviewer note: {c.decisionReason}</p>}
      <table>
        <thead><tr><th>Document</th><th>File</th><th /></tr></thead>
        <tbody>
          {c.required.map((t) => {
            const d = c.documents.find((x) => x.docType === t);
            return (
              <tr key={t}>
                <td>{LABELS[t] ?? t}</td>
                <td>{d ? <>{d.filename} <span className="hint">sha256 {d.sha256.slice(0, 10)}…</span></> : <span className="muted">missing</span>}</td>
                <td>{draft && <button className="link" onClick={() => { setDocType(t); fileRef.current?.click(); }}>{d ? 'Replace' : 'Upload'}</button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <input ref={fileRef} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f && docType) void upload(docType, f); e.target.value = ''; }} />
      {msg && <p className={msg.kind === 'ok' ? 'ok' : 'alert'}>{msg.text}</p>}
      {draft && <p><button onClick={submit}>Submit for review</button></p>}
    </section>
  );
}
