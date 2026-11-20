import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CalendarDays, Check, ChevronDown, ChevronRight, ChevronUp, Lock, LockOpen, MessageCircle, Minus, Palette, Plus, Receipt } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { day, dueLabel } from '../lib/format';
import { CARD_COLORS, LIST_EMOJI, listApi, type ListDef } from '../lib/lists';
import { useLists } from '../lib/useLists';
import { useNick } from '../lib/nick';
import { useOpen } from '../components/Layout';
import { ItemRow, ReceiptSheet, usePurchase } from '../components/ItemRow';
import { NewListSheet } from '../components/ListSheets';
import { Thread } from '../components/Thread';
import { Loading, useAction } from '../components/ui';

const PREVIEW = 2;

/** Good morning / afternoon / evening by the clock of the phone in your hand. */
function greetingWord(now = new Date()) {
  const h = now.getHours();
  return h < 5 ? 'Good Night' : h < 12 ? 'Good Morning' : h < 17 ? 'Good Afternoon' : 'Good Evening';
}

function lastUpdate(ts: string | null) {
  if (!ts) return null;
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Mark the second (third…) “Milk”: probably meant for an event or someone, not the fridge. */
function duplicateIds(items: any[]) {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const i of items) {
    const k = i.title.trim().toLowerCase();
    if (seen.has(k)) dupes.add(i.id); else seen.add(k);
  }
  return dupes;
}

type ChatCard = { kind: 'list'; list: ListDef } | { kind: 'dates' | 'todos'; topicId: string; label: string; color: string };

/**
 * Home: a greeting, then every list and the events as simple cards. Cards
 * open in place, and each has its own chat that slides in beside the cards.
 */
export function DashboardPage() {
  const me = useMe();
  const { data } = useApi<any>('/dashboard');
  const { lists } = useLists();
  const [params, setParams] = useSearchParams();
  const [newList, setNewList] = useState(false);
  const [, tick] = useState(0);
  const chatKey = params.get('chat');
  const focus = params.get('focus');
  const focusItem = params.get('item');

  // The greeting follows the clock.
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 60_000); return () => clearInterval(t); }, []);
  // Coming from the activity: show the card (and the item) for a moment, then let go.
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => { const n = new URLSearchParams(params); n.delete('focus'); n.delete('item'); setParams(n, { replace: true }); }, 4000);
    return () => clearTimeout(t);
  }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps

  const chatList = lists.find((l) => l.id === chatKey) ?? null;
  const cards = data?.cards ?? {};
  const chat: ChatCard | null = chatList ? { kind: 'list', list: chatList }
    : chatKey === 'dates' && cards.dates ? { kind: 'dates', topicId: cards.dates.topic_id, label: 'Important Dates', color: cards.dates.color ?? 'var(--l-events)' }
    : chatKey === 'todos' && cards.todos ? { kind: 'todos', topicId: cards.todos.topic_id, label: 'To do & Reminders', color: cards.todos.color ?? 'var(--l-events)' }
    : null;
  const setChat = (key: string | null) => {
    const n = new URLSearchParams(params);
    if (key && key !== chatKey) n.set('chat', key); else n.delete('chat');
    setParams(n, { replace: true });
  };
  // With a chat open, the greeting, the headings and the bottom bar make room.
  const chatOpen = Boolean(chat);
  useEffect(() => {
    document.body.classList.toggle('home-chat', chatOpen);
    return () => document.body.classList.remove('home-chat');
  }, [chatOpen]);

  if (!data) return <div className="page"><Loading /></div>;
  const widgets = data.prefs.widgets as Record<string, { hidden?: boolean }>;
  const shown = lists.filter((l) => data.lists[l.key] && !widgets[l.key]?.hidden);
  const narrow = chatOpen;

  return (
    <div className={`page home ${chatOpen ? 'chat-open' : ''}`}>
      {!chatOpen && (
        <header className="hello">
          <h1>{greetingWord()}, {me.user.display_name.split(' ')[0]}</h1>
          <Link to="/calendar" className="date-btn" aria-label="Open the calendar">
            <span className="date-btn-icon" aria-hidden><CalendarDays size={18} /></span>
            <span>{day(data.today, { weekday: 'long', month: 'short', day: 'numeric' }).replace(',', '')}</span>
            <ChevronRight size={16} aria-hidden />
          </Link>
        </header>
      )}

      <div className="home-split">
        <div className="home-cards">
          {!chatOpen && <h2 className="sec">Lists</h2>}
          {shown.map((l) => (
            <ListCard key={l.key} list={l} data={data.lists[l.key]} onChat={() => setChat(l.id)} chatting={chatList?.id === l.id} narrow={narrow}
              focused={focus === l.key} focusItem={focus === l.key ? focusItem : null} />
          ))}
          {!chatOpen && <h2 className="sec">Events</h2>}
          <DatesCard events={data.important_dates} plans={data.plans} today={data.today} narrow={narrow} style={cards.dates}
            onChat={() => setChat('dates')} chatting={chatKey === 'dates'} focused={focus === 'dates'} />
          <TodosCard todos={data.todos} items={data.dated_items} today={data.today} plans={data.plans} narrow={narrow} style={cards.todos}
            onChat={() => setChat('todos')} chatting={chatKey === 'todos'} focused={focus === 'todos'} focusItem={focus === 'todos' ? focusItem : null} />
          {!chatOpen && <button className="add-card" onClick={() => setNewList(true)} aria-label="Make a new list" title="New list"><span><Plus size={22} /></span></button>}
        </div>
        {chat && (
          <aside className="list-chat" style={{ ['--list' as any]: chat.kind === 'list' ? chat.list.color : chat.color }} aria-label={`Chat about ${chat.kind === 'list' ? chat.list.label : chat.label}`}>
            <header>
              <span className="grow clamp1">@{(chat.kind === 'list' ? chat.list.label : chat.label).toLowerCase()}</span>
              <button className="icon-btn small" onClick={() => setChat(null)} aria-label="Close chat"><Minus size={18} /></button>
            </header>
            {chat.kind === 'list'
              ? <Thread key={chat.list.id!} type="list" id={chat.list.id!} space={chat.list.private ? 'me' : 'us'} autoFocus />
              : <Thread key={chat.topicId} type="topic" id={chat.topicId} space="us" autoFocus />}
          </aside>
        )}
      </div>
      {newList && <NewListSheet onClose={() => setNewList(false)} onCreated={() => setNewList(false)} />}
    </div>
  );
}

/** Tapping the empty part of a card opens or closes it; buttons, rows and fields keep their own taps. */
function useCardTap(toggle: () => void) {
  return (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('button, a, input, select, textarea, form, label, .item-row, .todo-list li, .date-rows li, .style-pop, .over-prompt, .sheet, .overlay')) return;
    toggle();
  };
}

/** The card's name and emoji: the way into its own page (when it has one). */
function CardName({ emoji, label, to, onClick, extra }: { emoji: string; label: string; to?: string; onClick?: () => void; extra?: ReactNode }) {
  const inner = <><span className="dot" aria-hidden>{emoji}</span><span className="clamp1">{label}</span>{extra}</>;
  return to
    ? <Link to={to} className="card-x-title" title={`Open ${label}`}>{inner}</Link>
    : <button type="button" className="card-x-title" onClick={onClick}>{inner}</button>;
}

function ChatButton({ label, on, unread, onClick }: { label: string; on: boolean; unread: boolean; onClick: () => void }) {
  return (
    <button className={`card-x-icon chat ${on ? 'on' : ''}`} onClick={onClick} aria-label={`Chat about ${label}`} aria-pressed={on}>
      <MessageCircle size={17} />{unread && <i className="unread-dot" />}
    </button>
  );
}

/** Emoji and colour for a card. */
function StylePicker({ emoji, color, onPick, onClose }: { emoji: string; color: string; onPick: (p: { emoji?: string; color?: string }) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('.style-toggle')) onClose(); };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [onClose]);
  return (
    <div className="style-pop" ref={ref} role="dialog" aria-label="Emoji and colour">
      <div className="style-emoji">{LIST_EMOJI.map((e) => <button key={e} className={e === emoji ? 'on' : ''} onClick={() => onPick({ emoji: e })} aria-label={e}>{e}</button>)}</div>
      <div className="style-colors">{CARD_COLORS.map((c) => <button key={c} className={c === color ? 'on' : ''} style={{ background: c }} onClick={() => onPick({ color: c })} aria-label={`Colour ${c}`} />)}</div>
    </div>
  );
}

function CardFoot({ updated, children, onStyle }: { updated?: string | null; children: ReactNode; onStyle?: () => void }) {
  return (
    <footer className="card-x-foot">
      {updated ? <span className="updated">Last update: {updated}</span> : null}
      <span className="grow" />
      {onStyle && <button className="more-btn style-toggle" onClick={onStyle} aria-label="Emoji and colour" title="Emoji and colour"><Palette size={13} /></button>}
      {children}
    </footer>
  );
}

/** A list as a card: a short preview; “+ N more” (or a tap on the card) opens the whole list right here. */
function ListCard({ list, data, onChat, chatting, narrow, focused, focusItem }: {
  list: ListDef; data: { items: any[]; need: number; updated_at: string | null; completed?: any[] }; onChat: () => void; chatting: boolean; narrow: boolean;
  focused: boolean; focusItem: string | null;
}) {
  const me = useMe();
  const { reload: reloadLists } = useLists();
  const [expanded, setExpanded] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [styling, setStyling] = useState(false);
  const [title, setTitle] = useState('');
  const [locked, setLocked] = useState(false);
  const [receipt, setReceipt] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const { run, busy } = useAction();
  const purchase = usePurchase();
  const p = listApi(list);
  const { data: full } = useApi<{ items: any[] }>(expanded ? p.items('state=need&sort=category&limit=200') : null);
  const { data: thread } = useApi<{ messages: any[]; last_read_at: string | null }>(list.id ? `/threads/list/${list.id}` : null);
  useEffect(() => {
    if (!focused) return;
    if (focusItem || data.need > PREVIEW) setExpanded(true);
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focused, focusItem]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = expanded ? full?.items ?? data.items : data.items;
  const items = expanded ? all : all.slice(0, PREVIEW);
  const dupes = duplicateIds(all);
  const completed = data.completed ?? [];
  const more = data.need - Math.min(PREVIEW, data.items.length);
  const lastRead = thread?.last_read_at ? new Date(thread.last_read_at).getTime() : 0;
  const unread = (thread?.messages ?? []).some((m) => m.author_id !== me.user.id && !m.deleted_at && new Date(m.created_at).getTime() > lastRead);
  const add = () => title.trim() && run(async () => {
    await api.post(p.add, { ...p.addBody, title: title.trim(), private: list.private || locked });
    setTitle('');
    emitChange();
  });
  const restyle = (s: { emoji?: string; color?: string }) => run(async () => { await api.patch(`/lists/${list.id}`, s); reloadLists(); emitChange(); });
  const tap = useCardTap(() => setExpanded((x) => !x));

  return (
    <section ref={ref} className={`card-x ${expanded ? 'open' : ''} ${chatting ? 'chatting' : ''} ${focused ? 'focused' : ''}`} style={{ ['--list' as any]: list.color }} onClick={tap}>
      <span className="bar" aria-hidden />
      <header className="card-x-head">
        <CardName emoji={list.emoji} label={list.label} to={`/lists/${list.slug}`} extra={list.private ? <Lock size={13} className="muted" aria-label="Private" /> : null} />
        <ChatButton label={list.label} on={chatting} unread={unread} onClick={onChat} />
      </header>
      {items.length ? (
        <ul className="items compact">{items.map((i: any) => <ItemRow key={i.id} item={i} compact duplicate={dupes.has(i.id)} highlight={focusItem === i.id} onCheck={() => purchase(i)} />)}</ul>
      ) : <p className="card-x-empty">Nothing needed.</p>}
      {showDone && completed.length > 0 && (
        <ul className="items compact done-list" aria-label="Recently completed">{completed.map((i: any) => <ItemRow key={i.id} item={i} compact completed onCheck={() => {}} />)}</ul>
      )}
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
      {expanded && list.module === 'grocery' && <button className="more-btn scan" onClick={() => setReceipt(true)}><Receipt size={12} /> Scan receipt</button>}
      <CardFoot updated={narrow ? null : lastUpdate(data.updated_at)} onStyle={expanded && list.id ? () => setStyling((x) => !x) : undefined}>
        {completed.length > 0 && (
          <button className={`more-btn ${showDone ? 'on' : ''}`} onClick={() => setShowDone((x) => !x)} aria-pressed={showDone}>
            <Check size={11} /> Completed{showDone ? '' : ` (${completed.length})`}
          </button>
        )}
        <button className="more-btn" onClick={() => setExpanded((x) => !x)} aria-expanded={expanded}>
          {expanded ? <>Show less <ChevronUp size={12} /></> : more > 0 ? <>+ {more} more <ChevronDown size={12} /></> : <>Add <ChevronDown size={12} /></>}
        </button>
      </CardFoot>
      {styling && <StylePicker emoji={list.emoji} color={list.color} onPick={restyle} onClose={() => setStyling(false)} />}
      {receipt && <ReceiptSheet onClose={() => setReceipt(false)} />}
    </section>
  );
}

interface CardStyle { topic_id: string; emoji: string | null; color: string | null; unread: number }

function useCardStyle(key: 'dates' | 'todos', style: CardStyle | undefined, fallbackEmoji: string) {
  const { run } = useAction();
  return {
    emoji: style?.emoji ?? fallbackEmoji,
    color: style?.color ?? 'var(--l-events)',
    restyle: (s: { emoji?: string; color?: string }) => run(async () => { await api.patch(`/home/cards/${key}`, s); emitChange(); }),
  };
}

/** Important dates and plans. Tapping one opens its pop-up (details, people, checklist, lists, chat). */
function DatesCard({ events, plans, today, narrow, style, onChat, chatting, focused }: {
  events: any[]; plans: any[]; today: string; narrow: boolean; style?: CardStyle; onChat: () => void; chatting: boolean; focused: boolean;
}) {
  const open = useOpen();
  const { run, busy } = useAction();
  const [expanded, setExpanded] = useState(false);
  const [styling, setStyling] = useState(false);
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(today);
  const [kind, setKind] = useState('Birthday');
  const ref = useRef<HTMLElement>(null);
  const s = useCardStyle('dates', style, '🎂');
  useEffect(() => { if (focused) { setExpanded(true); ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, [focused]);
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
  const add = () => title.trim() && run(async () => {
    await api.post('/spaces/us/events', { title: title.trim(), date, all_day: true, category: kind, yearly: kind === 'Birthday' || kind === 'Anniversary' });
    setTitle('');
    emitChange();
  }, `Added “${title.trim()}”`);
  const tap = useCardTap(() => setExpanded((x) => !x));
  return (
    <section ref={ref} className={`card-x ${expanded ? 'open' : ''} ${chatting ? 'chatting' : ''} ${focused ? 'focused' : ''}`} style={{ ['--list' as any]: s.color }} onClick={tap}>
      <span className="bar" aria-hidden />
      <header className="card-x-head">
        <CardName emoji={s.emoji} label="Important Dates" to="/calendar" />
        <ChatButton label="Important Dates" on={chatting} unread={Boolean(style?.unread)} onClick={onChat} />
      </header>
      {!narrow && ask.map((p) => (
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
      {expanded && (
        <form className="card-x-add wrap" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <Plus size={16} className="muted" aria-hidden />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a date… (Mum’s birthday)" aria-label="New important date" />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
          <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
            {['Birthday', 'Anniversary', 'Social', 'Holiday', 'Important'].map((k) => <option key={k}>{k}</option>)}
          </select>
          <button className="btn small primary" disabled={!title.trim() || busy}>Add</button>
        </form>
      )}
      <CardFoot onStyle={expanded ? () => setStyling((x) => !x) : undefined}>
        <button className="more-btn" onClick={() => setExpanded((x) => !x)}>
          {expanded ? <>Show less <ChevronUp size={12} /></> : rows.length > PREVIEW ? <>+ {rows.length - PREVIEW} more <ChevronDown size={12} /></> : <>Add <ChevronDown size={12} /></>}
        </button>
      </CardFoot>
      {styling && <StylePicker emoji={s.emoji} color={s.color} onPick={s.restyle} onClose={() => setStyling(false)} />}
    </section>
  );
}

function TodosCard({ todos, items, today, plans, narrow, style, onChat, chatting, focused, focusItem }: {
  todos: any[]; items: any[]; today: string; plans: any[]; narrow: boolean; style?: CardStyle; onChat: () => void; chatting: boolean; focused: boolean; focusItem: string | null;
}) {
  const me = useMe();
  const { name } = useNick();
  const open = useOpen();
  const nav = useNavigate();
  const purchase = usePurchase();
  const { run, busy } = useAction();
  const [expanded, setExpanded] = useState(false);
  const [styling, setStyling] = useState(false);
  const [title, setTitle] = useState('');
  const [locked, setLocked] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const s = useCardStyle('todos', style, '✅');
  useEffect(() => { if (focused) { setExpanded(true); ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, [focused]);
  const planName = new Map(plans.map((p) => [p.id, p.title]));
  const rows = [
    ...todos.map((t) => ({
      kind: 'task' as const, id: t.id, title: t.title, date: t.due_date, time: t.due_time, private: t.space === 'me', raw: t,
      who: t.assignee === 'both' ? 'Both' : t.assignee === 'user' ? (t.assigned_user_id === me.user.id ? 'You' : name(t.assigned_user_id)) : null,
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
  const tap = useCardTap(() => setExpanded((x) => !x));
  return (
    <section ref={ref} className={`card-x ${expanded ? 'open' : ''} ${chatting ? 'chatting' : ''} ${focused ? 'focused' : ''}`} style={{ ['--list' as any]: s.color }} onClick={tap}>
      <span className="bar" aria-hidden />
      <header className="card-x-head">
        <CardName emoji={s.emoji} label="To do & Reminders" onClick={() => setExpanded((x) => !x)} />
        <ChatButton label="To do & Reminders" on={chatting} unread={Boolean(style?.unread)} onClick={onChat} />
      </header>
      {visible.length ? (
        <ul className="todo-list">
          {visible.map((r) => (
            <li key={r.kind + r.id} className={focusItem === r.id ? 'highlight' : ''}>
              <button className="circle" onClick={() => done(r)} aria-label={`Done: ${r.title}`}><Check size={12} /></button>
              <button className="item-main" onClick={() => (r.kind === 'task' && r.raw.related_event_id ? nav(`/calendar?open=event:${r.raw.related_event_id}`) : open(r.kind, r.id))}>
                <span className="item-title">{r.title}</span>
                <span className="item-meta">
                  {r.date && <span className={r.date < today ? 'overdue' : r.date === today ? 'today' : ''}>{dueLabel(r.date, r.time, today)}</span>}
                  {r.who && !narrow && <span>{r.who}</span>}
                  {r.kind === 'task' && r.raw.related_event_id && planName.get(r.raw.related_event_id) && <span>@{planName.get(r.raw.related_event_id)}</span>}
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
      <CardFoot onStyle={expanded ? () => setStyling((x) => !x) : undefined}>
        <button className="more-btn" onClick={() => setExpanded((x) => !x)}>
          {expanded ? <>Show less <ChevronUp size={12} /></> : rows.length > PREVIEW ? <>+ {rows.length - PREVIEW} more <ChevronDown size={12} /></> : <>Add <ChevronDown size={12} /></>}
        </button>
      </CardFoot>
      {styling && <StylePicker emoji={s.emoji} color={s.color} onPick={s.restyle} onClose={() => setStyling(false)} />}
    </section>
  );
}
