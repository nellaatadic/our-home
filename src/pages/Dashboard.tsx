import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, Check, ListChecks, MessageCircle, ShoppingBasket, Sparkles } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { day, eventTime, qty, relative } from '../lib/format';
import { useOpen } from '../components/Layout';
import { Empty, Loading, PriorityDot, SpaceTag, useAction } from '../components/ui';

function Section({ title, icon, children, action }: { title: string; icon: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="card">
      <header className="card-head"><h2>{icon}{title}</h2>{action}</header>
      {children}
    </section>
  );
}

export function DashboardPage() {
  const me = useMe();
  const { data } = useApi<any>('/dashboard');
  const open = useOpen();
  const { run } = useAction();
  const [quick, setQuick] = useState('');
  if (!data) return <div className="page"><Loading /></div>;
  const show = (s: string) => data.sections.includes(s);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const addNeed = () => run(async () => { await api.post('/spaces/us/items', { module: 'grocery', title: quick, grocery_state: 'need' }); setQuick(''); emitChange(); }, 'Added to US groceries');

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{greeting}, {me.user.display_name}</h1>
          <p className="muted">{day(data.today, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </div>
        <Link to="/settings#dashboard" className="btn small ghost">Customize</Link>
      </header>

      <div className="dash-grid">
        {show('today') && (
          <Section title="Today in US" icon={<CalendarDays size={18} />} action={<Link to="/calendar" className="small">Calendar</Link>}>
            {data.today_events.length ? (
              <ul className="rows">{data.today_events.map((e: any) => (
                <li key={e.id}><button className="row-btn" onClick={() => open('event', e.id)}><span className="time">{eventTime(e)}</span><span className="grow">{e.title}</span></button></li>
              ))}</ul>
            ) : <p className="muted small">Nothing shared on the calendar today.</p>}
          </Section>
        )}

        {show('need') && (
          <Section title="We need" icon={<ShoppingBasket size={18} />} action={<Link to="/us/groceries" className="small">Groceries</Link>}>
            <form className="quick-add" onSubmit={(e) => { e.preventDefault(); if (quick.trim()) addNeed(); }}>
              <input value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="Add to US groceries…" aria-label="Add grocery item" />
              <button className="btn small primary" disabled={!quick.trim()}>Add</button>
            </form>
            {data.need.length ? (
              <ul className="rows">{data.need.map((i: any) => (
                <li key={i.id}>
                  <button className="check-btn" aria-label={`Mark ${i.title} purchased`} onClick={() => run(async () => { await api.post(`/items/${i.id}/purchase`, {}); emitChange(); }, `${i.title} → STOCK`)}><Check size={14} /></button>
                  <button className="row-btn" onClick={() => open('item', i.id)}><PriorityDot p={i.priority} /><span className="grow">{i.title}</span><span className="muted small">{qty(i.quantity, i.unit)}</span><SpaceTag space={i.space} /></button>
                </li>
              ))}</ul>
            ) : <p className="muted small">The NEED list is empty.</p>}
          </Section>
        )}

        {show('reminders') && (
          <Section title="Reminders & due soon" icon={<ListChecks size={18} />} action={<Link to="/us/tasks" className="small">Tasks</Link>}>
            {data.reminders.length ? (
              <ul className="rows">{data.reminders.map((t: any) => (
                <li key={t.id}><button className="row-btn" onClick={() => open('task', t.id)}><PriorityDot p={t.priority} /><span className="grow">{t.title}</span><span className="muted small">{t.due_date ? day(t.due_date) : ''}</span><SpaceTag space={t.space} /></button></li>
              ))}</ul>
            ) : <p className="muted small">Nothing due in the next few days.</p>}
          </Section>
        )}

        {show('assigned') && (
          <Section title="Who’s doing what" icon={<ListChecks size={18} />}>
            <div className="split">
              <div>
                <h3>ME · {me.user.display_name}</h3>
                {data.assigned.me.length ? <ul className="rows">{data.assigned.me.map((t: any) => <li key={t.id}><button className="row-btn" onClick={() => open('task', t.id)}><span className="grow">{t.title}</span>{t.assignee === 'both' && <span className="pill tiny">both</span>}</button></li>)}</ul> : <p className="muted small">Nothing assigned.</p>}
              </div>
              {me.partner && (
                <div>
                  <h3>YOU · {me.partner.display_name}</h3>
                  {data.assigned.partner.length ? <ul className="rows">{data.assigned.partner.map((t: any) => <li key={t.id}><button className="row-btn" onClick={() => open('task', t.id)}><span className="grow">{t.title}</span>{t.assignee === 'both' && <span className="pill tiny">both</span>}</button></li>)}</ul> : <p className="muted small">Nothing assigned.</p>}
                </div>
              )}
            </div>
          </Section>
        )}

        {show('awaiting') && (
          <Section title="Waiting for your opinion" icon={<Sparkles size={18} />}>
            {data.awaiting.length || data.unread_threads.length ? (
              <ul className="rows">
                {data.awaiting.map((i: any) => <li key={i.id}><button className="row-btn" onClick={() => open('item', i.id)}><span className="grow">{i.title}</span><span className="muted small">{i.created_by_name} · {i.decision_status}</span></button></li>)}
                {data.unread_threads.map((t: any) => <li key={t.entity_id}><button className="row-btn" onClick={() => open(t.entity_type, t.entity_id)}><MessageCircle size={14} /><span className="grow">New messages</span><b className="badge inline">{t.unread}</b></button></li>)}
              </ul>
            ) : <p className="muted small">You’re all caught up.</p>}
          </Section>
        )}

        {show('upcoming') && (
          <Section title="Coming up" icon={<CalendarDays size={18} />}>
            {data.upcoming.length ? (
              <ul className="rows">{data.upcoming.map((e: any) => (
                <li key={e.id}><button className="row-btn" onClick={() => open('event', e.id)}><span className="time">{day(e.start_date, { weekday: 'short', day: 'numeric' })}</span><span className="grow">{e.title}</span><SpaceTag space={e.space} /></button></li>
              ))}</ul>
            ) : <p className="muted small">Nothing in the next two weeks.</p>}
          </Section>
        )}

        {show('recent') && (
          <Section title="Recently in US" icon={<Sparkles size={18} />}>
            {data.recent.length ? (
              <ul className="rows">{data.recent.map((r: any, i: number) => (
                <li key={i}><button className="row-btn" onClick={() => r.entity_type !== 'receipt' && open(r.entity_type, r.entity_id)}><span className="grow"><b>{r.actor_name}</b> {r.summary}</span><span className="muted small">{relative(r.created_at)}</span></button></li>
              ))}</ul>
            ) : <Empty title="Nothing shared yet">Add something to US, or share from your private space.</Empty>}
          </Section>
        )}
      </div>
    </div>
  );
}
