import { useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Archive, Lock, LockOpen, MoreHorizontal, Pencil, Plus, Receipt, Search, SlidersHorizontal, X } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { listApi, type ListDef } from '../lib/lists';
import { findList, useLists } from '../lib/useLists';
import { BuySheet, ItemRow, ReceiptSheet, usePurchase } from '../components/ItemRow';
import { Confirm, Empty, Field, Loading, Sheet, useAction } from '../components/ui';

type Filters = { q: string; category: string; priority: string; flagged: boolean; dated: boolean; urgent: boolean; added_by: string; privacy: string; sort: string };
const NO_FILTERS: Filters = { q: '', category: '', priority: '', flagged: false, dated: false, urgent: false, added_by: '', privacy: '', sort: 'category' };

/** Every list shares this page: the three built-in ones and the lists you make. */
export function ListPage() {
  const { slug } = useParams();
  const { lists, ready } = useLists();
  const list = findList(lists, slug);
  if (!list && /^[0-9a-f-]{36}$/.test(slug ?? '')) return ready ? <PlanListRedirect id={slug!} /> : <div className="page"><Loading /></div>;
  if (!list) return <Navigate to="/lists/groceries" replace />;
  return <ListView key={list.key} list={list} />;
}

/** A plan's own list (or an archived one) is not in the sidebar: show it on its plan page instead. */
function PlanListRedirect({ id }: { id: string }) {
  const { data, error } = useApi<{ list: any }>(`/lists/${id}`);
  if (error) return <Navigate to="/lists/groceries" replace />;
  if (!data) return <div className="page"><Loading /></div>;
  if (data.list.plan) return <Navigate to={`/plan/${data.list.plan.id}`} replace />;
  return <div className="page narrow"><Empty title="This list is archived">Restore it from the <Link to="/archive">Archive</Link>.</Empty></div>;
}

function ListView({ list }: { list: ListDef }) {
  const me = useMe();
  const module = list.module;
  const paths = listApi(list);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [newSection, setNewSection] = useState(false);
  const nav = useNavigate();
  const { reload: reloadLists } = useLists();
  const [params, setParams] = useSearchParams();
  const state = params.get('state') === 'stock' ? 'stock' : 'need';
  const [f, setF] = useState<Filters>(NO_FILTERS);
  const [searchOpen, setSearchOpen] = useState(false);
  const qs = new URLSearchParams({ state, sort: f.sort });
  if (f.q.trim()) qs.set('q', f.q.trim());
  if (f.category) qs.set('category', f.category);
  if (f.priority) qs.set('priority', f.priority);
  if (f.flagged) qs.set('flagged', 'true');
  if (f.dated) qs.set('dated', 'true');
  if (f.urgent) qs.set('urgent', 'true');
  if (f.added_by) qs.set('added_by', f.added_by);
  if (f.privacy) qs.set('privacy', f.privacy);
  const { data, loading } = useApi<{ items: any[]; counts: { need: number; stock: number } }>(paths.items(String(qs)));
  const { data: stockData } = useApi<{ items: any[] }>(state === 'need' ? paths.items('state=stock&limit=500') : null);
  const { data: cats } = useApi<{ categories: any[] }>(paths.sections);
  const custom = module === 'custom';
  const needLabel = custom ? 'To get' : 'Need';
  const stockLabel = custom ? 'Got' : 'Stock';
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [locked, setLocked] = useState(false);
  const [buying, setBuying] = useState<any>(null);
  const [receipt, setReceipt] = useState(false);
  const { run, busy } = useAction();
  const purchase = usePurchase();
  const inputRef = useRef<HTMLInputElement>(null);
  const activeFilters = Object.entries(f).filter(([k, v]) => k !== 'sort' && k !== 'q' && v).length;

  const stockTitles = useMemo(() => new Map((stockData?.items ?? []).map((i) => [i.title.trim().toLowerCase(), i.id])), [stockData]);

  // Group by section (category) like Reminders' sections.
  const groups = useMemo(() => {
    const items = data?.items ?? [];
    if (f.sort !== 'category') return [{ name: '', color: '', items }];
    const map = new Map<string, { name: string; color: string; items: any[] }>();
    for (const i of items) {
      const key = i.category?.name ?? '';
      if (!map.has(key)) map.set(key, { name: key, color: i.category?.color ?? '', items: [] });
      map.get(key)!.items.push(i);
    }
    const order = new Map((cats?.categories ?? []).map((c, n) => [c.name, n]));
    return [...map.values()].sort((a, b) => (a.name ? order.get(a.name) ?? 500 : 999) - (b.name ? order.get(b.name) ?? 500 : 999));
  }, [data, cats, f.sort]);

  const add = () => title.trim() && run(async () => {
    await api.post(paths.add, { ...paths.addBody, title: title.trim(), category_id: category || null, grocery_state: state, private: list.private || locked });
    setTitle('');
    emitChange();
    inputRef.current?.focus();
  });

  const check = (item: any) => {
    if (item.grocery_state === 'stock') return run(async () => { await api.post(`/items/${item.id}/need`, {}); emitChange(); }, `${item.title} → need`);
    if (module === 'grocery' && !me.household.auto_move_to_stock && !item.repeat_unit) return setBuying(item);
    return purchase(item, stockTitles);
  };

  const setState = (s: 'need' | 'stock') => { const n = new URLSearchParams(params); if (s === 'stock') n.set('state', 'stock'); else n.delete('state'); setParams(n, { replace: true }); };

  return (
    <div className="page list-page" style={{ ['--list' as any]: list.color }}>
      <header className="list-head">
        <h1><span className="list-icon big" style={{ background: list.color }} aria-hidden>{list.emoji}</span>{list.label}{list.private && <Lock size={16} className="muted" aria-label="Private list" />}</h1>
        <div className="row gap-s">
          {custom && (
            <div className="menu-wrap">
              <button className="icon-btn" onClick={() => setMenu((x) => !x)} aria-expanded={menu} aria-label="List options"><MoreHorizontal size={19} /></button>
              {menu && (
                <div className="pop-menu" role="menu" onMouseLeave={() => setMenu(false)}>
                  <button role="menuitem" onClick={() => { setMenu(false); setRenaming(true); }}><Pencil size={14} /> Rename</button>
                  <button role="menuitem" onClick={() => { setMenu(false); setNewSection(true); }}><Plus size={14} /> Add a section</button>
                  <button role="menuitem" className="danger" onClick={() => { setMenu(false); setArchiving(true); }}><Archive size={14} /> Archive list</button>
                </div>
              )}
            </div>
          )}
          {module === 'grocery' && <button className="btn receipt-btn" onClick={() => setReceipt(true)}><Receipt size={16} /> Scan receipt</button>}
          <button className={`icon-btn ${searchOpen ? 'on' : ''}`} onClick={() => setSearchOpen((x) => !x)} aria-expanded={searchOpen} aria-label="Search and filters">
            <Search size={19} />{activeFilters > 0 && <b className="badge dot">{activeFilters}</b>}
          </button>
        </div>
      </header>

      <div className="need-tabs" role="tablist" aria-label="Need or in stock">
        <button role="tab" aria-selected={state === 'need'} className={state === 'need' ? 'on' : ''} onClick={() => setState('need')}>{needLabel} <span>{data?.counts.need ?? ''}</span></button>
        <button role="tab" aria-selected={state === 'stock'} className={state === 'stock' ? 'on' : ''} onClick={() => setState('stock')}>{stockLabel} <span>{data?.counts.stock ?? ''}</span></button>
      </div>

      {searchOpen && (
        <section className="filters">
          <div className="search-field">
            <Search size={15} aria-hidden />
            <input autoFocus value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder={`Search ${list.label}`} aria-label="Search this list" />
            {f.q && <button className="icon-btn small" onClick={() => setF({ ...f, q: '' })} aria-label="Clear search"><X size={14} /></button>}
          </div>
          <div className="filter-row">
            <SlidersHorizontal size={15} className="muted" aria-hidden />
            <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} aria-label="Section">
              <option value="">All sections</option>{cats?.categories.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
            <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} aria-label="Priority">
              <option value="">Any priority</option><option value="urgent">Urgent</option><option value="high">High</option><option value="low">Low</option>
            </select>
            <select value={f.added_by} onChange={(e) => setF({ ...f, added_by: e.target.value })} aria-label="Added by">
              <option value="">Added by anyone</option>{me.members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </select>
            <select value={f.privacy} onChange={(e) => setF({ ...f, privacy: e.target.value })} aria-label="Shared or private">
              <option value="">Shared &amp; private</option><option value="shared">Shared only</option><option value="private">Private only</option>
            </select>
            <select value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} aria-label="Sort">
              <option value="category">By section</option><option value="priority">By priority</option><option value="due">By date</option><option value="title">A–Z</option><option value="recent">Recently changed</option>
            </select>
          </div>
          <div className="filter-row">
            {([['flagged', 'Flagged'], ['urgent', 'Urgent'], ['dated', 'Has a date']] as const).map(([k, label]) => (
              <button key={k} className={`chip button ${f[k] ? 'on' : ''}`} aria-pressed={f[k]} onClick={() => setF({ ...f, [k]: !f[k] })}>{label}</button>
            ))}
            {activeFilters > 0 && <button className="link-btn" onClick={() => setF({ ...NO_FILTERS, q: f.q })}>Clear filters</button>}
          </div>
        </section>
      )}

      <form className="add-bar" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <Plus size={18} className="add-plus" aria-hidden />
        <input ref={inputRef} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={state === 'need' ? `Add to ${list.label}…` : 'Add something you have…'} aria-label="New item" />
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Section for new item" className="hide-sm">
          <option value="">Section</option>{cats?.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {!list.private && <button type="button" className={`icon-btn lock-toggle ${locked ? 'on' : ''}`} onClick={() => setLocked((x) => !x)} aria-pressed={locked}
          aria-label={locked ? 'Private: only you will see it' : `Shared with ${me.partner?.display_name ?? 'your partner'}`} title={locked ? 'Private: only you will see it' : 'Shared with both of you. Tap to make private.'}>
          {locked ? <Lock size={16} /> : <LockOpen size={16} />}
        </button>}
        <button className="btn primary" disabled={!title.trim() || busy}>Add</button>
      </form>

      {loading && !data ? <Loading /> : !data?.items.length ? (
        <Empty title={f.q || activeFilters ? 'Nothing matches' : state === 'need' ? 'All done' : custom ? 'Nothing ticked off yet' : 'Nothing in stock'}>
          {f.q || activeFilters ? 'Try another search or clear the filters.' : state === 'need' ? 'Add what you need above.' : custom ? 'Ticked-off things move here.' : 'Bought items move here.'}
        </Empty>
      ) : (
        <div className="sections">
          {groups.map((g) => (
            <section key={g.name || 'none'} className="list-section">
              {f.sort === 'category' && <h2 className="section-title">{g.color && <span className="swatch" style={{ background: g.color }} />}{g.name || 'Other'} <span className="count">{g.items.length}</span></h2>}
              <ul className="items">{g.items.map((i) => <ItemRow key={i.id} item={i} onCheck={() => check(i)} />)}</ul>
            </section>
          ))}
        </div>
      )}

      {buying && <BuySheet item={buying} onClose={() => setBuying(null)} onConfirm={(q) => { purchase(buying, stockTitles, q); setBuying(null); }}
        onDone={() => { run(async () => { await api.post(`/entities/item/${buying.id}/archive`); emitChange(); }, `${buying.title} done`); setBuying(null); }} />}
      {receipt && <ReceiptSheet onClose={() => setReceipt(false)} />}
      {renaming && <RenameListSheet list={list} onClose={() => setRenaming(false)} onSaved={() => { setRenaming(false); reloadLists(); }} />}
      {newSection && <NewSectionSheet path={paths.sections} onClose={() => setNewSection(false)} />}
      {archiving && (
        <Confirm title={`Archive “${list.label}”?`} confirmLabel="Archive" danger onClose={() => setArchiving(false)}
          body={<>The list and everything in it move to the Archive{list.private ? '' : ' for both of you'}. You can restore it from there, or delete it for good.</>}
          onConfirm={() => run(async () => { await api.patch(`/lists/${list.id}`, { archived: true }); setArchiving(false); emitChange(); nav('/'); }, `Archived “${list.label}”`)} />
      )}
    </div>
  );
}

function RenameListSheet({ list, onClose, onSaved }: { list: ListDef; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(list.label);
  const { run, busy } = useAction();
  const save = () => name.trim() && run(async () => { await api.patch(`/lists/${list.id}`, { name: name.trim() }); emitChange(); onSaved(); });
  return (
    <Sheet title="Rename list" onClose={onClose} compact footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!name.trim() || busy} onClick={save}>Save</button></>}>
      <Field label="Name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} onKeyDown={(e) => e.key === 'Enter' && save()} /></Field>
    </Sheet>
  );
}

function NewSectionSheet({ path, onClose }: { path: string; onClose: () => void }) {
  const [name, setName] = useState('');
  const { run, busy } = useAction();
  const save = () => name.trim() && run(async () => { await api.post(path, { name: name.trim() }); emitChange(); onClose(); }, `Added “${name.trim()}”`);
  return (
    <Sheet title="New section" onClose={onClose} compact footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!name.trim() || busy} onClick={save}>Add</button></>}>
      <Field label="Section name"><input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="Fiction, To pack, Drinks…" onKeyDown={(e) => e.key === 'Enter' && save()} /></Field>
    </Sheet>
  );
}
