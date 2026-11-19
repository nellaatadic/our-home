import { useMemo, useRef, useState } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router-dom';
import { Lock, LockOpen, Plus, Receipt, Search, SlidersHorizontal, X } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { listBySlug } from '../lib/lists';
import { BuySheet, ItemRow, ReceiptSheet, usePurchase } from '../components/ItemRow';
import { Empty, Loading, useAction } from '../components/ui';

type Filters = { q: string; category: string; priority: string; flagged: boolean; dated: boolean; urgent: boolean; added_by: string; privacy: string; sort: string };
const NO_FILTERS: Filters = { q: '', category: '', priority: '', flagged: false, dated: false, urgent: false, added_by: '', privacy: '', sort: 'category' };

/** Groceries, Home & Gadgets and Shopping & Other all share this page. */
export function ListPage() {
  const { slug } = useParams();
  const list = listBySlug(slug);
  if (!list) return <Navigate to="/lists/groceries" replace />;
  return <ListView key={list.module} module={list.module} />;
}

function ListView({ module }: { module: 'grocery' | 'home' | 'idea' }) {
  const me = useMe();
  const list = listBySlug(module === 'grocery' ? 'groceries' : module === 'home' ? 'home-gadgets' : 'shopping')!;
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
  const { data, loading } = useApi<{ items: any[]; counts: { need: number; stock: number } }>(`/modules/${module}/items?${qs}`);
  const { data: stockData } = useApi<{ items: any[] }>(state === 'need' ? `/modules/${module}/items?state=stock&limit=500` : null);
  const { data: cats } = useApi<{ categories: any[] }>(`/modules/${module}/categories`);
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
    await api.post(`/modules/${module}/items`, { title: title.trim(), category_id: category || null, grocery_state: state, private: locked });
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
        <h1><span className="list-icon big" style={{ background: list.color }} aria-hidden>{list.emoji}</span>{list.label}</h1>
        <div className="row gap-s">
          {module === 'grocery' && <button className="btn receipt-btn" onClick={() => setReceipt(true)}><Receipt size={16} /> Scan receipt</button>}
          <button className={`icon-btn ${searchOpen ? 'on' : ''}`} onClick={() => setSearchOpen((x) => !x)} aria-expanded={searchOpen} aria-label="Search and filters">
            <Search size={19} />{activeFilters > 0 && <b className="badge dot">{activeFilters}</b>}
          </button>
        </div>
      </header>

      <div className="need-tabs" role="tablist" aria-label="Need or in stock">
        <button role="tab" aria-selected={state === 'need'} className={state === 'need' ? 'on' : ''} onClick={() => setState('need')}>Need <span>{data?.counts.need ?? ''}</span></button>
        <button role="tab" aria-selected={state === 'stock'} className={state === 'stock' ? 'on' : ''} onClick={() => setState('stock')}>Stock <span>{data?.counts.stock ?? ''}</span></button>
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
        <button type="button" className={`icon-btn lock-toggle ${locked ? 'on' : ''}`} onClick={() => setLocked((x) => !x)} aria-pressed={locked}
          aria-label={locked ? 'Private: only you will see it' : `Shared with ${me.partner?.display_name ?? 'your partner'}`} title={locked ? 'Private: only you will see it' : 'Shared with both of you. Tap to make private.'}>
          {locked ? <Lock size={16} /> : <LockOpen size={16} />}
        </button>
        <button className="btn primary" disabled={!title.trim() || busy}>Add</button>
      </form>

      {loading && !data ? <Loading /> : !data?.items.length ? (
        <Empty title={f.q || activeFilters ? 'Nothing matches' : state === 'need' ? 'All done' : 'Nothing in stock'}>
          {f.q || activeFilters ? 'Try another search or clear the filters.' : state === 'need' ? 'Add what you need above.' : 'Bought items move here.'}
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
    </div>
  );
}
