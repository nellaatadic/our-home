import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlarmClock, Archive, ArchiveRestore, Bell, Calendar, Check, Clock, ExternalLink, Flag, Hash, LayoutList, ListChecks, Lock, MessageCircle, Plus, Repeat, Star, Trash2, X,
} from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { dueLabel, todayLocal } from '../lib/format';
import { EARLY_OPTIONS, LISTS, listByModule } from '../lib/lists';
import { Thread } from './Thread';
import { Confirm, ErrorNote, Loading, useAction, useToast } from './ui';
import { History, Images, Reactions } from './EntitySheet';

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

/** One row of a grouped iOS-style card. */
export function Cell({ icon, label, sub, children, onClick }: { icon?: ReactNode; label: ReactNode; sub?: ReactNode; children?: ReactNode; onClick?: () => void }) {
  const inner = (
    <>
      {icon && <span className="icell-icon">{icon}</span>}
      <span className="icell-label">{label}{sub && <small>{sub}</small>}</span>
      <span className="icell-value">{children}</span>
    </>
  );
  return onClick ? <button type="button" className="icell" onClick={onClick}>{inner}</button> : <div className="icell">{inner}</div>;
}

const PRIORITIES = [
  { value: 'low', label: 'Low' }, { value: 'normal', label: 'None' }, { value: 'high', label: 'High' }, { value: 'urgent', label: 'Urgent' },
];

/**
 * Item details, laid out like iOS Reminders: grouped cards with switches.
 * Changes are saved with the check button; the chat underneath is live.
 */
export function ItemSheet({ id, onClose, startInChat }: { id: string; onClose: () => void; startInChat?: boolean }) {
  const me = useMe();
  const toast = useToast();
  const today = todayLocal(me.household.timezone);
  const { data, error, reload } = useApi<{ item: any }>(`/items/${id}`);
  const item = data?.item;
  const { data: cats } = useApi<{ categories: any[] }>(item ? `/modules/${item.module}/categories` : null, [item?.module]);
  const [f, setF] = useState<any>(null);
  const [newSub, setNewSub] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState<'details' | 'chat' | 'history'>(startInChat ? 'chat' : 'details');
  const { busy, run } = useAction();
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (item && !f) {
      setF({
        title: item.title, notes: item.notes ?? '', link_url: item.link_url ?? '', due_date: item.due_date ?? '', due_time: item.due_time?.slice(0, 5) ?? '',
        urgent: item.urgent, flagged: item.flagged, repeat_unit: item.repeat_unit ?? '', early: item.early_reminder_minutes == null ? '' : String(item.early_reminder_minutes),
        module: item.module, category_id: item.category_id ?? '', tags: (item.tags ?? []).join(', '), priority: item.priority, private: item.private,
        quantity: item.quantity ?? '', unit: item.unit ?? '', store: item.store ?? '', price: item.price_cents != null ? (item.price_cents / 100).toFixed(2) : '',
      });
    }
  }, [item, f]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const set = (k: string, v: unknown) => setF((x: any) => ({ ...x, [k]: v }));

  const save = () => run(async () => {
    if (!f.title.trim()) throw new Error('Give it a name');
    const body: any = {
      title: f.title.trim(), notes: f.notes, link_url: f.link_url.trim() || null,
      due_date: f.due_date || null, due_time: f.due_date && f.due_time ? f.due_time : null,
      urgent: Boolean(f.urgent), flagged: Boolean(f.flagged), repeat_unit: f.due_date && f.repeat_unit ? f.repeat_unit : null,
      early_reminder_minutes: f.due_date && f.early !== '' ? Number(f.early) : null,
      priority: f.priority, tags: f.tags.split(',').map((t: string) => t.trim()).filter(Boolean),
      quantity: f.quantity === '' ? null : Number(f.quantity), unit: f.unit.trim() || null, store: f.store.trim() || null,
      price_cents: f.price === '' ? null : Math.round(Number(String(f.price).replace(',', '.')) * 100),
      currency: f.price === '' ? null : me.household.currency,
    };
    if (f.module !== item.module) body.module = f.module;
    else body.category_id = f.category_id || null;
    await api.patch(`/items/${item.id}`, body);
    if (f.private !== item.private) await api.post(`/items/${item.id}/privacy`, { private: f.private });
    emitChange();
    onClose();
  });

  const addSub = () => newSub.trim() && run(async () => {
    await api.post(`/items/${item.id}/subtasks`, { title: newSub.trim() });
    setNewSub('');
    await reload();
    emitChange();
  });

  const list = f ? listByModule(f.module) : null;
  const subs: any[] = item?.subtask_list ?? [];

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet ios" role="dialog" aria-modal="true" aria-label={item ? `Details: ${item.title}` : 'Details'}>
        <header className="ios-head">
          <button className="round-btn" onClick={onClose} aria-label="Close without saving"><X size={20} /></button>
          <h2>Details</h2>
          <button className="round-btn primary" onClick={save} disabled={!f || busy} aria-label="Save"><Check size={20} /></button>
        </header>
        <div className="sheet-body ios-body">
          <ErrorNote error={error} />
          {!item || !f ? <Loading /> : <>
            <div className="seg-tabs" role="tablist">
              {(['details', 'chat', 'history'] as const).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                  {t === 'details' ? 'Details' : t === 'chat' ? <>Chat{item.thread.total ? ` · ${item.thread.total}` : ''}{item.thread.unread ? <b className="badge inline">{item.thread.unread}</b> : null}</> : 'History'}
                </button>
              ))}
            </div>

            {tab === 'details' && <>
              <section className="group">
                <input className="title-input" value={f.title} onChange={(e) => set('title', e.target.value)} aria-label="Name" maxLength={200} />
                <textarea className="plain" value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Notes" rows={2} aria-label="Notes" />
                <div className="divider" />
                <div className="row gap-s">
                  <input className="plain grow" value={f.link_url} onChange={(e) => set('link_url', e.target.value)} placeholder="URL" inputMode="url" aria-label="Link" />
                  {item.link_url && <a className="icon-btn small" href={item.link_url} target="_blank" rel="noreferrer" aria-label="Open link"><ExternalLink size={15} /></a>}
                </div>
                <div className="state-row">
                  <span className={`state-pill ${item.grocery_state}`}>{item.grocery_state === 'need' ? 'Need' : 'In stock'}</span>
                  <button className="link-btn" onClick={() => run(async () => { await api.post(`/items/${item.id}/${item.grocery_state === 'need' ? 'purchase' : 'need'}`, {}); await reload(); emitChange(); })}>
                    {item.grocery_state === 'need' ? 'Mark as bought' : 'We ran out'}
                  </button>
                </div>
              </section>

              <h3 className="group-title">Date &amp; Time</h3>
              <section className="group">
                <Cell icon={<Calendar size={18} />} label="Date" sub={f.due_date ? <span className="accent">{dueLabel(f.due_date, null, today)}</span> : null}>
                  <Switch label="Date" checked={Boolean(f.due_date)} onChange={(v) => setF((x: any) => ({ ...x, due_date: v ? today : '', due_time: v ? x.due_time : '' }))} />
                </Cell>
                {f.due_date && <div className="icell-extra"><input type="date" value={f.due_date} onChange={(e) => set('due_date', e.target.value)} aria-label="Date" /></div>}
                <Cell icon={<Clock size={18} />} label="Time" sub={f.due_time ? <span className="accent">{dueLabel(f.due_date || today, f.due_time, today).split(', ')[1]}</span> : null}>
                  <Switch label="Time" checked={Boolean(f.due_time)} onChange={(v) => setF((x: any) => ({ ...x, due_date: x.due_date || (v ? today : ''), due_time: v ? '09:00' : '' }))} />
                </Cell>
                {f.due_time && <div className="icell-extra"><input type="time" value={f.due_time} onChange={(e) => set('due_time', e.target.value)} aria-label="Time" /></div>}
                <Cell icon={<AlarmClock size={18} />} label="Urgent" sub={f.urgent ? `Alarm on: ${item.private ? me.user.display_name : me.members.map((m) => m.display_name).join(' & ')}` : null}>
                  <Switch label="Urgent" checked={Boolean(f.urgent)} onChange={(v) => set('urgent', v)} />
                </Cell>
              </section>
              <p className="group-hint">{f.urgent ? 'Urgent reminders notify both of you when the item is shared.' : 'Mark this as urgent to alert everyone who can see it.'}</p>

              <section className="group">
                <Cell icon={<Repeat size={18} />} label="Repeat">
                  <select className="plain-select" value={f.repeat_unit} onChange={(e) => setF((x: any) => ({ ...x, repeat_unit: e.target.value, due_date: x.due_date || (e.target.value ? today : '') }))} aria-label="Repeat">
                    <option value="">Never</option><option value="day">Daily</option><option value="week">Weekly</option><option value="month">Monthly</option><option value="year">Yearly</option>
                  </select>
                </Cell>
                <Cell icon={<Bell size={18} />} label="Early reminder">
                  <select className="plain-select" value={f.early} onChange={(e) => set('early', e.target.value)} disabled={!f.due_date} aria-label="Early reminder">
                    {EARLY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </Cell>
              </section>
              {f.repeat_unit && <p className="group-hint">When you mark it bought, it stays on the list with the next date.</p>}

              <h3 className="group-title">Organization</h3>
              <section className="group">
                <Cell icon={<span className="list-icon" style={{ background: list!.color }}>{list!.emoji}</span>} label="List">
                  <select className="plain-select" value={f.module} onChange={(e) => setF((x: any) => ({ ...x, module: e.target.value, category_id: '' }))} aria-label="List">
                    {LISTS.map((l) => <option key={l.module} value={l.module}>{l.label}</option>)}
                  </select>
                </Cell>
                <Cell icon={<LayoutList size={18} />} label="Section">
                  {f.module !== item.module ? <span className="muted small">Matched by name</span> : (
                    <select className="plain-select" value={f.category_id} onChange={(e) => set('category_id', e.target.value)} aria-label="Section">
                      <option value="">None</option>
                      {cats?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  )}
                </Cell>
                <Cell icon={<Hash size={18} />} label="Tags">
                  <input className="plain right" value={f.tags} onChange={(e) => set('tags', e.target.value)} placeholder="Add tags" aria-label="Tags, comma separated" />
                </Cell>
                <Cell icon={<ListChecks size={18} />} label="Subtasks"><span className="muted">{subs.filter((s) => s.done).length ? `${subs.filter((s) => s.done).length}/` : ''}{subs.length}</span></Cell>
                <ul className="subtasks">
                  {subs.map((s) => (
                    <li key={s.id}>
                      <button className={`check-btn small ${s.done ? 'on' : ''}`} aria-label={`${s.done ? 'Uncheck' : 'Check'} ${s.title}`}
                        onClick={() => run(async () => { await api.patch(`/subtasks/${s.id}`, { done: !s.done }); await reload(); emitChange(); })}><Check size={11} /></button>
                      <span className={`grow ${s.done ? 'done' : ''}`}>{s.title}</span>
                      <button className="icon-btn small" aria-label={`Delete ${s.title}`} onClick={() => run(async () => { await api.del(`/subtasks/${s.id}`); await reload(); emitChange(); })}><X size={13} /></button>
                    </li>
                  ))}
                  <li>
                    <Plus size={14} className="muted" />
                    <input className="plain grow" value={newSub} onChange={(e) => setNewSub(e.target.value)} placeholder="Add subtask" aria-label="New subtask"
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSub(); } }} />
                  </li>
                </ul>
              </section>

              <section className="group">
                <Cell icon={<Flag size={18} />} label="Flag"><Switch label="Flag" checked={Boolean(f.flagged)} onChange={(v) => set('flagged', v)} /></Cell>
                <Cell icon={<span className="bang">!!!</span>} label="Priority">
                  <select className="plain-select" value={f.priority} onChange={(e) => set('priority', e.target.value)} aria-label="Priority">
                    {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </Cell>
              </section>

              <h3 className="group-title">Amount &amp; store</h3>
              <section className="group">
                <Cell label="Quantity">
                  <span className="row gap-s">
                    <input className="plain right qty" type="number" min={0} step="any" value={f.quantity} onChange={(e) => set('quantity', e.target.value)} placeholder="—" aria-label="Quantity" />
                    <input className="plain unit" value={f.unit} onChange={(e) => set('unit', e.target.value)} placeholder="unit" aria-label="Unit" maxLength={20} />
                  </span>
                </Cell>
                <Cell label="Store"><input className="plain right" value={f.store} onChange={(e) => set('store', e.target.value)} placeholder="Any" aria-label="Store" /></Cell>
                <Cell label="Price"><span className="row gap-s"><input className="plain right price" inputMode="decimal" value={f.price} onChange={(e) => set('price', e.target.value)} placeholder="—" aria-label="Price" /><span className="muted small">{me.household.currency}</span></span></Cell>
              </section>

              <h3 className="group-title">Privacy</h3>
              <section className="group">
                <Cell icon={<Lock size={18} />} label="Private" sub={f.private ? 'Only you can see this' : `Shared with ${me.partner?.display_name ?? 'your partner'}`}>
                  <Switch label="Private" checked={Boolean(f.private)} onChange={(v) => set('private', v)} disabled={!item.can_lock} />
                </Cell>
              </section>
              {!item.can_lock && <p className="group-hint">Only {item.created_by_name ?? 'the person who added it'} can make this private.</p>}

              <h3 className="group-title">Photos</h3>
              <section className="group pad"><Images entityType="item" entity={item} reload={reload} /></section>

              {!item.private && <section className="group pad"><Reactions type="item" entity={item} onChange={reload} /></section>}

              <div className="actions-row">
                <button className="btn small ghost" onClick={() => setTab('chat')}><MessageCircle size={14} /> Chat about this</button>
                <button className="btn small ghost" aria-pressed={item.favorite} onClick={() => run(async () => { await api.post(`/entities/item/${item.id}/favorite`, { favorite: !item.favorite }); reload(); })}>
                  <Star size={14} fill={item.favorite ? 'currentColor' : 'none'} /> Favourite
                </button>
                {!item.archived_at ? (
                  <button className="btn small ghost" onClick={() => run(async () => { await api.post(`/entities/item/${item.id}/archive`); emitChange(); toast('Archived. Find it in Settings → Archive.'); onClose(); })}><Archive size={14} /> Archive</button>
                ) : <>
                  <button className="btn small ghost" onClick={() => run(async () => { await api.post(`/entities/item/${item.id}/unarchive`); reload(); emitChange(); }, 'Restored')}><ArchiveRestore size={14} /> Restore</button>
                  <button className="btn small danger-ghost" onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> Delete permanently</button>
                </>}
              </div>
            </>}

            {tab === 'chat' && (
              <div ref={chatRef} className="group pad">
                <Thread type="item" id={item.id} space={item.private ? 'me' : 'us'} autoFocus placeholder={`Comment on “${item.title}”… type @ to link a card`} />
                <p className="muted tiny">This chat is also saved as a card on the Chat page.</p>
              </div>
            )}
            {tab === 'history' && <section className="group pad"><History type="item" id={item.id} /></section>}
          </>}
        </div>
      </div>
      {confirmDelete && item && (
        <Confirm title="Delete permanently?" danger confirmLabel="Delete forever" onClose={() => setConfirmDelete(false)}
          body={<p>“{item.title}” and its chat will be deleted and cannot be recovered.{!item.private && <> {me.partner?.display_name ?? 'Your partner'} will lose it too.</>}</p>}
          onConfirm={() => run(async () => { await api.del(`/entities/item/${item.id}${item.private ? '' : '?confirm=permanent'}`); emitChange(); onClose(); }, 'Deleted')} />
      )}
    </div>
  );
}
