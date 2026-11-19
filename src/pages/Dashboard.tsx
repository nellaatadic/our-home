import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarHeart, CalendarDays, Check, ChevronRight, Lock, LockOpen, Maximize2, MoreHorizontal, Plus } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { day, dueLabel, greeting } from '../lib/format';
import { LISTS } from '../lib/lists';
import { useOpen } from '../components/Layout';
import { ItemRow, usePurchase } from '../components/ItemRow';
import { TimeGrid } from '../components/TimeGrid';
import { Loading, useAction } from '../components/ui';

type Widget = { max: number; size: 's' | 'm' | 'l'; hidden?: boolean };

export function DashboardPage() {
  const me = useMe();
  const { data, setData } = useApi<any>('/dashboard');
  const { run } = useAction();
  if (!data) return <div className="page"><Loading /></div>;
  const widgets: Record<string, Widget> = data.prefs.widgets;
  const hidden = LISTS.filter((l) => widgets[l.module]?.hidden);

  const saveWidget = (module: string, w: Widget) => run(async () => {
    const next = { ...widgets, [module]: w };
    setData({ ...data, prefs: { ...data.prefs, widgets: next } });
    await api.patch('/household/settings', { dashboard: { widgets: next } });
    emitChange();
  });

  return (
    <div className="page dashboard">
      <div className="dash-row first">
        <section className="tile greet">
          <p className="greet-hello">{greeting(me.household.timezone)},</p>
          <h1>{me.user.display_name}</h1>
          <p className="greet-date">{day(data.today, { weekday: 'long' })}{' '}<br /><b>{day(data.today, { month: 'long', day: 'numeric' })}</b></p>
          {data.unread_messages > 0 && <Link to="/chat" className="greet-chat">{data.unread_messages} new message{data.unread_messages > 1 ? 's' : ''} <ChevronRight size={13} /></Link>}
          {hidden.length > 0 && (
            <button className="link-btn tiny" onClick={() => hidden.forEach((l) => saveWidget(l.module, { ...widgets[l.module], hidden: false }))}>Show {hidden.map((l) => l.short).join(', ')}</button>
          )}
        </section>
        {LISTS.filter((l) => !widgets[l.module]?.hidden).map((l) => (
          <ListWidget key={l.module} list={l} data={data.lists[l.module]} widget={widgets[l.module]} onSave={(w) => saveWidget(l.module, w)} />
        ))}
      </div>
      <div className="dash-row second">
        <ImportantDates events={data.important_dates} today={data.today} />
        <Todos todos={data.todos} items={data.dated_items} today={data.today} />
        <section className="tile">
          <header className="tile-head">
            <h2><CalendarDays size={16} /> Today</h2>
            <Link to="/calendar" className="icon-btn small" aria-label="Open calendar"><Maximize2 size={14} /></Link>
          </header>
          <TimeGrid days={[data.today]} events={data.today_events} busy={data.partner_busy} lanes={Boolean(me.partner)} hourHeight={24} fromHour={8} toHour={21} compact />
        </section>
      </div>
    </div>
  );
}

function ListWidget({ list, data, widget, onSave }: { list: (typeof LISTS)[number]; data: { items: any[]; need: number }; widget: Widget; onSave: (w: Widget) => void }) {
  const me = useMe();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [locked, setLocked] = useState(false);
  const [menu, setMenu] = useState(false);
  const { run, busy } = useAction();
  const purchase = usePurchase();
  const add = () => title.trim() && run(async () => {
    await api.post(`/modules/${list.module}/items`, { title: title.trim(), private: locked });
    setTitle('');
    emitChange();
  });
  return (
    <section className={`tile list-tile size-${widget.size}`} style={{ ['--list' as any]: list.color }}>
      <header className="tile-head">
        <h2><span className="list-icon tiny" style={{ background: list.color }} aria-hidden>{list.emoji}</span>{list.label} <span className="count">{data.need}</span></h2>
        <div className="tile-actions">
          <button className="icon-btn small" onClick={() => setAdding((x) => !x)} aria-label={`Add to ${list.label}`} aria-expanded={adding}><Plus size={15} /></button>
          <button className="icon-btn small" onClick={() => setMenu((x) => !x)} aria-label={`${list.label} widget settings`} aria-expanded={menu}><MoreHorizontal size={15} /></button>
          <Link to={`/lists/${list.slug}`} className="icon-btn small" aria-label={`Open full ${list.label} list`}><Maximize2 size={14} /></Link>
        </div>
      </header>
      {menu && (
        <div className="tile-menu">
          <label>Show <select value={widget.max} onChange={(e) => onSave({ ...widget, max: Number(e.target.value) })} aria-label="Items shown">
            {[3, 5, 8, 12].map((n) => <option key={n} value={n}>{n} items</option>)}
          </select></label>
          <label>Size <select value={widget.size} onChange={(e) => onSave({ ...widget, size: e.target.value as Widget['size'] })} aria-label="Widget size">
            <option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option>
          </select></label>
          <button className="link-btn" onClick={() => { setMenu(false); onSave({ ...widget, hidden: true }); }}>Hide</button>
        </div>
      )}
      {adding && (
        <form className="tile-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`Add to ${list.short}…`} aria-label={`New ${list.label} item`} />
          <button type="button" className={`icon-btn small lock-toggle ${locked ? 'on' : ''}`} onClick={() => setLocked((x) => !x)} aria-pressed={locked} aria-label={locked ? 'Private' : 'Shared'} title={locked ? 'Private: only you' : `Shared with ${me.partner?.display_name ?? 'partner'}`}>
            {locked ? <Lock size={13} /> : <LockOpen size={13} />}
          </button>
          <button className="btn small primary" disabled={!title.trim() || busy}>Add</button>
        </form>
      )}
      {data.items.length ? (
        <ul className="items compact">{data.items.map((i) => <ItemRow key={i.id} item={i} compact onCheck={() => purchase(i)} />)}</ul>
      ) : <p className="muted small tile-empty">Nothing needed.</p>}
      {data.need > data.items.length && <Link to={`/lists/${list.slug}`} className="tile-more">+{data.need - data.items.length} more</Link>}
    </section>
  );
}

function ImportantDates({ events, today }: { events: any[]; today: string }) {
  const open = useOpen();
  const daysUntil = (d: string) => Math.round((Date.parse(d) - Date.parse(today)) / 86400000);
  return (
    <section className="tile">
      <header className="tile-head">
        <h2><CalendarHeart size={16} /> Important dates</h2>
        <Link to="/calendar" className="icon-btn small" aria-label="Open calendar"><Maximize2 size={14} /></Link>
      </header>
      {events.length ? (
        <ul className="dates">
          {events.map((e) => {
            const n = daysUntil(e.start_date);
            return (
              <li key={e.id + e.start_date}>
                <button className="date-row" onClick={() => open('event', e.id)}>
                  <span className="date-badge"><small>{day(e.start_date, { month: 'short' })}</small><b>{Number(e.start_date.slice(8))}</b></span>
                  <span className="grow">
                    <span className="clamp1">{e.title}</span>
                    <span className="muted tiny">{e.category ?? 'Event'}{e.years && /birthday/i.test(e.category ?? '') ? ` · turns ${e.years}` : e.years ? ` · ${e.years} years` : ''}</span>
                  </span>
                  <span className={`days-until ${n <= 7 ? 'soon' : ''}`}>{n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `${n} days`}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : <p className="muted small tile-empty">No birthdays or social events in the next four months. Add one in the calendar with the category “Birthday” or “Social”.</p>}
    </section>
  );
}

function Todos({ todos, items, today }: { todos: any[]; items: any[]; today: string }) {
  const me = useMe();
  const open = useOpen();
  const purchase = usePurchase();
  const { run, busy } = useAction();
  const [title, setTitle] = useState('');
  const [locked, setLocked] = useState(false);
  const rows = [
    ...todos.map((t) => ({ kind: 'task' as const, id: t.id, title: t.title, date: t.due_date, time: t.due_time, who: t.assignee === 'both' ? 'Both' : t.assignee === 'user' ? (t.assigned_user_id === me.user.id ? 'You' : me.partner?.display_name) : null, private: t.space === 'me', raw: t })),
    ...items.map((i) => ({ kind: 'item' as const, id: i.id, title: i.title, date: i.due_date, time: i.due_time, who: null, private: i.private, raw: i })),
  ].sort((a, b) => (a.date ?? '9999') < (b.date ?? '9999') ? -1 : (a.date ?? '9999') > (b.date ?? '9999') ? 1 : 0);
  const add = () => title.trim() && run(async () => {
    await api.post(`/spaces/${locked ? 'me' : 'us'}/tasks`, { title: title.trim() });
    setTitle('');
    emitChange();
  });
  const done = (r: (typeof rows)[number]) => r.kind === 'task'
    ? run(async () => { await api.patch(`/tasks/${r.id}`, { status: 'completed' }); emitChange(); }, `Done: ${r.title}`)
    : purchase(r.raw);
  return (
    <section className="tile">
      <header className="tile-head"><h2><Check size={16} /> To do &amp; reminders</h2></header>
      <form className="tile-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a to-do…" aria-label="New to-do" />
        <button type="button" className={`icon-btn small lock-toggle ${locked ? 'on' : ''}`} onClick={() => setLocked((x) => !x)} aria-pressed={locked} aria-label={locked ? 'Private' : 'Shared'}>{locked ? <Lock size={13} /> : <LockOpen size={13} />}</button>
        <button className="btn small primary" disabled={!title.trim() || busy}>Add</button>
      </form>
      {rows.length ? (
        <ul className="todo-list">
          {rows.slice(0, 10).map((r) => (
            <li key={r.kind + r.id}>
              <button className="circle" onClick={() => done(r)} aria-label={`Done: ${r.title}`}><Check size={12} /></button>
              <button className="item-main" onClick={() => open(r.kind, r.id)}>
                <span className="item-title">{r.title}</span>
                <span className="item-meta">
                  {r.date && <span className={r.date < today ? 'overdue' : r.date === today ? 'today' : ''}>{dueLabel(r.date, r.time, today)}</span>}
                  {r.who && <span>{r.who}</span>}
                  {r.kind === 'item' && <span>{LISTS.find((l) => l.module === r.raw.module)?.short}</span>}
                </span>
              </button>
              {r.private && <Lock size={12} className="muted" aria-label="Private" />}
            </li>
          ))}
        </ul>
      ) : <p className="muted small tile-empty">Nothing to do. Items with a date show up here too.</p>}
    </section>
  );
}
