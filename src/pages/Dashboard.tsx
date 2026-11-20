import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, CalendarDays, Check, ChevronDown, ChevronUp, Lock, LockOpen, MessageCircle, Minus, Plus, Receipt } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { day, dueLabel } from '../lib/format';
import { listApi, type ListDef } from '../lib/lists';
import { useLists } from '../lib/useLists';
import { useOpen } from '../components/Layout';
import { ItemRow, ReceiptSheet, usePurchase } from '../components/ItemRow';
import { NewListSheet } from '../components/ListSheets';
import { Thread } from '../components/Thread';
import { Loading, useAction } from '../components/ui';

const PREVIEW = 2;

function greetingWord(tz: string) {
  const h = Number(new Intl.DateTimeFormat('en-CA', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(new Date()));
  return h < 5 ? 'Good Night' : h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening';
}

function lastUpdate(ts: string | null, tz: string) {
  if (!ts) return null;
  const d = new Date(ts);
  const sameDay = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d) === new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  return sameDay
    ? new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(d)
    : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: tz }).format(d);
}

/**
 * Home: a greeting, then every list and the events as simple cards. Cards
 * open in place (more items appear below the header), and each list has its
 * own chat that slides in beside the cards instead of leaving the page.
 */
export function DashboardPage() {
  const me = useMe();
  const { data } = useApi<any>('/dashboard');
  const { lists } = useLists();
  const [params, setParams] = useSearchParams();
  const [newList, setNewList] = useState(false);
  const chatId = params.get('chat');
  const chatList = lists.find((l) => l.id === chatId) ?? null;
  const setChat = (id: string | null) => {
    const n = new URLSearchParams(params);
    if (id) n.set('chat', id); else n.delete('chat');
    setParams(n, { replace: true });
  };
  if (!data) return <div className="page"><Loading /></div>;
  const widgets = data.prefs.widgets as Record<string, { hidden?: boolean }>;
  const shown = lists.filter((l) => data.lists[l.key] && !widgets[l.key]?.hidden);
  const narrow = Boolean(chatList);

  return (
    <div className={`page home ${chatList ? 'chat-open' : ''}`}>
      <header className="hello">
        <h1>{greetingWord(me.household.timezone)}, {me.user.display_name.split(' ')[0]}</h1>
        <Link to="/calendar" className="hello-date"><CalendarDays size={30} strokeWidth={1.8} /> <span>{day(data.today, { weekday: 'long', month: 'short', day: 'numeric' }).replace(',', '')}</span></Link>
      </header>

      <div className="home-split">
        <div className="home-cards">
          <h2 className="sec">Lists</h2>
          {shown.map((l) => (
            <ListCard key={l.key} list={l} data={data.lists[l.key]} onChat={() => setChat(chatList?.id === l.id ? null : l.id)} chatting={chatList?.id === l.id} narrow={narrow} />
          ))}
          <h2 className="sec">Events</h2>
          <DatesCard events={data.important_dates} plans={data.plans} today={data.today} narrow={narrow} />
          <TodosCard todos={data.todos} items={data.dated_items} today={data.today} plans={data.plans} narrow={narrow} />
          <button className="add-card" onClick={() => setNewList(true)} aria-label="Make a new list" title="New list"><span><Plus size={22} /></span></button>
        </div>
        {chatList && (
          <aside className="list-chat" style={{ ['--list' as any]: chatList.color }} aria-label={`Chat about ${chatList.label}`}>
            <header>
              <MessageCircle size={18} />
              <span className="grow clamp1">@{chatList.label.toLowerCase()}</span>
              <button className="icon-btn small" onClick={() => setChat(null)} aria-label="Close chat"><Minus size={18} /></button>
            </header>
            <Thread key={chatList.id!} type="list" id={chatList.id!} space={chatList.private ? 'me' : 'us'} autoFocus placeholder="Reply… (@ to link a card)" />
          </aside>
        )}
      </div>
      {newList && <NewListSheet onClose={() => setNewList(false)} onCreated={() => setNewList(false)} />}
    </div>
  );
}

/** A list as a card: a short preview; “+ N more” opens the whole list right here. */
function ListCard({ list, data, onChat, chatting, narrow }: {
  list: ListDef; data: { items: any[]; need: number; updated_at: string | null }; onChat: () => void; chatting: boolean; narrow: boolean;
}) {
  const me = useMe();
  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState('');
  const [locked, setLocked] = useState(false);
  const [receipt, setReceipt] = useState(false);
  const { run, busy } = useAction();
  const purchase = usePurchase();
  const p = listApi(list);
  const { data: full } = useApi<{ items: any[] }>(expanded ? p.items('state=need&sort=category&limit=200') : null);
  const { data: thread } = useApi<{ messages: any[]; last_read_at: string | null }>(list.id ? `/threads/list/${list.id}` : null);
  const items = expanded ? full?.items ?? data.items : data.items.slice(0, PREVIEW);
  const more = data.need - Math.min(PREVIEW, data.items.length);
  const lastRead = thread?.last_read_at ? new Date(thread.last_read_at).getTime() : 0;
  const unread = (thread?.messages ?? []).filter((m) => m.author_id !== me.user.id && !m.deleted_at && new Date(m.created_at).getTime() > lastRead).length;
  const add = () => title.trim() && run(async () => {
    await api.post(p.add, { ...p.addBody, title: title.trim(), private: list.private || locked });
    setTitle('');
    emitChange();
  });
  const updated = lastUpdate(data.updated_at, me.household.timezone);

  return (
    <section className={`card-x ${expanded ? 'open' : ''} ${chatting ? 'chatting' : ''}`} style={{ ['--list' as any]: list.color }}>
      <span className="bar" aria-hidden />
      <header className="card-x-head">
        <button className="card-x-title" onClick={() => setExpanded((x) => !x)} aria-expanded={expanded}>
          <span className="dot" aria-hidden>{list.module === 'grocery' ? '' : list.emoji}</span>
          <span className="clamp1">{list.label}</span>
          {list.private && <Lock size={13} className="muted" aria-label="Private" />}
        </button>
        <button className={`card-x-icon chat ${chatting ? 'on' : ''}`} onClick={onChat} aria-label={`Chat about ${list.label}`} aria-pressed={chatting}>
          <MessageCircle size={16} />{unread > 0 && <i className="unread-dot" />}
        </button>
        {!narrow && <Link to={`/lists/${list.slug}`} className="card-x-icon open" aria-label={`Open ${list.label}`}><ArrowUpRight size={15} /></Link>}
      </header>
      {items.length ? (
        <ul className="items compact">{items.map((i: any) => <ItemRow key={i.id} item={i} compact onCheck={() => purchase(i)} />)}</ul>
      ) : <p className="card-x-empty">Nothing needed.</p>}
      {expanded && (
        <form className="card-x-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <Plus size={16} className="muted" aria-hidden />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`Add to ${list.label}…`} aria-label={`New item in ${list.label}`} />
          {!list.private && (
            <button type="button" className={`icon-btn small lock-toggle ${locked ? 'on' : ''}`} onClick={() => setLocked((x) => !x)} aria-pressed={locked}
              aria-label={locked ? 'Private' : 'Shared'} title={locked ? 'Private: only you' : `Shared with ${me.partner?.display_name ?? 'your partner'}`}>
              {locked ? <Lock size={13} /> : <LockOpen size={13} />}
            </button>
          )}
          <button className="btn small primary" disabled={!title.trim() || busy}>Add</button>
        </form>
      )}
      <footer className="card-x-foot">
        <button className="more-btn" onClick={() => setExpanded((x) => !x)} aria-expanded={expanded}>
          {expanded ? <>Show less <ChevronUp size={12} /></> : more > 0 ? <>+ {more} more <ChevronDown size={12} /></> : <>Add <ChevronDown size={12} /></>}
        </button>
        {expanded && list.module === 'grocery' && <button className="more-btn" onClick={() => setReceipt(true)}><Receipt size={12} /> Scan receipt</button>}
        {expanded && narrow && <Link to={`/lists/${list.slug}`} className="more-btn">Full list <ArrowUpRight size={12} /></Link>}
        <span className="grow" />
        {updated && !narrow && <span className="updated">Last update: {updated}</span>}
      </footer>
      {receipt && <ReceiptSheet onClose={() => setReceipt(false)} />}
    </section>
  );
}

/** Important dates and plans. Tapping one opens its pop-up (details, people, checklist, lists, chat). */
function DatesCard({ events, plans, today, narrow }: { events: any[]; plans: any[]; today: string; narrow: boolean }) {
  const open = useOpen();
  const { run } = useAction();
  const [expanded, setExpanded] = useState(false);
  const daysUntil = (d: string) => Math.round((Date.parse(d) - Date.parse(today)) / 86400000);
  const ask = plans.filter((p) => p.ask_to_archive);
  const planIds = new Set(plans.map((p) => p.id));
  const rows = [
    ...plans.filter((p) => !p.over).map((p) => ({ id: p.id, title: p.title, date: p.start_date, key: `p${p.id}`, sub: p.checklist.total ? `${p.checklist.done}/${p.checklist.total} done` : 'Plan' })),
    ...events.filter((e) => !planIds.has(e.id)).map((e) => ({
      id: e.id, title: e.title, date: e.start_date, key: `e${e.id}${e.start_date}`,
      sub: `${e.category ?? 'Event'}${e.years && /birthday/i.test(e.category ?? '') ? ` · turns ${e.years}` : e.years ? ` · ${e.years} years` : ''}`,
    })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const visible = expanded ? rows : rows.slice(0, PREVIEW);
  return (
    <section className={`card-x ${expanded ? 'open' : ''}`} style={{ ['--list' as any]: 'var(--l-events)' }}>
      <span className="bar" aria-hidden />
      <header className="card-x-head">
        <button className="card-x-title" onClick={() => setExpanded((x) => !x)} aria-expanded={expanded}><span className="dot" aria-hidden /><span className="clamp1">Important Dates</span></button>
        {!narrow && <Link to="/calendar" className="card-x-icon open" aria-label="Open the calendar"><ArrowUpRight size={15} /></Link>}
      </header>
      {ask.map((p) => (
        <div key={p.id} className="over-prompt">
          <span className="grow"><b>{p.title}</b> is over. Archive it?</span>
          <button className="btn small" onClick={() => run(async () => { await api.post(`/entities/event/${p.id}/archive`); emitChange(); }, `Archived “${p.title}”`)}>Archive</button>
          <button className="link-btn" onClick={() => run(async () => { await api.post(`/plans/${p.id}/keep`); emitChange(); })}>Not yet</button>
        </div>
      ))}
      {visible.length ? (
        <ul className="date-rows">
          {visible.map((r) => {
            const n = daysUntil(r.date);
            return (
              <li key={r.key}>
                <button onClick={() => open('event', r.id)}>
                  <span className="date-badge"><small>{day(r.date, { month: 'short' })}</small><b>{Number(r.date.slice(8))}</b></span>
                  <span className="grow"><span className="clamp1 block">{r.title}</span><span className="muted tiny">{r.sub}</span></span>
                  {!narrow && <span className={`days-until ${n <= 7 ? 'soon' : ''}`}>{n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `${n} days`}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      ) : <p className="card-x-empty">No birthdays or plans coming up.</p>}
      {rows.length > PREVIEW && (
        <footer className="card-x-foot">
          <button className="more-btn" onClick={() => setExpanded((x) => !x)}>{expanded ? <>Show less <ChevronUp size={12} /></> : <>+ {rows.length - PREVIEW} more <ChevronDown size={12} /></>}</button>
        </footer>
      )}
    </section>
  );
}

function TodosCard({ todos, items, today, plans, narrow }: { todos: any[]; items: any[]; today: string; plans: any[]; narrow: boolean }) {
  const me = useMe();
  const open = useOpen();
  const purchase = usePurchase();
  const { run, busy } = useAction();
  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState('');
  const [locked, setLocked] = useState(false);
  const planName = new Map(plans.map((p) => [p.id, p.title]));
  const rows = [
    ...todos.map((t) => ({
      kind: 'task' as const, id: t.id, title: t.title, date: t.due_date, time: t.due_time, private: t.space === 'me', raw: t,
      who: t.assignee === 'both' ? 'Both' : t.assignee === 'user' ? (t.assigned_user_id === me.user.id ? 'You' : me.partner?.display_name) : null,
    })),
    ...items.map((i) => ({ kind: 'item' as const, id: i.id, title: i.title, date: i.due_date, time: i.due_time, private: i.private, raw: i, who: null })),
  ].sort((a, b) => ((a.date ?? '9999') < (b.date ?? '9999') ? -1 : (a.date ?? '9999') > (b.date ?? '9999') ? 1 : 0));
  const visible = expanded ? rows : rows.slice(0, PREVIEW);
  const add = () => title.trim() && run(async () => {
    await api.post(`/spaces/${locked ? 'me' : 'us'}/tasks`, { title: title.trim() });
    setTitle('');
    emitChange();
  });
  const done = (r: (typeof rows)[number]) => (r.kind === 'task'
    ? run(async () => { await api.patch(`/tasks/${r.id}`, { status: 'completed' }); emitChange(); }, `Done: ${r.title}`)
    : purchase(r.raw));
  return (
    <section className={`card-x ${expanded ? 'open' : ''}`} style={{ ['--list' as any]: 'var(--l-events)' }}>
      <span className="bar" aria-hidden />
      <header className="card-x-head">
        <button className="card-x-title" onClick={() => setExpanded((x) => !x)} aria-expanded={expanded}><span className="dot" aria-hidden /><span className="clamp1">To do &amp; Reminders</span></button>
        {!narrow && rows.length > 0 && <span className="card-x-count">{rows.length}</span>}
      </header>
      {visible.length ? (
        <ul className="todo-list">
          {visible.map((r) => (
            <li key={r.kind + r.id}>
              <button className="circle" onClick={() => done(r)} aria-label={`Done: ${r.title}`}><Check size={12} /></button>
              <button className="item-main" onClick={() => open(r.kind, r.id)}>
                <span className="item-title">{r.title}</span>
                <span className="item-meta">
                  {r.date && <span className={r.date < today ? 'overdue' : r.date === today ? 'today' : ''}>{dueLabel(r.date, r.time, today)}</span>}
                  {r.who && <span>{r.who}</span>}
                  {r.kind === 'task' && r.raw.related_event_id && planName.get(r.raw.related_event_id) && <span>{planName.get(r.raw.related_event_id)}</span>}
                </span>
              </button>
              {r.private && <Lock size={12} className="muted" aria-label="Private" />}
            </li>
          ))}
        </ul>
      ) : <p className="card-x-empty">Nothing to do.</p>}
      {expanded && (
        <form className="card-x-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <Plus size={16} className="muted" aria-hidden />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a to-do…" aria-label="New to-do" />
          <button type="button" className={`icon-btn small lock-toggle ${locked ? 'on' : ''}`} onClick={() => setLocked((x) => !x)} aria-pressed={locked} aria-label={locked ? 'Private' : 'Shared'}>{locked ? <Lock size={13} /> : <LockOpen size={13} />}</button>
          <button className="btn small primary" disabled={!title.trim() || busy}>Add</button>
        </form>
      )}
      <footer className="card-x-foot">
        <button className="more-btn" onClick={() => setExpanded((x) => !x)}>
          {expanded ? <>Show less <ChevronUp size={12} /></> : rows.length > PREVIEW ? <>+ {rows.length - PREVIEW} more <ChevronDown size={12} /></> : <>Add <ChevronDown size={12} /></>}
        </button>
      </footer>
    </section>
  );
}
