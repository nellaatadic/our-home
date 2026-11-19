import { useSearchParams } from 'react-router-dom';
import { api, emitChange, useApi } from '../lib/api';
import { Confirm, Empty, Loading, useAction } from '../components/ui';
import { useState } from 'react';

export function ConnectionsPage() {
  const { data, reload } = useApi<any>('/google/status');
  const [params] = useSearchParams();
  const { run, busy } = useAction();
  const [disconnect, setDisconnect] = useState<any>(null);
  const connect = (purpose: 'import' | 'export', connection_id?: string) => run(async () => {
    const r = await api.post('/google/connect', { purpose, connection_id });
    window.location.assign(r.url);
  });
  if (!data) return <div className="page"><Loading /></div>;
  return (
    <div className="page narrow">
      <h1>Google calendars</h1>
      {params.get('connected') && <p className="note ok">Connected {params.get('connected')}. Choose which calendars to use below.</p>}
      {params.get('google_error') && <p className="note error">{params.get('google_error')}</p>}
      {!data.configured ? (
        <div className="card">
          <h2>Not configured on this server</h2>
          <p>Google Calendar needs OAuth credentials before anyone can connect. Missing: <code>{data.missing.join(', ')}</code>.</p>
          <p className="muted small">See <code>docs/GOOGLE_OAUTH.md</code> in the repository for the setup steps.</p>
        </div>
      ) : (
        <>
          <p className="muted">Each of you connects your own Google accounts. Tokens are stored encrypted on the server and never shared with your partner. Importing uses read-only access; adding events to Google needs extra permission you can grant per account.</p>
          <div className="row gap-s"><button className="btn primary" disabled={busy} onClick={() => connect('import')}>Connect a Google account</button></div>
          {data.connections.length === 0 && <Empty title="No Google accounts connected" />}
          {data.connections.map((c: any) => (
            <section key={c.id} className="card">
              <div className="row between wrap">
                <h2>{c.google_email}</h2>
                <div className="row gap-s wrap">
                  {c.status === 'needs_reauth' && <button className="btn small primary" onClick={() => connect('import', c.id)}>Reconnect</button>}
                  {!c.can_export && <button className="btn small" onClick={() => connect('export', c.id)}>Allow adding events</button>}
                  <button className="btn small ghost" onClick={() => run(async () => { await api.post(`/google/connections/${c.id}/sync`); reload(); }, 'Calendar list updated')}>Refresh list</button>
                  <button className="btn small danger-ghost" onClick={() => setDisconnect(c)}>Disconnect</button>
                </div>
              </div>
              {c.status === 'needs_reauth' && <p className="note warn">Access expired or was revoked. {c.last_error}</p>}
              <p className="muted small">{c.can_export ? 'Read + add events' : 'Read-only'}</p>
              <ul className="pick-list">
                {c.calendars.map((k: any) => (
                  <li key={k.id}>
                    <label className="check">
                      <input type="checkbox" checked={k.selected} onChange={(e) => run(async () => { await api.patch(`/google/calendars/${k.id}`, { selected: e.target.checked }); reload(); emitChange(); })} />
                      <span className="swatch" style={{ background: k.color ?? '#ccc' }} /> {k.summary} {k.is_primary && <span className="pill tiny">primary</span>} <span className="muted small">{k.access_role}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <p className="muted small">Selected calendars are offered when you import and checked for changes.</p>
            </section>
          ))}
        </>
      )}
      {disconnect && (
        <Confirm title={`Disconnect ${disconnect.google_email}?`} confirmLabel="Disconnect" onClose={() => setDisconnect(null)}
          body={<p>OUR HOME will revoke its access and delete the stored tokens. Events you already imported stay in OUR HOME. Your Google Calendar is not changed.</p>}
          onConfirm={() => run(async () => { await api.post(`/google/connections/${disconnect.id}/disconnect`); setDisconnect(null); reload(); }, 'Disconnected')} />
      )}
    </div>
  );
}
