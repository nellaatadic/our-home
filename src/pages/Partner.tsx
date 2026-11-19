import { Heart, Lock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { day, eventTime } from '../lib/format';
import { useOpen } from '../components/Layout';
import { Empty, Loading, PriorityDot } from '../components/ui';

/** YOU: what the partner has shared or is responsible for. Their private space is never shown. */
export function PartnerPage() {
  const me = useMe();
  const open = useOpen();
  const { data } = useApi<any>('/partner');
  if (!me.partner) {
    return (
      <div className="page">
        <h1><Heart size={20} /> YOU</h1>
        <Empty title="Your partner hasn’t joined yet">{me.role === 'primary' ? <>Invite them from <Link to="/settings">Settings</Link>. They’ll get their own private space and access to US.</> : null}</Empty>
      </div>
    );
  }
  if (!data) return <div className="page"><Loading /></div>;
  const name = me.partner.display_name;
  return (
    <div className="page page-you">
      <header className="page-head space-head">
        <div>
          <h1><Heart size={20} /> YOU · {name}</h1>
          <p className="muted"><Lock size={12} /> {name}’s private space stays private. Here is what {name} shares with US and what’s on {name}’s plate.</p>
        </div>
      </header>
      <div className="dash-grid">
        <section className="card">
          <h2 className="card-title">On {name}’s list</h2>
          {data.tasks.length ? <ul className="rows">{data.tasks.map((t: any) => <li key={t.id}><button className="row-btn" onClick={() => open('task', t.id)}><PriorityDot p={t.priority} /><span className="grow">{t.title}</span>{t.due_date && <span className="muted small">{day(t.due_date)}</span>}</button></li>)}</ul> : <p className="muted small">No open tasks assigned to {name}.</p>}
        </section>
        <section className="card">
          <h2 className="card-title">{name}’s upcoming events in US</h2>
          {data.events.length ? <ul className="rows">{data.events.map((e: any) => <li key={e.id}><button className="row-btn" onClick={() => open('event', e.id)}><span className="time">{day(e.start_date, { day: 'numeric', month: 'short' })}</span><span className="grow">{e.title}</span><span className="muted small">{eventTime(e)}</span></button></li>)}</ul> : <p className="muted small">Nothing coming up.</p>}
        </section>
        <section className="card">
          <h2 className="card-title">For {name}</h2>
          {data.for_them.length ? <ul className="rows">{data.for_them.map((i: any) => <li key={i.id}><button className="row-btn" onClick={() => open('item', i.id)}><span className="grow">{i.title}</span><span className="muted small">{i.decision_status ?? i.grocery_state}</span></button></li>)}</ul> : <p className="muted small">Add gifts, clothes or ideas for {name} in US and pick them under “Intended for”.</p>}
        </section>
        <section className="card">
          <h2 className="card-title">Shared by {name}</h2>
          {data.contributed.length ? <ul className="rows">{data.contributed.map((i: any) => <li key={i.id}><button className="row-btn" onClick={() => open('item', i.id)}><span className="grow">{i.title}</span><span className="muted small">{i.module === 'grocery' ? 'groceries' : i.module}</span></button></li>)}</ul> : <p className="muted small">Nothing shared yet.</p>}
        </section>
      </div>
    </div>
  );
}
