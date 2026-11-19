import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlarmClock, Check, Flag, Lock, MessageSquare, MessageSquarePlus, Receipt, Repeat, Undo2 } from 'lucide-react';
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

export function ItemRow({ item, onCheck, compact, showList }: { item: any; onCheck: () => void; compact?: boolean; showList?: string }) {
  const me = useMe();
  const open = useOpen();
  const [chat, setChat] = useState(false);
  const today = todayLocal(me.household.timezone);
  const need = item.grocery_state === 'need';
  const overdue = item.due_date && item.due_date < today && need;
  const meta = [
    item.due_date && <span key="d" className={overdue ? 'overdue' : item.due_date === today ? 'today' : ''}>{dueLabel(item.due_date, item.due_time, today)}</span>,
    item.repeat_unit && <Repeat key="r" size={11} aria-label="Repeats" />,
    item.subtasks?.total > 0 && <span key="s">{item.subtasks.done}/{item.subtasks.total}</span>,
    !compact && item.quantity != null && <span key="q">{qty(item.quantity, item.unit)}</span>,
    !compact && item.notes && <span key="n" className="clamp1 note-preview">{item.notes}</span>,
    showList && <span key="l">{showList}</span>,
  ].filter(Boolean);
  return (
    <li className={`item-row ${need ? '' : 'stocked'} ${item.urgent ? 'urgent' : ''}`}>
      <button className={`circle ${need ? '' : 'on'}`} onClick={onCheck} aria-label={need ? `Mark ${item.title} as bought` : `We ran out of ${item.title}`} title={need ? 'Bought' : 'We ran out'}>
        {need ? <Check size={12} /> : <Undo2 size={12} />}
      </button>
      <button className="item-main" onClick={() => open('item', item.id)}>
        <span className="item-title">
          {item.urgent && <AlarmClock size={13} className="urgent-icon" aria-label="Urgent" />}
          {item.priority === 'high' || item.priority === 'urgent' ? <span className="bangs" aria-label={`${item.priority} priority`}>{item.priority === 'urgent' ? '!!!' : '!!'}</span> : null}
          {item.title}
        </span>
        {meta.length > 0 && <span className="item-meta">{meta}</span>}
      </button>
      <span className="item-side">
        {item.flagged && <Flag size={14} className="flag" aria-label="Flagged" fill="currentColor" />}
        {item.private && <Lock size={13} className="muted" aria-label="Private" />}
        <button className={`comment-btn ${item.thread?.unread ? 'unread' : ''}`} onClick={() => setChat(true)} aria-label={`Comment on ${item.title}${item.thread?.total ? ` (${item.thread.total} messages)` : ''}`} title="Comment">
          {item.thread?.total ? <><MessageSquare size={15} /><small>{item.thread.total}</small></> : <MessageSquarePlus size={15} />}
        </button>
      </span>
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
