import { useState } from 'react';
import QRCode from 'qrcode';
import { api, problemOf, setCsrfToken } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { useBrand } from '../branding';

type Step = 'password' | 'mfa' | 'enroll' | 'recovery';

export function LoginPage() {
  const { refresh } = useAuth();
  const brand = useBrand();
  const [step, setStep] = useState<Step>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [qr, setQr] = useState<{ img: string; secret: string } | null>(null);
  const [recovery, setRecovery] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    const { data, error: err } = await api.POST('/api/v1/auth/login', { body: { email, password } });
    setBusy(false);
    if (err || !data) return setError(problemOf(err).message);
    setCsrfToken(data.csrfToken);
    if (data.mfaEnrolled) return setStep('mfa');
    const enr = await api.POST('/api/v1/auth/mfa/enroll');
    if (!enr.data) return setError(problemOf(enr.error).message);
    setQr({ img: await QRCode.toDataURL(enr.data.otpauthUrl), secret: enr.data.secret });
    setStep('enroll');
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    const { data, error: err } = await api.POST('/api/v1/auth/mfa/verify', { body: { code } });
    setBusy(false);
    if (err || !data) return setError(problemOf(err).message);
    if (data.recoveryCodes?.length) { setRecovery(data.recoveryCodes); setStep('recovery'); return; }
    await refresh();
  }

  // Demo helper (development only): fills the current code for a seeded demo user.
  async function fillDemoCode() {
    const r = await api.GET('/api/v1/dev/totp', { params: { query: { email } } });
    if (r.data) setCode(r.data.code);
  }

  return (
    <div className="login">
      <h1>{brand.logo && <img src={brand.logo} alt="" height={32} style={{ verticalAlign: 'middle', marginRight: 8 }} />}{brand.displayName}</h1>
      <p className="muted">{brand.welcome ?? 'Tri-party receivables financing. Sign in to continue.'}</p>
      {brand.whiteLabel && <p className="hint">Powered by Earlio</p>}
      {error && <div className="alert" role="alert">{error}</div>}
      {step === 'password' && (
        <form onSubmit={submitPassword}>
          <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <button disabled={busy}>Continue</button>
          <p className="hint">Demo users: <code>admin@shree.demo</code>, <code>approver@northwind.demo</code>, <code>credit@aurelia.demo</code> … password <code>Earlio!Demo1</code></p>
          <p className="hint">New to Earlio? <a href="/register">Register your organisation</a></p>
        </form>
      )}
      {(step === 'mfa' || step === 'enroll') && (
        <form onSubmit={submitCode}>
          {step === 'enroll' && qr && (
            <div className="enroll">
              <p>Scan this QR code with an authenticator app, then enter the 6-digit code.</p>
              <img src={qr.img} alt="Authenticator QR code" width={180} height={180} />
              <p className="muted">Or enter this key manually: <code>{qr.secret}</code></p>
            </div>
          )}
          <label>Authentication code<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required /></label>
          <button disabled={busy}>Verify</button>
          <button type="button" className="link" onClick={fillDemoCode}>Use demo code (development)</button>
        </form>
      )}
      {step === 'recovery' && (
        <div>
          <p>Save these one-time recovery codes now. They will not be shown again.</p>
          <pre>{recovery.join('\n')}</pre>
          <button onClick={() => refresh()}>I have saved them</button>
        </div>
      )}
    </div>
  );
}
