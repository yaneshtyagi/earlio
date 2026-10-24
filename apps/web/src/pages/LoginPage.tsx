import { useState } from 'react';
import QRCode from 'qrcode';
import { Alert, AppIdentity, Button, Card, CardBody, TextField } from '@yaneshtyagi/design-system';
import { api, problemOf, setCsrfToken } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { APP_VERSION, useBrand } from '../branding';

type Step = 'password' | 'mfa' | 'enroll' | 'recovery';

/** The sign-in frame shared by sign-in and registration. */
export function AuthFrame({ children }: { children: React.ReactNode }) {
  const brand = useBrand();
  return (
    <main className="auth">
      <Card className="auth__card">
        <CardBody>
          <div className="auth__form">
            <AppIdentity as="h1" layout="stacked" size="lg" name={brand.displayName} subtitle={brand.whiteLabel ? 'Powered by Earlio' : 'Developed by BrainVault'} version={APP_VERSION}
              logo={brand.logo ? <img src={brand.logo} alt="" height={32} /> : undefined} />
            {children}
          </div>
        </CardBody>
      </Card>
    </main>
  );
}

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
    <AuthFrame>
      <p className="page-lede">{brand.welcome ?? 'Tri-party receivables financing. Sign in to continue.'}</p>
      {error && <Alert tone="danger" title={error} />}
      {step === 'password' && (
        <form className="auth__form" onSubmit={submitPassword}>
          <TextField label="Email" type="email" size="lg" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <TextField label="Password" type="password" size="lg" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <Button type="submit" variant="primary" size="lg" loading={busy}>Continue</Button>
          <p className="hint">Demo users: <span className="mono">admin@shree.demo</span>, <span className="mono">approver@northwind.demo</span>, <span className="mono">credit@aurelia.demo</span> … password <span className="mono">Earlio!Demo1</span></p>
          <p className="hint">New to Earlio? <a href="/register">Register your organisation</a></p>
        </form>
      )}
      {(step === 'mfa' || step === 'enroll') && (
        <form className="auth__form" onSubmit={submitCode}>
          {step === 'enroll' && qr && (
            <div className="stack-3">
              <p>Scan this QR code with an authenticator app, then enter the 6-digit code.</p>
              <img className="auth__qr" src={qr.img} alt="Authenticator QR code" width={180} height={180} />
              <p className="hint">Or enter this key manually: <span className="mono">{qr.secret}</span></p>
            </div>
          )}
          <TextField label="Authentication code" size="lg" mono inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
          <Button type="submit" variant="primary" size="lg" loading={busy}>Verify</Button>
          <Button type="button" variant="link" onClick={fillDemoCode}>Use demo code (development)</Button>
        </form>
      )}
      {step === 'recovery' && (
        <div className="auth__form">
          <p>Save these one-time recovery codes now. They will not be shown again.</p>
          <pre className="prose-quote mono pre">{recovery.join('\n')}</pre>
          <Button variant="primary" size="lg" onClick={() => refresh()}>I have saved them</Button>
        </div>
      )}
    </AuthFrame>
  );
}
