import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Flag, Lock, MessageSquare, MessageSquarePlus, MoreHorizontal, Receipt, Repeat, Undo2, X } from 'lucide-react';
import { api, emitChange } from '../lib/api';
import { useMe } from '../lib/session';
import { dueLabel, qty, todayLocal } from '../lib/format';
import { prepareUpload } from '../lib/image';
import { useOpen } from './Layout';
import { Thread } from './Thread';
import { Field, Sheet, useAction, useToast } from './ui';

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

/** A small chat window about one item: comment, reply, add photos or links on the spot. */
export function QuickChat({ item, onClose }: { item: any; onClose: () => void }) {
  const open = useOpen();
  return (
    <Sheet title={<span className="row gap-s"><MessageSquare size={18} /> {item.title}</span>} onClose={onClose} compact>
      <Thread type="item" id={item.id} space={item.private ? 'me' : 'us'} compact autoFocus placeholder="Write a comment… type @ to link a card" />
      <div className="row between">
        <span className="muted tiny">Saved as a card on the Chat page.</span>
        <button className="link-btn" onClick={() => { onClose(); open('item', item.id); }}>Open details</button>
      </div>
    </Sheet>
  );
}

/**
 * One item. Swipe right for Flag and Urgent, swipe left for Details and
 * Remove (works with a finger or by dragging the mouse). Grocery items have
 * no chat of their own: the whole Groceries list has one chat instead.
 */
export function ItemRow({ item, onCheck, compact, showList }: { item: any; onCheck: () => void; compact?: boolean; showList?: string }) {
  const me = useMe();
  const open = useOpen();
  const toast = useToast();
  const { run } = useAction();
  const [chat, setChat] = useState(false);
  const [dx, setDx] = useState(0);
  const [openSide, setOpenSide] = useState<'left' | 'right' | null>(null);
  const drag = useRef<{ x: number; y: number; base: number; moved: boolean; locked?: 'h' | 'v' } | null>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  const today = todayLocal(me.household.timezone);
  const need = item.grocery_state === 'need';
  const overdue = item.due_date && item.due_date < today && need;
  const canChat = item.module !== 'grocery';
  const ACTIONS = 128;
  const meta = [
    item.due_date && <span key="d" className={overdue ? 'overdue' : item.due_date === today ? 'today' : ''}>{dueLabel(item.due_date, item.due_time, today)}</span>,
    item.repeat_unit && <Repeat key="r" size={11} aria-label="Repeats" />,
    item.subtasks?.total > 0 && <span key="s">{item.subtasks.done}/{item.subtasks.total}</span>,
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
    if (e.button !== 0 || (e.target as HTMLElement).closest('.swipe-actions')) return;
    drag.current = { x: e.clientX, y: e.clientY, base: dx, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const mx = e.clientX - d.x;
    const my = e.clientY - d.y;
    if (!d.locked && (Math.abs(mx) > 8 || Math.abs(my) > 8)) {
      d.locked = Math.abs(mx) > Math.abs(my) ? 'h' : 'v';
      if (d.locked === 'h') (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    if (d.locked !== 'h') return;
    d.moved = true;
    setDx(Math.max(-ACTIONS - 24, Math.min(ACTIONS + 24, d.base + mx)));
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    if (dx > ACTIONS / 2) { setDx(ACTIONS); setOpenSide('left'); }
    else if (dx < -ACTIONS / 2) { setDx(-ACTIONS); setOpenSide('right'); }
    else { setDx(0); setOpenSide(null); }
  };
  // A swipe should not also count as a tap on the row.
  const guard = (fn: () => void) => () => { if (openSide || Math.abs(dx) > 4) { setDx(0); setOpenSide(null); return; } fn(); };
  const shut = () => { setDx(0); setOpenSide(null); };
  const patch = (body: any, msg: string) => run(async () => { await api.patch(`/items/${item.id}`, body); shut(); emitChange(); }, msg);
  const remove = () => run(async () => {
    await api.post(`/entities/item/${item.id}/archive`);
    shut();
    emitChange();
    toast(`Removed “${item.title}”`, { label: 'Undo', run: async () => { await api.post(`/entities/item/${item.id}/unarchive`); emitChange(); } });
  });

  return (
    <li ref={rowRef} className={`item-row swipeable ${need ? '' : 'stocked'} ${item.urgent ? 'urgent' : ''} ${openSide ? 'swiped' : ''} ${dx > 0 ? 'show-left' : dx < 0 ? 'show-right' : ''}`}>
      <div className="swipe-actions left" aria-hidden={openSide !== 'left'}>
        <button className="sa flag" onClick={() => patch({ flagged: !item.flagged }, item.flagged ? 'Unflagged' : 'Flagged')} aria-label={item.flagged ? 'Remove flag' : 'Flag'} tabIndex={openSide === 'left' ? 0 : -1}>
          <Flag size={17} fill={item.flagged ? 'currentColor' : 'none'} /><small>{item.flagged ? 'Unflag' : 'Flag'}</small>
        </button>
        <button className="sa urgent" onClick={() => patch({ urgent: !item.urgent }, item.urgent ? 'Not urgent any more' : 'Marked urgent')} aria-label={item.urgent ? 'Not urgent' : 'Urgent'} tabIndex={openSide === 'left' ? 0 : -1}>
          <b>!</b><small>{item.urgent ? 'Not urgent' : 'Urgent'}</small>
        </button>
      </div>
      <div className="swipe-actions right" aria-hidden={openSide !== 'right'}>
        <button className="sa details" onClick={() => { shut(); open('item', item.id); }} aria-label="Details" tabIndex={openSide === 'right' ? 0 : -1}>
          <MoreHorizontal size={17} /><small>Details</small>
        </button>
        <button className="sa remove" onClick={remove} aria-label="Remove" tabIndex={openSide === 'right' ? 0 : -1}>
          <X size={17} /><small>Remove</small>
        </button>
      </div>
      <div className="swipe-track" style={{ transform: `translateX(${dx}px)`, transition: drag.current?.moved ? 'none' : undefined }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <button className={`circle ${need ? '' : 'on'}`} onClick={guard(onCheck)} aria-label={need ? `Mark ${item.title} as done` : `Back on the list: ${item.title}`} title={need ? 'Done' : 'Back on the list'}>
          {need ? <Check size={12} /> : <Undo2 size={12} />}
        </button>
        <button className="item-main" onClick={guard(() => open('item', item.id))}>
          <span className="item-title">
            {item.urgent && <span className="urgent-mark" aria-label="Urgent">!</span>}
            {item.priority === 'high' || item.priority === 'urgent' ? <span className="bangs" aria-label={`${item.priority} priority`}>{item.priority === 'urgent' ? '!!!' : '!!'}</span> : null}
            {item.title}
          </span>
          {meta.length > 0 && <span className="item-meta">{meta}</span>}
        </button>
        <span className="item-side">
          {item.flagged && <Flag size={14} className="flag" aria-label="Flagged" fill="currentColor" />}
          {item.private && <Lock size={13} className="muted" aria-label="Private" />}
          {canChat && (
            <button className={`comment-btn ${item.thread?.unread ? 'unread' : ''}`} onClick={guard(() => setChat(true))} aria-label={`Comment on ${item.title}${item.thread?.total ? ` (${item.thread.total} messages)` : ''}`} title="Comment">
              {item.thread?.total ? <><MessageSquare size={15} /><small>{item.thread.total}</small></> : <MessageSquarePlus size={15} />}
            </button>
          )}
        </span>
      </div>
      {chat && <QuickChat item={item} onClose={() => { setChat(false); emitChange(); }} />}
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
