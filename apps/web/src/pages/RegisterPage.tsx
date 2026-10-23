import { useState } from 'react';
import { api, problemOf } from '../api/client';

export function RegisterPage() {
  const [f, setF] = useState({ orgType: 'supplier', legalName: '', country: 'IN', turnoverInr: '', adminName: '', adminEmail: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null);
    const { data, error: err } = await api.POST('/api/v1/onboarding/register', {
      body: { orgType: f.orgType as 'supplier', legalName: f.legalName, country: f.country, adminName: f.adminName, adminEmail: f.adminEmail, password: f.password,
        ...(f.turnoverInr ? { turnoverInr: f.turnoverInr } : {}) },
    });
    if (err || !data) return setError(problemOf(err).message);
    setDone(data.next);
  }

  if (done) return <div className="login"><h2>Registered</h2><p className="ok">{done}</p><a href="/">Go to sign in</a></div>;
  return (
    <form className="login" onSubmit={submit}>
      <h2>Register your organisation</h2>
      <label>I am a
        <select value={f.orgType} onChange={set('orgType')}>
          <option value="supplier">Supplier (exporter)</option><option value="buyer">Buyer</option><option value="bank">Bank</option><option value="insurer">Insurer</option>
        </select>
      </label>
      <label>Legal name<input value={f.legalName} onChange={set('legalName')} required minLength={2} /></label>
      <label>Country (2-letter code)<input value={f.country} onChange={set('country')} required maxLength={2} minLength={2} /></label>
      {f.orgType === 'supplier' && <label>Annual turnover (INR)<input value={f.turnoverInr} onChange={set('turnoverInr')} inputMode="numeric" pattern="\d+" /></label>}
      <label>Your name<input value={f.adminName} onChange={set('adminName')} required /></label>
      <label>Work email<input type="email" value={f.adminEmail} onChange={set('adminEmail')} required /></label>
      <label>Password<input type="password" value={f.password} onChange={set('password')} required /></label>
      <p className="hint">At least 12 characters with upper and lower case, a digit and a symbol.</p>
      {error && <p className="alert">{error}</p>}
      <button type="submit">Register</button> <a href="/">Back to sign in</a>
    </form>
  );
}
