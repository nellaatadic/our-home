import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CalendarDays, Check, CheckSquare, ClipboardList, ExternalLink, Link2, Lock, LockOpen, MessagesSquare, Share2, StickyNote } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { listApi, type ListDef } from '../lib/lists';
import { useLists } from '../lib/useLists';
import { todayLocal } from '../lib/format';
import { EventForm } from '../components/forms';
import { Sheet, useAction } from '../components/ui';

const URL_IN_TEXT = /https?:\/\/[^\s<>"]+/;

/**
 * "Share to OUR HOME": other apps (via the share sheet on Android, an iPhone
 * Shortcut, or a bookmark on a computer) open /share?title=…&text=…&url=…,
 * and this page asks where the link or text should go.
 */
export function SharePage() {
  const me = useMe();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { lists } = useLists();
  const { data: plans } = useApi<{ plans: any[] }>('/plans');
  const { run, busy } = useAction();

  const shared = useMemo(() => {
    const text = (params.get('text') ?? '').trim();
    const url = (params.get('url') ?? '').trim() || text.match(URL_IN_TEXT)?.[0] || '';
    const rest = text.replace(url, '').trim();
    return { url, title: (params.get('title') ?? '').trim(), note: rest };
  }, [params]);
  const [title, setTitle] = useState(shared.title || shared.note.split('\n')[0]?.slice(0, 200) || '');
  const [note, setNote] = useState(shared.title ? shared.note : shared.note.split('\n').slice(1).join('\n'));
  const [locked, setLocked] = useState(false);
  const [preview, setPreview] = useState<{ title?: string | null; image_url?: string | null; site_name?: string | null } | null>(null);
  const [done, setDone] = useState<{ label: string; to: string } | null>(null);
  const [calendar, setCalendar] = useState(false);

  // Fill in the page title when only a link was shared.
  useEffect(() => {
    if (!shared.url) return;
    api.post('/link-preview', { url: shared.url }).then((p) => {
      if (!p.ok) return;
      setPreview(p);
      setTitle((t) => t || p.title || '');
    }).catch(() => {});
  }, [shared.url]);

  const name = title.trim() || (shared.url ? new URL(shared.url).hostname.replace(/^www\./, '') : 'Shared note');
  const space = locked ? 'me' : 'us';
  const body = [title.trim(), note.trim(), shared.url].filter(Boolean).join('\n');

  const toList = (l: ListDef) => run(async () => {
    const p = listApi(l);
    await api.post(p.add, { ...p.addBody, title: name.slice(0, 200), notes: note.trim() || undefined, link_url: shared.url || null, private: l.private || locked });
    emitChange();
    setDone({ label: l.label, to: `/lists/${l.slug}` });
  });
  const toTodo = () => run(async () => {
    await api.post(`/spaces/${space}/tasks`, { title: name.slice(0, 200), description: [note.trim(), shared.url].filter(Boolean).join('\n') });
    emitChange();
    setDone({ label: 'To do & reminders', to: '/' });
  });
  const toBoard = () => run(async () => {
    const r = await api.post('/pins', shared.url
      ? { kind: 'link', link_url: shared.url, title: title.trim() || undefined, body: note.trim(), private: locked, color: 'paper' }
      : { kind: 'note', title: title.trim() || undefined, body: note.trim(), private: locked });
    emitChange();
    setDone({ label: 'the Board', to: `/board?pin=${r.pin.id}` });
  });
  const toChat = () => run(async () => {
    const g = await api.get('/chat/general');
    await api.post(`/threads/topic/${g.topic.id}/messages`, { body });
    emitChange();
    setDone({ label: 'Our chat', to: '/chat' });
  });
  const toPlan = (p: any) => run(async () => {
    await api.post(`/threads/event/${p.id}/messages`, { body });
    emitChange();
    setDone({ label: p.title, to: `/plan/${p.id}` });
  });

  if (!shared.url && !shared.title && !shared.note) {
    return (
      <div className="page narrow">
        <h1><Share2 size={22} /> Share to OUR HOME</h1>
        <p className="muted">Nothing was shared. To send links here from other apps without copying and pasting, set it up once in <Link to="/settings#share">Settings → Share from other apps</Link>.</p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="page narrow share-page">
        <div className="share-done">
          <span className="done-mark"><Check size={26} /></span>
          <h1>Added to {done.label}</h1>
          <p className="muted">{name}</p>
          <div className="row gap-s"><button className="btn primary" onClick={() => nav(done.to)}>Open it</button><button className="btn ghost" onClick={() => window.close()}>Done</button></div>
        </div>
      </div>
    );
  }

  const upcoming = (plans?.plans ?? []).filter((p) => !p.over);
  return (
    <div className="page narrow share-page">
      <h1><Share2 size={22} /> Where should this go?</h1>
      <section className="share-card">
        {preview?.image_url && <img src={preview.image_url} alt="" referrerPolicy="no-referrer" />}
        <div className="grow">
          <input className="share-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Name" aria-label="Name" maxLength={200} />
          {shared.url && <a className="muted small share-url" href={shared.url} target="_blank" rel="noreferrer noopener"><Link2 size={12} /> {shared.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 70)} <ExternalLink size={11} /></a>}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Add a note (optional)" aria-label="Note" />
        </div>
      </section>
      <button type="button" className={`privacy-row ${locked ? 'on' : ''}`} onClick={() => setLocked((x) => !x)} aria-pressed={locked}>
        {locked ? <Lock size={16} /> : <LockOpen size={16} />}
        <span className="grow">{locked ? 'Private: only you will see it' : `Shared with ${me.partner?.display_name ?? 'your partner'}`}</span>
        <span className="muted small">{locked ? 'Tap to share' : 'Tap to lock'}</span>
      </button>

      <h3>Lists</h3>
      <div className="dest-grid">
        {lists.map((l) => (
          <button key={l.key} className="dest" disabled={busy} onClick={() => toList(l)} style={{ ['--list' as any]: l.color }}>
            <span className="list-icon" style={{ background: l.color }} aria-hidden>{l.emoji}</span><span className="clamp1">{l.label}</span>{l.private && <Lock size={12} className="muted" />}
          </button>
        ))}
      </div>
      <h3>Somewhere else</h3>
      <div className="dest-grid">
        <button className="dest" disabled={busy} onClick={toTodo}><CheckSquare size={18} /> To-do</button>
        <button className="dest" disabled={busy} onClick={() => setCalendar(true)}><CalendarDays size={18} /> Calendar</button>
        <button className="dest" disabled={busy} onClick={toBoard}><StickyNote size={18} /> Board</button>
        <button className="dest" disabled={busy || locked} onClick={toChat} title={locked ? 'Our chat is shared' : undefined}><MessagesSquare size={18} /> Our chat</button>
      </div>
      {upcoming.length > 0 && <>
        <h3>A plan’s chat</h3>
        <div className="dest-grid">
          {upcoming.map((p) => <button key={p.id} className="dest" disabled={busy} onClick={() => toPlan(p)}><ClipboardList size={18} /> <span className="clamp1">{p.title}</span></button>)}
        </div>
      </>}

      {calendar && (
        <Sheet title="Add to the calendar" onClose={() => setCalendar(false)}>
          <EventForm space={space} chooseSpace initial={{ title: name.slice(0, 300), date: todayLocal(me.household.timezone), description: [note.trim(), shared.url].filter(Boolean).join('\n') }}
            onCancel={() => setCalendar(false)} onSaved={() => { setCalendar(false); emitChange(); setDone({ label: 'the calendar', to: '/calendar' }); }} />
        </Sheet>
      )}
      <p className="muted tiny">Tip: <Link to="/settings#share">set up sharing</Link> so this page opens straight from other apps.</p>
    </div>
  );
}
