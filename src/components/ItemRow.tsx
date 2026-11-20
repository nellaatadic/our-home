import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Hash, Lock, MessageSquare, MessageSquarePlus, MoreHorizontal, Receipt, Repeat, Undo2, X } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { nameOf, useMe } from '../lib/session';
import { day, dueLabel, qty, todayLocal } from '../lib/format';
import { useLists } from '../lib/useLists';
import { prepareUpload } from '../lib/image';
import { useOpen } from './Layout';
import { Thread } from './Thread';
import { Field, Loading, Sheet, useAction, useToast } from './ui';

/** Mark bought (NEED → STOCK), merging into a same-named STOCK entry. */
export function usePurchase() {
  const toast = useToast();
  const { run } = useAction();
  return (item: any, stockTitles?: Map<string, string>, quantity?: number | null) => run(async () => {
    const merge = stockTitles?.get(item.title.trim().toLowerCase());
    const r = await api.post(`/items/${item.id}/purchase`, { quantity: quantity === undefined ? item.quantity : quantity, merge_into_id: merge && merge !== item.id ? merge : undefined });
    emitChange();
    toast(r.repeated ? `${item.title}: bought. Next one is on the list.` : r.merged ? `Added to “${item.title}” in stock` : `${item.title} → in stock`);
  });
}

/** The few things worth knowing about an item, in one line under its chat title. */
export function ItemSummary({ item }: { item: any }) {
  const me = useMe();
  const { lists } = useLists();
  const { data } = useApi<{ item: any }>(`/items/${item.id}`);
  const it = data?.item ?? item;
  const today = todayLocal(me.household.timezone);
  const list = it.module === 'custom' ? lists.find((l) => l.id === it.list_id) : lists.find((l) => l.module === it.module);
  const bits = [
    list && <span key="l">@{list.label}</span>,
    it.due_date && <span key="d">{dueLabel(it.due_date, it.due_time, today)}</span>,
    it.urgent && <span key="u" className="overdue">Urgent</span>,
    it.quantity != null && <span key="q">{qty(it.quantity, it.unit)}</span>,
    ...(it.tags ?? []).map((t: string) => <span key={`t${t}`}>#{t}</span>),
  ].filter(Boolean);
  return (
    <div className="item-summary">
      {it.images?.[0] && <img src={it.images[0].url} alt="" />}
      <div className="grow">
        {bits.length > 0 && <div className="item-summary-meta">{bits}</div>}
        {it.notes && <p className="clamp2">{it.notes}</p>}
      </div>
    </div>
  );
}

/** A small chat window about one item: comment, reply, add photos or links on the spot. */
export function QuickChat({ item, onClose }: { item: any; onClose: () => void }) {
  const open = useOpen();
  return (
    <Sheet title={<button className="link-title" onClick={() => { onClose(); open('item', item.id); }}>#{item.title}</button>} onClose={onClose} compact>
      <ItemSummary item={item} />
      <Thread type="item" id={item.id} space={item.private ? 'me' : 'us'} compact autoFocus placeholder="Message… @ a card, # an item" />
    </Sheet>
  );
}

/**
 * Not for home? Move an item to an event's own list (making one if needed),
 * or say who it is for.
 */
export function SubListSheet({ item, onClose }: { item: any; onClose: () => void }) {
  const me = useMe();
  const toast = useToast();
  const { run, busy } = useAction();
  const { data } = useApi<{ events: { id: string; title: string; date: string; is_plan: boolean; space: 'me' | 'us'; lists: { id: string; name: string; space: 'me' | 'us' }[] }[] }>('/sublists');
  const moveTo = (listId: string, label: string) => run(async () => {
    await api.patch(`/items/${item.id}`, { module: 'custom', list_id: listId });
    emitChange();
    toast(`Moved to ${label}`);
    onClose();
  });
  const forEvent = (e: { id: string; title: string; lists: { id: string; name: string }[] }) => run(async () => {
    let listId = e.lists[0]?.id;
    if (!listId) {
      const r = await api.post('/lists', { name: `For ${e.title}`.slice(0, 80), event_id: e.id, private: item.private });
      listId = r.list.id;
    }
    await api.patch(`/items/${item.id}`, { module: 'custom', list_id: listId });
    emitChange();
    toast(`${item.title} → ${e.title}`);
    onClose();
  });
  const forPerson = (id: string | null) => run(async () => {
    await api.patch(`/items/${item.id}`, { intended_for_user_id: id });
    emitChange();
    onClose();
  }, id ? `For ${nameOf(me, id)}` : 'For both of you');
  const events = data?.events ?? [];
  return (
    <Sheet title={<span>#{item.title}: not for home?</span>} onClose={onClose} compact>
      <p className="muted small">Put it on an event’s own list, or say who it is for.</p>
      <h3 className="mini-title">For an event</h3>
      {!data ? <Loading /> : !events.length ? <p className="muted small">No upcoming events. Add one from the calendar.</p> : (
        <ul className="pick-list">
          {events.map((e) => (
            <li key={e.id}>
              {e.lists.length > 1 ? (
                <details>
                  <summary><b>{e.title}</b> <span className="muted tiny">{day(e.date, { month: 'short', day: 'numeric' })}</span></summary>
                  {e.lists.map((l) => <button key={l.id} disabled={busy} onClick={() => moveTo(l.id, l.name)}>{l.name}</button>)}
                </details>
              ) : (
                <button disabled={busy} onClick={() => forEvent(e)}>
                  <b className="grow clamp1">{e.title}</b>
                  <span className="muted tiny">{e.lists[0]?.name ?? 'new list'} · {day(e.date, { month: 'short', day: 'numeric' })}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!item.private && me.partner && (
        <>
          <h3 className="mini-title">For someone</h3>
          <div className="chips">
            {me.members.map((m) => (
              <button key={m.id} className={`chip ${item.intended_for_user_id === m.id ? 'on' : ''}`} disabled={busy} onClick={() => forPerson(item.intended_for_user_id === m.id ? null : m.id)}>
                {m.id === me.user.id ? 'Me' : m.display_name}
              </button>
            ))}
          </div>
        </>
      )}
    </Sheet>
  );
}

/**
 * One item. Swipe right for Details and Urgent, swipe left for “# Sub list”
 * and Remove; hold to show both sides. Tap the name to fix a typo. Grocery
 * items have no chat of their own: the whole Groceries list has one instead.
 */
export function ItemRow({ item, onCheck, compact, showList, duplicate, completed, highlight }: {
  item: any; onCheck: () => void; compact?: boolean; showList?: string; duplicate?: boolean; completed?: boolean; highlight?: boolean;
}) {
  const me = useMe();
  const open = useOpen();
  const toast = useToast();
  const { run } = useAction();
  const [chat, setChat] = useState(false);
  const [sub, setSub] = useState(false);
  const [dx, setDx] = useState(0);
  const [openSide, setOpenSide] = useState<'left' | 'right' | 'both' | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);
  const drag = useRef<{ x: number; y: number; base: number; moved: boolean; locked?: 'h' | 'v'; timer?: number; held?: boolean } | null>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const today = todayLocal(me.household.timezone);
  const need = item.grocery_state === 'need' && !completed;
  const overdue = item.due_date && item.due_date < today && need;
  const canChat = item.module !== 'grocery';
  const ACTIONS = 128;
  useEffect(() => setTitle(item.title), [item.title]);
  useEffect(() => { if (highlight) rowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [highlight]);
  const meta = [
    item.due_date && <span key="d" className={overdue ? 'overdue' : item.due_date === today ? 'today' : ''}>{dueLabel(item.due_date, item.due_time, today)}</span>,
    item.repeat_unit && <Repeat key="r" size={11} aria-label="Repeats" />,
    item.subtasks?.total > 0 && <span key="s">{item.subtasks.done}/{item.subtasks.total}</span>,
    item.intended_for_user_id && <span key="f">for {item.intended_for_user_id === me.user.id ? 'me' : nameOf(me, item.intended_for_user_id)}</span>,
    !compact && item.quantity != null && <span key="q">{qty(item.quantity, item.unit)}</span>,
    !compact && item.notes && <span key="n" className="clamp1 note-preview">{item.notes}</span>,
    showList && <span key="l">{showList}</span>,
  ].filter(Boolean);

  // Close the actions when tapping anywhere else.
  useEffect(() => {
    if (!openSide) return;
    const onDown = (e: PointerEvent) => { if (!rowRef.current?.contains(e.target as Node)) { setOpenSide(null); setDx(0); } };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [openSide]);

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || completed || editing || (e.target as HTMLElement).closest('.swipe-actions, input')) return;
    const d = { x: e.clientX, y: e.clientY, base: openSide === 'both' ? 0 : dx, moved: false } as NonNullable<typeof drag.current>;
    // Hold still for half a second to show both sides.
    d.timer = window.setTimeout(() => {
      if (drag.current === d && !d.moved) {
        d.held = true;
        setDx(0);
        setOpenSide((s) => (s === 'both' ? null : 'both'));
        navigator.vibrate?.(10);
      }
    }, 480);
    drag.current = d;
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.held) return;
    const mx = e.clientX - d.x;
    const my = e.clientY - d.y;
    if (!d.locked && (Math.abs(mx) > 8 || Math.abs(my) > 8)) {
      clearTimeout(d.timer);
      d.locked = Math.abs(mx) > Math.abs(my) ? 'h' : 'v';
      if (d.locked === 'h') (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    if (d.locked !== 'h') return;
    d.moved = true;
    if (openSide === 'both') setOpenSide(null);
    setDx(Math.max(-ACTIONS - 24, Math.min(ACTIONS + 24, d.base + mx)));
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    clearTimeout(d.timer);
    if (!d.moved) return;
    if (dx > ACTIONS / 2) { setDx(ACTIONS); setOpenSide('left'); }
    else if (dx < -ACTIONS / 2) { setDx(-ACTIONS); setOpenSide('right'); }
    else { setDx(0); setOpenSide(null); }
  };
  const held = useRef(false);
  // A swipe or a hold should not also count as a tap on the row.
  const guard = (fn: () => void) => () => {
    if (held.current) { held.current = false; return; }
    if (openSide || Math.abs(dx) > 4) { setDx(0); setOpenSide(null); return; }
    fn();
  };
  const shut = () => { setDx(0); setOpenSide(null); };
  const patch = (body: any, msg: string) => run(async () => { await api.patch(`/items/${item.id}`, body); shut(); emitChange(); }, msg);
  const remove = () => run(async () => {
    await api.post(`/entities/item/${item.id}/archive`);
    shut();
    emitChange();
    toast(`Removed “${item.title}”`, { label: 'Undo', run: async () => { await api.post(`/entities/item/${item.id}/unarchive`); emitChange(); } });
  });
  const saveTitle = () => {
    setEditing(false);
    const t = title.trim();
    if (!t || t === item.title) { setTitle(item.title); return; }
    run(async () => { await api.patch(`/items/${item.id}`, { title: t }); emitChange(); });
  };
  const uncomplete = () => run(async () => { await api.post(`/items/${item.id}/uncomplete`); emitChange(); }, `${item.title} is back on the list`);
  const leftOn = openSide === 'left' || openSide === 'both';
  const rightOn = openSide === 'right' || openSide === 'both';

  return (
    <li ref={rowRef} className={`item-row swipeable ${need ? '' : 'stocked'} ${completed ? 'completed' : ''} ${item.urgent ? 'urgent' : ''} ${openSide ? 'swiped' : ''} ${openSide === 'both' ? 'show-both' : dx > 0 ? 'show-left' : dx < 0 ? 'show-right' : ''} ${highlight ? 'highlight' : ''}`}
      onPointerUpCapture={() => { if (drag.current?.held) held.current = true; }}>
      {!completed && <>
        <div className="swipe-actions left" aria-hidden={!leftOn}>
          <button className="sa details" onClick={() => { shut(); open('item', item.id); }} aria-label="Details" tabIndex={leftOn ? 0 : -1}>
            <MoreHorizontal size={17} /><small>Details</small>
          </button>
          <button className="sa urgent" onClick={() => patch({ urgent: !item.urgent }, item.urgent ? 'Not urgent any more' : 'Marked urgent')} aria-label={item.urgent ? 'Not urgent' : 'Urgent'} tabIndex={leftOn ? 0 : -1}>
            <b>!</b><small>{item.urgent ? 'Not urgent' : 'Urgent'}</small>
          </button>
        </div>
        <div className="swipe-actions right" aria-hidden={!rightOn}>
          <button className="sa sublist" onClick={() => { shut(); setSub(true); }} aria-label="Add to a sub list" tabIndex={rightOn ? 0 : -1}>
            <Hash size={17} /><small>Sub list</small>
          </button>
          <button className="sa remove" onClick={remove} aria-label="Remove" tabIndex={rightOn ? 0 : -1}>
            <X size={17} /><small>Remove</small>
          </button>
        </div>
      </>}
      <div className="swipe-track" style={{ transform: openSide === 'both' ? undefined : `translateX(${dx}px)`, transition: drag.current?.moved ? 'none' : undefined }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onContextMenu={(e) => { if (e.nativeEvent instanceof PointerEvent && e.nativeEvent.pointerType !== 'mouse') e.preventDefault(); }}>
        {completed ? (
          <button className="circle on" onClick={uncomplete} aria-label={`Undo: put ${item.title} back on the list`} title="Tap to undo"><Check size={12} /></button>
        ) : (
          <button className={`circle ${need ? '' : 'on'}`} onClick={guard(onCheck)} aria-label={need ? `Mark ${item.title} as done` : `Back on the list: ${item.title}`} title={need ? 'Done' : 'Back on the list'}>
            {need ? <Check size={12} /> : <Undo2 size={12} />}
          </button>
        )}
        <div className="item-main">
          {editing ? (
            <input className="item-title-edit" autoFocus value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setTitle(item.title); setEditing(false); } }} aria-label="Name" />
          ) : (
            <button type="button" className="item-title" onClick={completed ? uncomplete : guard(() => setEditing(true))} title={completed ? 'Tap to undo' : 'Tap to edit · hold for more'}>
              {item.urgent && !completed && <span className="urgent-mark" aria-label="Urgent">!</span>}
              {title}
            </button>
          )}
          {meta.length > 0 && !completed && <span className="item-meta">{meta}</span>}
        </div>
        <span className="item-side">
          {duplicate && !completed && (
            <button className="dupe-btn" onClick={guard(() => open('item', item.id))} aria-label={`${item.title} is on the list more than once: is this one for an event or someone? Open details`} title="Also on the list. For an event or someone?">
              <MoreHorizontal size={15} />
            </button>
          )}
          {item.private && <Lock size={13} className="muted" aria-label="Private" />}
          {canChat && !completed && (
            <button className={`comment-btn ${item.thread?.unread ? 'unread' : ''}`} onClick={guard(() => setChat(true))} aria-label={`Chat about ${item.title}${item.thread?.total ? ` (${item.thread.total} messages)` : ''}`} title="Chat">
              {item.thread?.total ? <><MessageSquare size={15} /><small>{item.thread.total}</small></> : <MessageSquarePlus size={15} />}
            </button>
          )}
        </span>
      </div>
      {chat && <QuickChat item={item} onClose={() => { setChat(false); emitChange(); }} />}
      {sub && <SubListSheet item={item} onClose={() => setSub(false)} />}
    </li>
  );
}

export function BuySheet({ item, onClose, onConfirm, onDone }: { item: any; onClose: () => void; onConfirm: (q: number | null) => void; onDone: () => void }) {
  const [q, setQ] = useState<string>(String(item.quantity ?? 1));
  return (
    <Sheet title={`Bought ${item.title}`} onClose={onClose} compact footer={<>
      <button className="btn ghost" onClick={onDone} title="Archive the item without keeping it in stock">Done, don’t keep in stock</button>
      <button className="btn primary" onClick={() => onConfirm(q === '' ? null : Number(q))}>Move to stock</button></>}>
      <Field label="How many did you buy?"><input type="number" min={0} step="any" value={q} onChange={(e) => setQ(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && onConfirm(q === '' ? null : Number(q))} /></Field>
      <p className="muted small">Turn on automatic moving in Settings to skip this step.</p>
    </Sheet>
  );
}

/** Photo, PDF or pasted text → receipt review. Nothing changes until confirmed. */
export function ReceiptSheet({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const { run, busy } = useAction();
  const [text, setText] = useState('');
  const upload = (file?: File, t?: string) => run(async () => {
    if (!file && !t?.trim()) return;
    const fd = new FormData();
    if (file) fd.set('file', await prepareUpload(file));
    if (t) fd.set('text', t);
    const r = await api.post('/spaces/us/receipts', fd);
    nav(`/receipts/${r.receipt.id}`);
  });
  return (
    <Sheet title="Scan a receipt" onClose={onClose} compact>
      <p className="muted small">You’ll review every line first. Matching items on your list are ticked off and bought items go to stock.</p>
      <label className="btn primary block big"><Receipt size={18} /> Take a photo or choose a file
        <input type="file" accept="image/*,application/pdf" capture="environment" hidden disabled={busy} onChange={(e) => upload(e.target.files?.[0])} />
      </label>
      <Field label="…or paste the receipt text"><textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={'MILK 1L        1.29\n2 x BREAD      5.00'} /></Field>
      <div className="row end"><button className="btn" disabled={!text.trim() || busy} onClick={() => upload(undefined, text)}>Read text</button></div>
    </Sheet>
  );
}
