import { useMemo, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { Check, ChevronRight, ImageOff, Lock, MessageCircle, Plus, Receipt, Share2, Undo2, Users } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { day, money, qty } from '../lib/format';
import { prepareUpload } from '../lib/image';
import { useOpen } from '../components/Layout';
import { ShareDialog } from '../components/ShareDialog';
import { ExpenseForm, InventoryForm, ItemForm, TaskForm, DECISIONS, ROOMS, TASK_STATUS } from '../components/forms';
import { Empty, Field, Loading, PriorityDot, Segmented, Sheet, useAction, useToast } from '../components/ui';

const MODULES = [
  { key: 'groceries', label: 'Groceries', module: 'grocery' },
  { key: 'home', label: 'Home', module: 'home' },
  { key: 'ideas', label: 'Ideas & wishes', module: 'idea' },
  { key: 'tasks', label: 'To-dos' },
  { key: 'maintenance', label: 'Maintenance' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'expenses', label: 'Expenses' },
] as const;

export function SpacePage({ space }: { space: 'me' | 'us' }) {
  const me = useMe();
  const { module = 'groceries' } = useParams();
  const m = MODULES.find((x) => x.key === module) ?? MODULES[0];
  return (
    <div className={`page page-${space}`}>
      <header className="page-head space-head">
        <div>
          <h1>{space === 'us' ? <><Users size={22} /> US</> : <><Lock size={20} /> ME · {me.user.display_name}</>}</h1>
          <p className="muted">{space === 'us' ? `Shared by ${me.members.map((x) => x.display_name).join(' & ')}` : 'Private — only you can see this. Share anything with US when you’re ready.'}</p>
        </div>
      </header>
      <nav className="subnav" aria-label="Sections">
        {MODULES.map((x) => <NavLink key={x.key} to={`/${space}/${x.key}`} className={({ isActive }) => (isActive ? 'active' : '')}>{x.label}</NavLink>)}
      </nav>
      {m.key === 'groceries' && <Groceries space={space} />}
      {(m.key === 'home' || m.key === 'ideas') && <Collection space={space} module={m.module!} />}
      {m.key === 'tasks' && <Tasks space={space} kind="todo" />}
      {m.key === 'maintenance' && <Tasks space={space} kind="maintenance" />}
      {m.key === 'inventory' && <Inventory space={space} />}
      {m.key === 'expenses' && <Expenses space={space} />}
    </div>
  );
}

// --------------------------------------------------------------- groceries
function Groceries({ space }: { space: 'me' | 'us' }) {
  const me = useMe();
  const open = useOpen();
  const nav = useNavigate();
  const toast = useToast();
  const { run, busy } = useAction();
  const [filters, setFilters] = useState({ category_id: '', priority: '', assigned_to: '', sort: 'priority' });
  const [listId, setListId] = useState('');
  const qs = new URLSearchParams({ module: 'grocery', ...(listId ? { list_id: listId } : {}), ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) }).toString();
  const { data, loading } = useApi<{ items: any[] }>(`/spaces/${space}/items?${qs}`);
  const { data: cats } = useApi<{ categories: any[] }>(`/spaces/${space}/categories?module=grocery`);
  const { data: lists } = useApi<{ lists: any[] }>(`/spaces/${space}/lists?module=grocery`);
  const [quick, setQuick] = useState({ title: '', quantity: '', category_id: '' });
  const [adding, setAdding] = useState<null | 'need' | 'stock'>(null);
  const [share, setShare] = useState(false);
  const [buying, setBuying] = useState<any>(null);
  const [newList, setNewList] = useState(false);
  const [receipt, setReceipt] = useState(false);
  const [receiptText, setReceiptText] = useState('');
  const need = (data?.items ?? []).filter((i) => i.grocery_state === 'need');
  const stock = (data?.items ?? []).filter((i) => i.grocery_state === 'stock');

  const add = () => run(async () => {
    await api.post(`/spaces/${space}/items`, { module: 'grocery', title: quick.title, quantity: quick.quantity ? Number(quick.quantity) : null, category_id: quick.category_id || null, grocery_state: 'need', list_id: listId || undefined });
    setQuick({ ...quick, title: '', quantity: '' });
    emitChange();
  });

  const purchase = (item: any, quantity?: number | null) => run(async () => {
    const existing = stock.find((s) => s.title.trim().toLowerCase() === item.title.trim().toLowerCase() && s.id !== item.id);
    await api.post(`/items/${item.id}/purchase`, { quantity: quantity === undefined ? item.quantity : quantity, merge_into_id: existing?.id });
    emitChange();
    toast(existing ? `Added to “${existing.title}” in STOCK` : `${item.title} → STOCK`);
  });

  const uploadReceipt = async (file: File | undefined, text?: string) => {
    if (!file && !text?.trim()) return;
    await run(async () => {
      const fd = new FormData();
      if (file) fd.set('file', await prepareUpload(file));
      if (text) fd.set('text', text);
      const r = await api.post(`/spaces/${space}/receipts`, fd);
      nav(`/receipts/${r.receipt.id}`);
    });
  };

  return (
    <div className="stack">
      <div className="toolbar">
        {(lists?.lists.length ?? 0) > 1 && (
          <select value={listId} onChange={(e) => setListId(e.target.value)} aria-label="List">
            <option value="">All lists</option>
            {lists!.lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        )}
        <select value={filters.category_id} onChange={(e) => setFilters({ ...filters, category_id: e.target.value })} aria-label="Filter by category">
          <option value="">All categories</option>
          {cats?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: e.target.value })} aria-label="Filter by priority">
          <option value="">Any priority</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option>
        </select>
        {space === 'us' && (
          <select value={filters.assigned_to} onChange={(e) => setFilters({ ...filters, assigned_to: e.target.value })} aria-label="Filter by person">
            <option value="">Anyone</option>{me.members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
          </select>
        )}
        <select value={filters.sort} onChange={(e) => setFilters({ ...filters, sort: e.target.value })} aria-label="Sort">
          <option value="priority">By priority</option><option value="category">By category</option><option value="title">A–Z</option><option value="recent">Recently changed</option>
        </select>
        <span className="grow" />
        <button className="btn small ghost" onClick={() => setNewList(true)}><Plus size={14} /> New list</button>
        <button className="btn small" onClick={() => setReceipt(true)}><Receipt size={14} /> Add receipt</button>
        {space === 'me' && <button className="btn small" onClick={() => setShare(true)} disabled={!data?.items.length}><Share2 size={14} /> Share list with US</button>}
      </div>

      <form className="quick-add" onSubmit={(e) => { e.preventDefault(); if (quick.title.trim()) add(); }}>
        <input value={quick.title} onChange={(e) => setQuick({ ...quick, title: e.target.value })} placeholder="Add something we need…" aria-label="Item name" className="grow" />
        <input value={quick.quantity} onChange={(e) => setQuick({ ...quick, quantity: e.target.value })} placeholder="Qty" type="number" min={0} step="any" className="qty-input" aria-label="Quantity" />
        <select value={quick.category_id} onChange={(e) => setQuick({ ...quick, category_id: e.target.value })} aria-label="Category" className="hide-sm">
          <option value="">Category</option>{cats?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button className="btn primary" disabled={!quick.title.trim() || busy}><Plus size={16} /> Add</button>
        <button type="button" className="btn ghost hide-sm" onClick={() => setAdding('need')}>More details</button>
      </form>

      {loading && !data ? <Loading /> : (
        <div className="need-stock">
          <section className="col">
            <h2 className="col-head">NEED <span className="count">{need.length}</span></h2>
            {need.length ? <ul className="list">{need.map((i) => (
              <li key={i.id} className="list-row">
                <button className="check-btn" onClick={() => (me.household.auto_move_to_stock ? purchase(i) : setBuying(i))} aria-label={`Mark ${i.title} purchased`}><Check size={14} /></button>
                <button className="row-btn" onClick={() => open('item', i.id)}>
                  <PriorityDot p={i.priority} />
                  <span className="grow">{i.title}{i.origin_owner_name && space === 'us' && <span className="from"> · from {i.origin_owner_name}</span>}</span>
                  {i.category && <span className="cat" style={{ ['--c' as any]: i.category.color }}>{i.category.name}</span>}
                  <span className="muted small">{qty(i.quantity, i.unit)}</span>
                  {i.thread.total > 0 && <span className={`msg-count ${i.thread.unread ? 'unread' : ''}`}><MessageCircle size={12} />{i.thread.total}</span>}
                  {i.shared_copy_id && <span className="shared-mark" title="Shared with US"><Users size={12} /></span>}
                </button>
              </li>
            ))}</ul> : <Empty title="Nothing needed">Add items above, or tap ✓ on STOCK items when you run out.</Empty>}
          </section>
          <section className="col">
            <h2 className="col-head">STOCK <span className="count">{stock.length}</span></h2>
            {stock.length ? <ul className="list">{stock.map((i) => (
              <li key={i.id} className="list-row">
                <button className="check-btn ghost" onClick={() => run(async () => { await api.post(`/items/${i.id}/need`, {}); emitChange(); }, `${i.title} → NEED`)} aria-label={`We ran out of ${i.title}`} title="We ran out"><Undo2 size={14} /></button>
                <button className="row-btn" onClick={() => open('item', i.id)}>
                  <span className="grow">{i.title}</span>
                  {i.expires_on && <span className={`small ${i.expires_on <= new Date().toISOString().slice(0, 10) ? 'warn' : 'muted'}`}>exp. {day(i.expires_on, { day: 'numeric', month: 'short' })}</span>}
                  {i.storage_location && <span className="muted small hide-sm">{i.storage_location}</span>}
                  <span className="muted small">{qty(i.quantity, i.unit)}</span>
                </button>
              </li>
            ))}</ul> : <Empty title="Nothing in stock yet">Purchased items move here.</Empty>}
            <button className="btn small ghost" onClick={() => setAdding('stock')}><Plus size={14} /> Add to STOCK</button>
          </section>
        </div>
      )}
      {adding && (
        <Sheet title={adding === 'need' ? 'Add to NEED' : 'Add to STOCK'} onClose={() => setAdding(null)} wide>
          <ItemForm module="grocery" space={space} item={undefined} onCancel={() => setAdding(null)} onSaved={() => { setAdding(null); emitChange(); }} />
        </Sheet>
      )}
      {buying && <BuySheet item={buying} onClose={() => setBuying(null)} onConfirm={(q) => { purchase(buying, q); setBuying(null); }}
        onDone={() => { run(async () => { await api.post(`/entities/item/${buying.id}/archive`); emitChange(); }, `${buying.title} done`); setBuying(null); }} />}
      {share && <ShareDialog type="item" listId={listId || lists?.lists.find((l) => l.is_default)?.id} onClose={() => setShare(false)} />}
      {receipt && (
        <Sheet title="Add a receipt" onClose={() => setReceipt(false)}>
          <p className="muted small">Nothing is added to STOCK until you review and confirm the items.</p>
          <label className="btn primary block"><Receipt size={16} /> Take or choose a photo / PDF
            <input type="file" accept="image/*,application/pdf" capture="environment" hidden disabled={busy} onChange={(e) => uploadReceipt(e.target.files?.[0])} />
          </label>
          <Field label="…or paste the receipt text"><textarea rows={6} value={receiptText} onChange={(e) => setReceiptText(e.target.value)} placeholder={'MILK 1L        1.29\n2 x BREAD      5.00'} /></Field>
          <div className="row end"><button className="btn" disabled={!receiptText.trim() || busy} onClick={() => uploadReceipt(undefined, receiptText)}>Read text</button></div>
        </Sheet>
      )}
      {newList && <NewListSheet space={space} module="grocery" onClose={() => setNewList(false)} onCreated={(id) => { setListId(id); setNewList(false); }} />}
    </div>
  );
}

function BuySheet({ item, onClose, onConfirm, onDone }: { item: any; onClose: () => void; onConfirm: (q: number | null) => void; onDone: () => void }) {
  const [q, setQ] = useState<string>(String(item.quantity ?? 1));
  return (
    <Sheet title={`Bought ${item.title}`} onClose={onClose} footer={<>
      <button className="btn ghost" onClick={onDone} title="Archive the item without tracking it in STOCK">Done, don’t track</button>
      <button className="btn primary" onClick={() => onConfirm(q === '' ? null : Number(q))}>Move to STOCK</button></>}>
      <Field label="How many did you buy?"><input type="number" min={0} step="any" value={q} onChange={(e) => setQ(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && onConfirm(q === '' ? null : Number(q))} /></Field>
      <p className="muted small">Turn on automatic moving in Settings to skip this step.</p>
    </Sheet>
  );
}

function NewListSheet({ space, module, onClose, onCreated }: { space: 'me' | 'us'; module: string; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const { run, busy } = useAction();
  return (
    <Sheet title="New list" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!name.trim() || busy} onClick={() => run(async () => { const r = await api.post(`/spaces/${space}/lists`, { module, name }); emitChange(); onCreated(r.list.id); })}>Create</button></>}>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Christmas shopping" autoFocus maxLength={80} /></Field>
    </Sheet>
  );
}

// ------------------------------------------------------ home & ideas cards
function Collection({ space, module }: { space: 'me' | 'us'; module: 'home' | 'idea' }) {
  const me = useMe();
  const open = useOpen();
  const [f, setF] = useState({ status: '', category_id: '', q: '', tag: '', sort: 'recent', favorites: '' });
  const qs = new URLSearchParams({ module, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)) }).toString();
  const { data, loading } = useApi<{ items: any[] }>(`/spaces/${space}/items?${qs}`);
  const { data: cats } = useApi<{ categories: any[] }>(`/spaces/${space}/categories?module=${module}`);
  const [adding, setAdding] = useState(false);
  const [share, setShare] = useState(false);
  const [newCat, setNewCat] = useState(false);
  const rooms = useMemo(() => [...new Set((data?.items ?? []).map((i) => i.room).filter(Boolean))], [data]);
  const [room, setRoom] = useState('');
  const items = (data?.items ?? []).filter((i) => !room || i.room === room);
  const awaiting = (i: any) => space === 'us' && ['idea', 'considering', 'discussing'].includes(i.decision_status) && !i.reactions.some((r: any) => r.user_id === me.user.id) && i.created_by !== me.user.id;
  return (
    <div className="stack">
      <div className="toolbar">
        <input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder="Filter…" aria-label="Filter" />
        <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label="Status"><option value="">Any status</option>{DECISIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <select value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })} aria-label="Category"><option value="">All categories</option>{cats?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        {module === 'home' && rooms.length > 0 && <select value={room} onChange={(e) => setRoom(e.target.value)} aria-label="Room"><option value="">All rooms</option>{rooms.map((r) => <option key={r}>{r}</option>)}</select>}
        <select value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} aria-label="Sort"><option value="recent">Recent</option><option value="priority">Priority</option><option value="price">Price</option><option value="title">A–Z</option></select>
        <label className="check small"><input type="checkbox" checked={f.favorites === 'true'} onChange={(e) => setF({ ...f, favorites: e.target.checked ? 'true' : '' })} /> Favourites</label>
        {f.tag && <button className="chip button" onClick={() => setF({ ...f, tag: '' })}>#{f.tag} ✕</button>}
        <span className="grow" />
        <button className="btn small ghost" onClick={() => setNewCat(true)}>New category</button>
        {space === 'me' && <button className="btn small" disabled={!items.length} onClick={() => setShare(true)}><Share2 size={14} /> Share with US</button>}
        <button className="btn small primary" onClick={() => setAdding(true)}><Plus size={14} /> Add</button>
      </div>
      {loading && !data ? <Loading /> : items.length ? (
        <div className="cards">
          {items.map((i) => {
            const img = i.images[0]?.url ?? i.link_image_url;
            return (
              <button key={i.id} className={`item-card ${awaiting(i) ? 'awaiting' : ''}`} onClick={() => open('item', i.id)}>
                <div className="thumb">{img ? <img src={img} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <ImageOff size={20} aria-hidden />}</div>
                <div className="item-card-body">
                  <div className="row gap-s"><PriorityDot p={i.priority} /><b className="grow clamp1">{i.title}</b></div>
                  <div className="row gap-s wrap small">
                    <span className={`status st-${i.decision_status}`}>{DECISIONS.find(([v]) => v === i.decision_status)?.[1]}</span>
                    {i.price_cents != null && <span>{money(i.price_cents, i.currency ?? me.household.currency)}</span>}
                    {i.room && <span className="muted">{i.room}</span>}
                    {i.intended_for_user_id && <span className="muted">for {me.members.find((m) => m.id === i.intended_for_user_id)?.display_name}</span>}
                    {i.intended_for_name && <span className="muted">for {i.intended_for_name}</span>}
                  </div>
                  <div className="row gap-s small muted">
                    {i.reactions.map((r: any) => <span key={r.user_id} title={r.name}>{({ love: '❤️', yes: '👍', unsure: '🤔', no: '👎' } as any)[r.reaction]}</span>)}
                    {i.thread.total > 0 && <span className={`msg-count ${i.thread.unread ? 'unread' : ''}`}><MessageCircle size={12} />{i.thread.total}</span>}
                    {i.comparison_group_id && <span>⇄ options</span>}
                    {i.shared_copy_id && <span><Users size={12} /> shared</span>}
                    {space === 'us' && i.origin_owner_name && <span>from {i.origin_owner_name}</span>}
                    {awaiting(i) && <span className="warn">awaiting you</span>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      ) : <Empty title={module === 'home' ? 'No home projects yet' : 'No ideas yet'}>{module === 'home' ? 'Shelving, lighting, paint… add what you’re considering, with links and photos.' : 'Gifts, restaurants, trips, clothes — anything worth remembering.'}</Empty>}
      {adding && <Sheet title={module === 'home' ? 'Add home improvement' : 'Add idea'} onClose={() => setAdding(false)} wide><ItemForm module={module} space={space} onCancel={() => setAdding(false)} onSaved={(it) => { setAdding(false); emitChange(); open('item', it.id); }} /></Sheet>}
      {share && <ShareDialog type="item" ids={items.map((i) => i.id)} onClose={() => setShare(false)} />}
      {newCat && <NewCategorySheet space={space} module={module} onClose={() => setNewCat(false)} />}
    </div>
  );
}

function NewCategorySheet({ space, module, onClose }: { space: 'me' | 'us'; module: string; onClose: () => void }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState('#8a8178');
  const { run, busy } = useAction();
  return (
    <Sheet title="New category" onClose={onClose} footer={<><button className="btn ghost" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={!name.trim() || busy} onClick={() => run(async () => { await api.post(`/spaces/${space}/categories`, { module, name, color }); emitChange(); onClose(); }, 'Category added')}>Add</button></>}>
      <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} /></Field>
      <Field label="Colour"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></Field>
    </Sheet>
  );
}

// ------------------------------------------------------------------- tasks
function Tasks({ space, kind }: { space: 'me' | 'us'; kind: 'todo' | 'maintenance' }) {
  const me = useMe();
  const open = useOpen();
  const { run } = useAction();
  const [status, setStatus] = useState<'open' | 'completed' | 'all'>('open');
  const [assigned, setAssigned] = useState('');
  const { data, loading } = useApi<{ tasks: any[] }>(`/spaces/${space}/tasks?status=${status}&kind=${kind}${assigned ? `&assigned=${assigned}` : ''}`);
  const [quick, setQuick] = useState('');
  const [adding, setAdding] = useState(false);
  const [share, setShare] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const who = (t: any) => t.assignee === 'both' ? 'BOTH' : t.assignee === 'user' ? (t.assigned_user_id === me.user.id ? 'ME' : t.assigned_user_name) : '';
  return (
    <div className="stack">
      <div className="toolbar">
        <Segmented label="Show" value={status} onChange={setStatus} options={[{ value: 'open', label: 'Open' }, { value: 'completed', label: 'Done' }, { value: 'all', label: 'All' }]} />
        {space === 'us' && (
          <Segmented label="Assigned" value={assigned} onChange={setAssigned} options={[{ value: '', label: 'Everyone' }, { value: 'me', label: 'ME' }, ...(me.partner ? [{ value: 'partner', label: me.partner.display_name }] : []), { value: 'both', label: 'BOTH' }]} />
        )}
        <span className="grow" />
        {space === 'me' && <button className="btn small" disabled={!data?.tasks.length} onClick={() => setShare(true)}><Share2 size={14} /> Share with US</button>}
        <button className="btn small primary" onClick={() => setAdding(true)}><Plus size={14} /> {kind === 'maintenance' ? 'Add maintenance' : 'Add task'}</button>
      </div>
      <form className="quick-add" onSubmit={(e) => { e.preventDefault(); if (quick.trim()) run(async () => { await api.post(`/spaces/${space}/tasks`, { title: quick, kind }); setQuick(''); emitChange(); }); }}>
        <input className="grow" value={quick} onChange={(e) => setQuick(e.target.value)} placeholder={kind === 'maintenance' ? 'e.g. Replace water filter' : 'e.g. Book dentist'} aria-label="New task" />
        <button className="btn primary" disabled={!quick.trim()}><Plus size={16} /> Add</button>
      </form>
      {loading && !data ? <Loading /> : data?.tasks.length ? (
        <ul className="list">
          {data.tasks.map((t) => (
            <li key={t.id} className={`list-row ${t.status === 'completed' ? 'done' : ''}`}>
              <button className={`check-btn ${t.status === 'completed' ? 'on' : ''}`} aria-label={t.status === 'completed' ? 'Reopen' : 'Complete'}
                onClick={() => run(async () => { await api.patch(`/tasks/${t.id}`, { status: t.status === 'completed' ? 'todo' : 'completed' }); emitChange(); })}><Check size={14} /></button>
              <button className="row-btn" onClick={() => open('task', t.id)}>
                <PriorityDot p={t.priority} />
                <span className="grow">{t.title}{t.recurrence_unit && <span className="muted small"> · every {t.recurrence_interval > 1 ? `${t.recurrence_interval} ` : ''}{t.recurrence_unit}{t.recurrence_interval > 1 ? 's' : ''}</span>}</span>
                {t.status !== 'todo' && t.status !== 'completed' && <span className={`status st-${t.status}`}>{TASK_STATUS.find(([v]) => v === t.status)?.[1]}</span>}
                {who(t) && <span className="pill tiny">{who(t)}</span>}
                {t.due_date && <span className={`small ${t.due_date < today && t.status !== 'completed' ? 'warn' : 'muted'}`}>{day(t.due_date)}</span>}
                {t.thread.total > 0 && <span className={`msg-count ${t.thread.unread ? 'unread' : ''}`}><MessageCircle size={12} />{t.thread.total}</span>}
                <ChevronRight size={14} className="muted" />
              </button>
            </li>
          ))}
        </ul>
      ) : <Empty title={status === 'open' ? 'Nothing to do' : 'Nothing here'}>{kind === 'maintenance' ? 'Add recurring jobs like filters, smoke detectors or car service.' : 'Tasks don’t need a date — add whatever needs doing.'}</Empty>}
      {adding && <Sheet title={kind === 'maintenance' ? 'New maintenance task' : 'New task'} onClose={() => setAdding(false)} wide><TaskForm space={space} kind={kind} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); emitChange(); }} /></Sheet>}
      {share && <ShareDialog type="task" ids={data!.tasks.map((t) => t.id)} onClose={() => setShare(false)} />}
    </div>
  );
}

// --------------------------------------------------------------- inventory
function Inventory({ space }: { space: 'me' | 'us' }) {
  const me = useMe();
  const open = useOpen();
  const [room, setRoom] = useState('');
  const [q, setQ] = useState('');
  const { data, loading } = useApi<{ inventory: any[] }>(`/spaces/${space}/inventory?${new URLSearchParams({ ...(room ? { room } : {}), ...(q ? { q } : {}) })}`);
  const [adding, setAdding] = useState(false);
  const grouped = new Map<string, any[]>();
  for (const i of data?.inventory ?? []) grouped.set(i.room, [...(grouped.get(i.room) ?? []), i]);
  return (
    <div className="stack">
      <div className="toolbar">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find…" aria-label="Find in inventory" />
        <select value={room} onChange={(e) => setRoom(e.target.value)} aria-label="Room"><option value="">All rooms</option>{ROOMS.map((r) => <option key={r}>{r}</option>)}</select>
        <span className="grow" />
        <button className="btn small primary" onClick={() => setAdding(true)}><Plus size={14} /> Add item</button>
      </div>
      {loading && !data ? <Loading /> : grouped.size ? [...grouped.entries()].map(([r, items]) => (
        <section key={r} className="card">
          <h2 className="card-title">{r} <span className="count">{items.length}</span></h2>
          <ul className="list">{items.map((i) => (
            <li key={i.id} className="list-row"><button className="row-btn" onClick={() => open('inventory', i.id)}>
              <span className="grow">{i.name}{i.brand && <span className="muted small"> · {i.brand}{i.model ? ` ${i.model}` : ''}</span>}</span>
              {i.dimensions && <span className="muted small hide-sm">{i.dimensions}</span>}
              {i.warranty_until && <span className={`small ${i.warranty_until < new Date().toISOString().slice(0, 10) ? 'muted' : ''}`}>warranty {day(i.warranty_until, { month: 'short', year: 'numeric' })}</span>}
              {i.price_cents != null && <span className="small">{money(i.price_cents, i.currency ?? me.household.currency)}</span>}
            </button></li>
          ))}</ul>
        </section>
      )) : <Empty title="No inventory yet">Track furniture, appliances and equipment with dimensions, warranties and manuals.</Empty>}
      {adding && <Sheet title="Add to inventory" onClose={() => setAdding(false)} wide><InventoryForm space={space} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); emitChange(); }} /></Sheet>}
    </div>
  );
}

// ---------------------------------------------------------------- expenses
function Expenses({ space }: { space: 'me' | 'us' }) {
  const me = useMe();
  const nav = useNavigate();
  const now = new Date();
  const [range, setRange] = useState({ from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10), to: '' });
  const { data, loading } = useApi<any>(`/spaces/${space}/expenses?${new URLSearchParams(Object.fromEntries(Object.entries(range).filter(([, v]) => v)))}`);
  const { data: receipts } = useApi<{ receipts: any[] }>(`/spaces/${space}/receipts`);
  const [adding, setAdding] = useState(false);
  const cur = me.household.currency;
  const pending = receipts?.receipts.filter((r) => r.status === 'review') ?? [];
  return (
    <div className="stack">
      <div className="toolbar">
        <Field label="From"><input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
        <Field label="To"><input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
        <span className="grow" />
        <button className="btn small primary" onClick={() => setAdding(true)}><Plus size={14} /> Add expense</button>
      </div>
      {pending.length > 0 && (
        <div className="note">{pending.length} receipt{pending.length > 1 ? 's' : ''} waiting for review: {pending.map((r) => <button key={r.id} className="link-btn" onClick={() => nav(`/receipts/${r.id}`)}>{r.merchant ?? 'Receipt'} ({new Date(r.created_at).toLocaleDateString()})</button>)}</div>
      )}
      {loading && !data ? <Loading /> : (
        <>
          <div className="stats">
            <div className="stat"><span className="muted small">Total</span><b>{money(data.totals.total, cur)}</b></div>
            {Object.entries(data.totals.by_category as Record<string, number>).slice(0, 4).map(([k, v]) => <div key={k} className="stat"><span className="muted small">{k}</span><b>{money(v, cur)}</b></div>)}
          </div>
          {space === 'us' && me.partner && (
            <div className="card">
              <h3>Shared costs</h3>
              {me.members.map((m) => {
                const b = data.totals.balance[m.id] ?? { paid: 0, responsible: 0 };
                const diff = b.paid - b.responsible;
                return <p key={m.id}><b>{m.display_name}</b> paid {money(b.paid, cur)}, responsible for {money(b.responsible, cur)} <span className={diff > 0 ? 'ok' : diff < 0 ? 'warn' : 'muted'}>({diff >= 0 ? '+' : ''}{money(diff, cur)})</span></p>;
              })}
            </div>
          )}
          {data.expenses.length ? (
            <ul className="list">{data.expenses.map((e: any) => (
              <li key={e.id} className="list-row"><div className="row-btn static">
                <span className="time">{day(e.purchase_date, { day: 'numeric', month: 'short' })}</span>
                <span className="grow">{e.title}{e.category && <span className="muted small"> · {e.category}</span>}</span>
                <span className="muted small hide-sm">{me.members.find((m) => m.id === e.purchaser_id)?.display_name}</span>
                <span className="pill tiny">{e.split_mode === 'equal' ? 'split' : e.split_mode === 'custom' ? 'custom split' : 'individual'}</span>
                <b>{money(e.amount_cents, e.currency)}</b>
                {e.receipt_id && <button className="icon-btn small" onClick={() => nav(`/receipts/${e.receipt_id}`)} aria-label="Receipt"><Receipt size={14} /></button>}
              </div></li>
            ))}</ul>
          ) : <Empty title="No expenses in this period" />}
        </>
      )}
      {adding && <Sheet title="Add expense" onClose={() => setAdding(false)} wide><ExpenseForm space={space} onCancel={() => setAdding(false)} onSaved={() => { setAdding(false); emitChange(); }} /></Sheet>}
    </div>
  );
}
