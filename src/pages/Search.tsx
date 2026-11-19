import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../lib/api';
import { day } from '../lib/format';
import { useOpen } from '../components/Layout';
import { Empty, Loading, SpaceTag } from '../components/ui';

const TYPE_LABEL: Record<string, string> = { item: 'Item', task: 'Task', event: 'Event', inventory: 'Inventory', expense: 'Expense' };

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  useEffect(() => setText(q), [q]);
  const { data, loading } = useApi<{ results: any[] }>(q.length >= 2 ? `/search?q=${encodeURIComponent(q)}` : null);
  const { data: recent } = useApi<{ recent: any[] }>('/recent');
  const { data: favs } = useApi<{ favorites: any[] }>('/favorites');
  const open = useOpen();
  return (
    <div className="page narrow">
      <h1>Search</h1>
      <form onSubmit={(e) => { e.preventDefault(); const n = new URLSearchParams(params); n.set('q', text); setParams(n); }} className="quick-add">
        <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Items, notes, tasks, events, conversations…" autoFocus aria-label="Search" />
        <button className="btn primary" disabled={text.trim().length < 2}>Search</button>
      </form>
      <p className="muted small">Searches only what you’re allowed to see: your private space and US.</p>
      {q.length >= 2 && (loading && !data ? <Loading /> : data?.results.length ? (
        <ul className="rows">{data.results.map((r, i) => (
          <li key={`${r.type}-${r.id}-${i}`}><button className="row-btn" onClick={() => r.type !== 'expense' && open(r.type, r.id)}>
            <span className="pill tiny">{r.match === 'conversation' ? 'Message' : TYPE_LABEL[r.type]}</span>
            <span className="grow">{r.title}{r.match === 'conversation' && <span className="muted small block">“{r.body.slice(0, 100)}”</span>}{r.archived_at && <span className="muted small"> · archived</span>}</span>
            {r.start_date && <span className="muted small">{day(r.start_date)}</span>}
            <SpaceTag space={r.space} />
          </button></li>
        ))}</ul>
      ) : <Empty title="Nothing found" />)}
      {q.length < 2 && (
        <div className="dash-grid">
          <section className="card"><h2 className="card-title">Favourites</h2>
            {favs?.favorites.length ? <ul className="rows">{favs.favorites.map((f) => <li key={f.id}><button className="row-btn" onClick={() => open(f.type, f.id)}><span className="grow">{f.title}</span><SpaceTag space={f.space} /></button></li>)}</ul> : <p className="muted small">Star items to find them quickly.</p>}
          </section>
          <section className="card"><h2 className="card-title">Recently viewed</h2>
            {recent?.recent.length ? <ul className="rows">{recent.recent.map((f) => <li key={f.id}><button className="row-btn" onClick={() => open(f.type, f.id)}><span className="grow">{f.title}</span><SpaceTag space={f.space} /></button></li>)}</ul> : <p className="muted small">Nothing yet.</p>}
          </section>
        </div>
      )}
    </div>
  );
}
