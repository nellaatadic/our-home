import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { ErrorNote, Field, Loading } from '../components/ui';

function AuthCard({ title, children, sub }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand big"><span className="brand-mark" aria-hidden>⌂</span> OUR HOME</div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
        {children}
      </div>
    </div>
  );
}

export function LoginPage() {
  const { setSession } = useSession();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [signupOpen, setSignupOpen] = useState(false);
  useEffect(() => { api.get('/auth/status').then((s) => setSignupOpen(s.signup_open)).catch(() => {}); }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      setSession(await api.post('/auth/login', { email, password }));
      const next = params.get('next');
      nav(next && next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true });
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard title="Welcome home" sub="Sign in to your household.">
      <form className="form" onSubmit={submit}>
        <Field label="Email"><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label="Password"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <ErrorNote error={error} />
        <button className="btn primary block" disabled={busy}>Sign in</button>
      </form>
      {signupOpen && <p className="muted small center">New here? <Link to="/register">Create your household</Link></p>}
      {!signupOpen && <p className="muted small center">Joining your partner? Use the invite link they sent you.</p>}
    </AuthCard>
  );
}

function RegisterForm({ inviteToken, inviteEmail }: { inviteToken?: string; inviteEmail?: string | null }) {
  const { setSession } = useSession();
  const nav = useNavigate();
  const [f, setF] = useState({ email: inviteEmail ?? '', password: '', display_name: '', household_name: 'Our home', timezone: 'America/Toronto' });
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      setSession(await api.post('/auth/register', { ...f, invite_token: inviteToken, household_name: inviteToken ? undefined : f.household_name, timezone: inviteToken ? undefined : f.timezone }));
      nav('/', { replace: true });
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={submit}>
      <Field label="Your name" hint="Shown to your partner, e.g. on the YOU tab"><input value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} required maxLength={60} /></Field>
      <Field label="Email"><input type="email" autoComplete="username" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
      <Field label="Password" hint="At least 10 characters"><input type="password" autoComplete="new-password" minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required /></Field>
      {!inviteToken && <>
        <Field label="Household name"><input value={f.household_name} onChange={(e) => setF({ ...f, household_name: e.target.value })} maxLength={80} /></Field>
        <Field label="Household time zone" hint="Used for dates like “Thursday” and for calendar imports"><input value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></Field>
      </>}
      <ErrorNote error={error} />
      <button className="btn primary block" disabled={busy}>{inviteToken ? 'Join household' : 'Create household'}</button>
    </form>
  );
}

export function RegisterPage() {
  return (
    <AuthCard title="Create your household" sub="You’ll get a private space (ME), and a shared space (US). Invite your partner afterwards.">
      <RegisterForm />
      <p className="muted small center">Already have an account? <Link to="/login">Sign in</Link></p>
    </AuthCard>
  );
}

export function InvitePage() {
  const { token } = useParams();
  const [info, setInfo] = useState<any>(null);
  useEffect(() => { api.get(`/auth/invitations/${token}`).then(setInfo).catch(() => setInfo({ valid: false })); }, [token]);
  if (!info) return <div className="center-screen"><Loading /></div>;
  if (!info.valid) {
    return <AuthCard title="Invitation not valid" sub="This link has expired or was already used. Ask for a new invite."><Link to="/login">Go to sign in</Link></AuthCard>;
  }
  return (
    <AuthCard title={`Join ${info.household_name}`} sub={`${info.inviter_name} invited you. You’ll have your own private space; only what either of you shares appears in US.`}>
      <RegisterForm inviteToken={token} inviteEmail={info.email} />
    </AuthCard>
  );
}
