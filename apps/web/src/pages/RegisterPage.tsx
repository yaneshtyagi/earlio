import { useState } from 'react';
import { Alert, Button, LinkButton, SelectField, TextField } from '@yaneshtyagi/design-system';
import { api, problemOf } from '../api/client';
import { AuthFrame } from './LoginPage';

export function RegisterPage() {
  const [f, setF] = useState({ orgType: 'supplier', legalName: '', country: 'IN', turnoverInr: '', adminName: '', adminEmail: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    const { data, error: err } = await api.POST('/api/v1/onboarding/register', {
      body: { orgType: f.orgType as 'supplier', legalName: f.legalName, country: f.country, adminName: f.adminName, adminEmail: f.adminEmail, password: f.password,
        ...(f.turnoverInr ? { turnoverInr: f.turnoverInr } : {}) },
    });
    setBusy(false);
    if (err || !data) return setError(problemOf(err).message);
    setDone(data.next);
  }

  if (done) {
    return (
      <AuthFrame>
        <h2 className="bv-heading-m">Registered</h2>
        <Alert tone="success" title={done} />
        <LinkButton href="/" size="lg">Go to sign in</LinkButton>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame>
      <form className="auth__form" onSubmit={submit}>
        <h2 className="bv-heading-m">Register your organisation</h2>
        <SelectField label="I am a" value={f.orgType} onChange={set('orgType')}>
          <option value="supplier">Supplier (exporter)</option><option value="buyer">Buyer</option><option value="bank">Bank</option><option value="insurer">Insurer</option>
        </SelectField>
        <TextField label="Legal name" value={f.legalName} onChange={set('legalName')} required minLength={2} />
        <TextField label="Country (2-letter code)" value={f.country} onChange={set('country')} required maxLength={2} minLength={2} />
        {f.orgType === 'supplier' && <TextField label="Annual turnover (INR)" value={f.turnoverInr} onChange={set('turnoverInr')} inputMode="numeric" pattern="\d+" />}
        <TextField label="Your name" value={f.adminName} onChange={set('adminName')} required />
        <TextField label="Work email" type="email" value={f.adminEmail} onChange={set('adminEmail')} required />
        <TextField label="Password" type="password" value={f.password} onChange={set('password')} required autoComplete="new-password" help="At least 12 characters with upper and lower case, a digit and a symbol." />
        {error && <Alert tone="danger" title={error} />}
        <Button type="submit" variant="primary" size="lg" loading={busy}>Register</Button>
        <LinkButton href="/" variant="link">Back to sign in</LinkButton>
      </form>
    </AuthFrame>
  );
}
