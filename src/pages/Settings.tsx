import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, useApi } from '../lib/api';
import { useMe, useSession } from '../lib/session';
import { Field, useAction, useToast } from '../components/ui';

const PREFS = [
  ['notify_mentions', 'When someone mentions me'], ['notify_replies', 'Replies in conversations I’m part of'], ['notify_shared', 'New things shared with US'],
  ['notify_assigned', 'Tasks assigned to me and their updates'], ['notify_reminders', 'Reminders'], ['notify_calendar', 'Changes to the US calendar'], ['notify_decisions', 'Reactions and decisions'],
] as const;

export function SettingsPage() {
  const me = useMe();
  const { setSession, logout, config } = useSession();
  const toast = useToast();
  const { run, busy } = useAction();
  const { data: settings, setData } = useApi<{ settings: any }>('/household/settings');
  const [name, setName] = useState(me.user.display_name);
  const [hh, setHh] = useState({ name: me.household.name, timezone: me.household.timezone, currency: me.household.currency });
  const [invite, setInvite] = useState<{ url: string } | null>(null);
  const [pw, setPw] = useState({ current_password: '', new_password: '' });
  const patchSettings = (b: any) => run(async () => setData(await api.patch('/household/settings', b)));
  const s = settings?.settings;

  return (
    <div className="page narrow">
      <h1>Settings</h1>

      <section className="card">
        <h2>You</h2>
        <form className="row gap-s wrap" onSubmit={(e) => { e.preventDefault(); run(async () => setSession(await api.patch('/auth/profile', { display_name: name })), 'Name updated'); }}>
          <Field label="Display name" hint="Your partner sees this instead of “YOU”"><input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></Field>
          <button className="btn" disabled={busy || !name.trim()}>Save</button>
        </form>
        <p className="muted small">Signed in as {me.user.email}</p>
        <details>
          <summary>Change password</summary>
          <form className="form" onSubmit={(e) => { e.preventDefault(); run(async () => { await api.post('/auth/password', pw); setPw({ current_password: '', new_password: '' }); }, 'Password changed. Other devices were signed out.'); }}>
            <Field label="Current password"><input type="password" autoComplete="current-password" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} /></Field>
            <Field label="New password" hint="At least 10 characters"><input type="password" autoComplete="new-password" minLength={10} value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} /></Field>
            <button className="btn" disabled={busy || pw.new_password.length < 10}>Change password</button>
          </form>
        </details>
      </section>

      <section className="card">
        <h2>Household</h2>
        <div className="grid-2">
          <Field label="Name"><input value={hh.name} onChange={(e) => setHh({ ...hh, name: e.target.value })} maxLength={80} /></Field>
          <Field label="Time zone" hint="IANA name, e.g. America/Toronto"><input value={hh.timezone} onChange={(e) => setHh({ ...hh, timezone: e.target.value })} /></Field>
          <Field label="Currency"><input value={hh.currency} onChange={(e) => setHh({ ...hh, currency: e.target.value.toUpperCase() })} maxLength={3} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={me.household.auto_move_to_stock} onChange={(e) => run(async () => setSession(await api.patch('/household', { auto_move_to_stock: e.target.checked })))} /> When a NEED item is ticked off, move it to STOCK without asking for the quantity</label>
        <div className="row end"><button className="btn" disabled={busy} onClick={() => run(async () => setSession(await api.patch('/household', hh)), 'Household saved')}>Save household</button></div>
        <h3>Members</h3>
        <ul className="rows">{me.members.map((m) => <li key={m.id}><div className="row-btn static"><span className="grow">{m.display_name}</span><span className="muted small">{m.role === 'primary' ? 'Primary' : 'Partner'}</span></div></li>)}</ul>
        {me.role === 'primary' && me.members.length < 2 && (
          <div className="stack">
            <p className="muted small">Invite your partner. They create their own login and private space; the link works once and expires in 7 days.</p>
            <button className="btn primary" disabled={busy} onClick={() => run(async () => setInvite(await api.post('/household/invitations', {})))}>Create invite link</button>
            {invite && (
              <div className="row gap-s">
                <input className="grow" readOnly value={invite.url} onFocus={(e) => e.target.select()} aria-label="Invite link" />
                <button className="btn" onClick={() => navigator.clipboard.writeText(invite.url).then(() => toast('Link copied'))}>Copy</button>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="card" id="calendar-privacy">
        <h2>Calendar</h2>
        {s && <label className="check"><input type="checkbox" checked={s.share_availability} onChange={(e) => patchSettings({ share_availability: e.target.checked })} /> Show my private events to {me.partner?.display_name ?? 'my partner'} as “Busy”</label>}
        <p className="muted small">Only the time is shown, never the title, place or notes. Off by default. The dashboard and day view then show both schedules side by side.</p>
      </section>

      <section className="card" id="dashboard">
        <h2>Dashboard</h2>
        <p className="muted small">Use the ⋯ button on each list on the dashboard to change how many items it shows and its size, or to hide it.</p>
      </section>

      <section className="card">
        <h2>Notifications</h2>
        <p className="muted small">In-app only. Nothing is sent by email or push.</p>
        {s && PREFS.map(([k, label]) => <label key={k} className="check"><input type="checkbox" checked={s[k]} onChange={(e) => patchSettings({ [k]: e.target.checked })} /> {label}</label>)}
      </section>

      <section className="card">
        <h2>Connections & data</h2>
        <p><Link to="/calendar/connections">Google calendars</Link> {config.google_configured ? '' : <span className="muted small">(not configured on this server)</span>}</p>
        <p className="muted small">Receipt reading and text-to-event AI: {config.ai_configured ? 'enabled' : 'not configured — the built-in parser and manual entry are used'}.</p>
        <p><Link to="/archive">Archive</Link></p>
      </section>

      <button className="btn ghost" onClick={logout}>Sign out</button>
    </div>
  );
}
