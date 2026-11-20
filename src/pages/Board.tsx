import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Archive, ArrowLeft, ExternalLink, Image as ImageIcon, Link2, ListPlus, Lock, LockOpen, Maximize2, MessageCircle, Minus, MoreHorizontal, Pencil, Plus, X,
} from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { prepareUpload } from '../lib/image';
import { useLists } from '../lib/useLists';
import { useOpen } from '../components/Layout';
import { Thread } from '../components/Thread';
import { Linked } from '../components/Linked';
import { Field, Loading, Sheet, useAction } from '../components/ui';

interface PinItem {
  id: string; title: string; notes: string | null; due_date: string | null; tags: string[]; image: string | null; link_url: string | null; urgent: boolean;
  state: string; archived: boolean; thread: { total: number; unread: number }; quantity: number | null; unit: string | null;
  list: { id: string; key: string; name: string; emoji: string | null; color: string | null; module: string } | null;
}
interface Pin {
  id: string; kind: 'note' | 'photo' | 'link' | 'text'; title: string; body: string; color: string; link_url: string | null; link_title: string | null;
  link_image_url: string | null; link_site_name: string | null; x: number; y: number; w: number; h: number; rotation: number; z: number; tags: string[];
  private: boolean; can_lock: boolean; space: 'me' | 'us'; images: { id: string; url: string; filename: string }[]; thread: { total: number; unread: number };
  created_by_name: string | null; item: PinItem | null;
}
interface Cam { x: number; y: number; z: number }

const WALL = 1200;
const MIN_Z = 0.15;
const MAX_Z = 2.5;
/** Below this zoom the names are too small to read, so stickies turn into little bubbles. */
const BUBBLE_Z = 0.5;
const COLORS = ['butter', 'blush', 'sage', 'sky', 'lilac', 'paper', 'ink'] as const;
const COLOR_LABEL: Record<string, string> = { butter: 'Butter', blush: 'Blush', sage: 'Sage', sky: 'Sky', lilac: 'Lilac', paper: 'Paper', ink: 'Ink' };
const clampZ = (z: number) => Math.max(MIN_Z, Math.min(MAX_Z, z));

/**
 * The Board: a wall of stickies you can move, resize and zoom around, like a
 * fridge door or Miro. Stickies that stand for an item already on a list show
 * that item's details; the rest are ideas still floating around.
 */
export function BoardPage() {
  const [params, setParams] = useSearchParams();
  const { data, setData } = useApi<{ pins: Pin[] }>('/board');
  const { data: general } = useApi<{ topic: any }>('/chat/general');
  const [panel, setPanel] = useState(() => window.innerWidth > 1100);
  const [chatPin, setChatPin] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [committing, setCommitting] = useState<Pin | null>(null);
  const { run } = useAction();
  const focus = params.get('pin');
  const pins = data?.pins ?? [];
  const wallRef = useRef<WallHandle | null>(null);

  const update = useCallback((id: string, patch: Partial<Pin>) => {
    setData((d) => (d ? { ...d, pins: d.pins.map((p) => (p.id === id ? { ...p, ...patch } : p)) } : d));
  }, [setData]);

  const add = (body: Record<string, unknown>, after?: (pin: Pin) => Promise<void>) => run(async () => {
    const c = wallRef.current?.center() ?? { x: 400, y: 200 };
    const r = await api.post<{ pin: Pin }>('/pins', { x: Math.max(0, Math.round(c.x - 120 + Math.random() * 40)), y: Math.max(0, Math.round(c.y - 100 + Math.random() * 40)), ...body });
    if (after) await after(r.pin);
    setAdding(false);
    emitChange();
    const n = new URLSearchParams(params); n.set('pin', r.pin.id); setParams(n, { replace: true });
  });
  const addPhoto = (f: File) => add({ kind: 'photo', color: 'paper' }, async (pin) => {
    const fd = new FormData();
    fd.set('entity_type', 'pin'); fd.set('entity_id', pin.id); fd.set('file', await prepareUpload(f));
    await api.post('/attachments', fd);
  });

  const openChat = (id: string | null) => { setChatPin(id); setPanel(true); };
  const current = pins.find((p) => p.id === chatPin);
  const ideas = pins.filter((p) => !p.item).length;

  return (
    <div className={`page board-page ${panel ? 'with-panel' : ''}`}>
      <header className="board-head">
        <h1>Board</h1>
        <span className="muted tiny board-legend"><i className="lg-idea" /> idea · <i className="lg-item" /> on a list{ideas ? ` · ${ideas} floating` : ''}</span>
      </header>
      <div className="board-layout">
        {!data ? <Loading /> : (
          <Wall ref={wallRef} pins={pins} focus={focus} onChange={update} onChat={openChat} onCommit={setCommitting} onAdd={() => setAdding(true)}
            onFocusDone={() => { const n = new URLSearchParams(params); n.delete('pin'); setParams(n, { replace: true }); }} />
        )}
        {panel && (
          <aside className="board-chat" aria-label="Chat">
            {current ? (
              <>
                <header className="board-chat-head">
                  <button className="icon-btn small" onClick={() => setChatPin(null)} aria-label="Back to Our chat"><ArrowLeft size={16} /></button>
                  <b className="grow clamp1">{current.item ? '#' : '@'}{current.title}</b>
                  {current.private && <Lock size={13} className="muted" aria-label="Private" />}
                  <button className="icon-btn small" onClick={() => setPanel(false)} aria-label="Close chat"><X size={16} /></button>
                </header>
                {current.item && <PinSummary item={current.item} />}
                <Linked type={current.item ? 'item' : 'pin'} id={current.item?.id ?? current.id} compact />
                {current.item
                  ? <Thread key={current.item.id} type="item" id={current.item.id} space={current.space} autoFocus />
                  : <Thread key={current.id} type="pin" id={current.id} space={current.space} autoFocus />}
              </>
            ) : (
              <>
                <header className="board-chat-head"><b className="grow">Our chat</b><button className="icon-btn small" onClick={() => setPanel(false)} aria-label="Close chat"><X size={16} /></button></header>
                {general ? <Thread type="topic" id={general.topic.id} space="us" /> : <Loading />}
              </>
            )}
          </aside>
        )}
        {!panel && <button className="board-chat-fab" onClick={() => setPanel(true)} aria-label="Open chat"><MessageCircle size={20} /></button>}
      </div>
      {adding && <AddSheet onClose={() => setAdding(false)} onIdea={(title) => add({ kind: 'note', title: title || undefined, color: COLORS[Math.floor(Math.random() * 5)] })}
        onItem={(id) => add({ item_id: id, color: 'paper' })} onPhoto={addPhoto} onLink={(url) => add({ kind: 'link', link_url: url, color: 'paper' })} />}
      {committing && <CommitSheet pin={committing} onClose={() => setCommitting(null)} />}
    </div>
  );
}

/** The most important details of the item a sticky stands for. */
function PinSummary({ item, small }: { item: PinItem; small?: boolean }) {
  const bits = [
    item.list && <span key="l" className="pin-list" style={{ ['--list' as any]: item.list.color ?? 'var(--l-home)' }}>@{item.list.name}</span>,
    item.urgent && <span key="u" className="overdue">Urgent</span>,
    item.due_date && <span key="d">{new Date(`${item.due_date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>,
    item.quantity != null && <span key="q">{item.quantity}{item.unit ? ` ${item.unit}` : ''}</span>,
    item.state === 'stock' && <span key="s">Got it</span>,
    ...item.tags.slice(0, small ? 2 : 6).map((t) => <span key={t}>#{t}</span>),
  ].filter(Boolean);
  return (
    <div className={`pin-summary ${small ? 'small' : ''}`}>
      {item.image && <img src={item.image} alt="" draggable={false} />}
      <div className="pin-summary-meta">{bits}</div>
      {item.notes && <p className={small ? 'clamp3' : ''}>{item.notes}</p>}
    </div>
  );
}

interface WallHandle { center: () => { x: number; y: number } }

const Wall = ({ ref, pins, focus, onChange, onChat, onCommit, onAdd, onFocusDone }: {
  ref: React.RefObject<WallHandle | null>; pins: Pin[]; focus: string | null; onChange: (id: string, p: Partial<Pin>) => void; onChat: (id: string) => void;
  onCommit: (p: Pin) => void; onAdd: () => void; onFocusDone: () => void;
}) => {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [cam, setCam] = useState<Cam | null>(() => {
    try { return JSON.parse(localStorage.getItem('board-cam') ?? 'null'); } catch { return null; }
  });
  const [anim, setAnim] = useState(false);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ cam: Cam; x: number; y: number; dist?: number; mid?: { x: number; y: number } } | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  // First visit: fit the width of the wall (a bit closer on a phone).
  useEffect(() => {
    if (!cam && size.w) setCam({ x: 0, y: 0, z: clampZ(size.w / (size.w < 640 ? 640 : WALL)) });
  }, [cam, size.w]);
  useEffect(() => { if (cam) localStorage.setItem('board-cam', JSON.stringify(cam)); }, [cam]);

  const toWorld = (sx: number, sy: number, c = cam!) => ({ x: (sx - c.x) / c.z, y: (sy - c.y) / c.z });
  ref.current = { center: () => (cam ? toWorld(size.w / 2, size.h / 2) : { x: 400, y: 200 }) };

  const flyTo = useCallback((p: Pin, z?: number) => {
    if (!size.w) return;
    const nz = clampZ(z ?? Math.max(0.8, Math.min(1.2, (size.w * 0.8) / p.w)));
    setAnim(true);
    setCam({ z: nz, x: size.w / 2 - (p.x + p.w / 2) * nz, y: size.h / 2 - (p.y + p.h / 2) * nz });
    setTimeout(() => setAnim(false), 320);
  }, [size.w, size.h]);
  useEffect(() => {
    if (!focus || !size.w) return;
    const p = pins.find((x) => x.id === focus);
    if (p) { flyTo(p); setTimeout(onFocusDone, 2500); }
  }, [focus, size.w]); // eslint-disable-line react-hooks/exhaustive-deps

  const zoomAt = (factor: number, sx = size.w / 2, sy = size.h / 2) => setCam((c) => {
    if (!c) return c;
    const z = clampZ(c.z * factor);
    return { z, x: sx - ((sx - c.x) / c.z) * z, y: sy - ((sy - c.y) / c.z) * z };
  });
  const fit = () => {
    if (!pins.length || !size.w) return setCam({ x: 0, y: 0, z: clampZ(size.w / WALL) });
    const minX = Math.min(...pins.map((p) => p.x)); const maxX = Math.max(...pins.map((p) => p.x + p.w));
    const minY = Math.min(...pins.map((p) => p.y)); const maxY = Math.max(...pins.map((p) => p.y + p.h));
    const z = clampZ(Math.min(size.w / (maxX - minX + 80), size.h / (maxY - minY + 80)));
    setAnim(true);
    setCam({ z, x: (size.w - (maxX + minX) * z) / 2, y: (size.h - (maxY + minY) * z) / 2 });
    setTimeout(() => setAnim(false), 320);
  };

  // Pan with one finger (or the mouse) on the empty wall, pinch with two.
  const local = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const onDown = (e: RPointerEvent) => {
    if ((e.target as HTMLElement).closest('.pin, .bubble, .wall-tools, button, a, input, textarea')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
    startGesture();
  };
  const startGesture = () => {
    const pts = [...pointers.current.values()];
    if (!cam || !pts.length) { gesture.current = null; return; }
    if (pts.length === 1) gesture.current = { cam, x: pts[0].x, y: pts[0].y };
    else {
      const [a, b] = pts;
      gesture.current = { cam, x: 0, y: 0, dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
    }
  };
  const onMove = (e: RPointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, local(e));
    const g = gesture.current;
    if (!g) return;
    const pts = [...pointers.current.values()];
    if (pts.length === 1 && g.dist === undefined) {
      setCam({ ...g.cam, x: g.cam.x + pts[0].x - g.x, y: g.cam.y + pts[0].y - g.y });
    } else if (pts.length >= 2 && g.dist && g.mid) {
      const [a, b] = pts;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const z = clampZ(g.cam.z * (Math.hypot(a.x - b.x, a.y - b.y) / g.dist));
      const wx = (g.mid.x - g.cam.x) / g.cam.z;
      const wy = (g.mid.y - g.cam.y) / g.cam.z;
      setCam({ z, x: mid.x - wx * z, y: mid.y - wy * z });
    }
  };
  const onUp = (e: RPointerEvent) => {
    pointers.current.delete(e.pointerId);
    startGesture();
  };
  // Trackpad: two-finger scroll pans, pinch (ctrl + wheel) zooms.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY / 300), e.clientX - r.left, e.clientY - r.top);
      else setCam((c) => (c ? { ...c, x: c.x - e.deltaX, y: c.y - e.deltaY } : c));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const maxZ = useMemo(() => Math.max(0, ...pins.map((p) => p.z)), [pins]);
  const bubbles = Boolean(cam && cam.z < BUBBLE_Z);

  return (
    <div ref={box} className={`wall cam ${bubbles ? 'zoomed-out' : ''}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      {!pins.length && <p className="wall-empty">An empty wall. Tap + to pin an idea or something from your lists.</p>}
      {cam && (
        <div className={`wall-inner ${anim ? 'anim' : ''}`} style={{ width: WALL, transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})` }}>
          {pins.map((p) => bubbles
            ? <button key={p.id} className={`bubble ${p.item ? 'on-list' : 'idea'} c-${p.color}`} style={{ left: p.x + p.w / 2, top: p.y + p.h / 2, transform: `translate(-50%, -50%) scale(${1 / cam.z})` }}
                onClick={() => flyTo(p)} aria-label={`Zoom to ${p.title}`}>{p.item ? '#' : ''}{p.title.toLowerCase()}</button>
            : <PinCard key={p.id} pin={p} scale={cam.z} focused={focus === p.id} maxZ={maxZ} onChange={onChange} onChat={onChat} onCommit={onCommit} />)}
        </div>
      )}
      <div className="wall-tools" role="toolbar" aria-label="Board">
        <button onClick={onAdd} className="primary" aria-label="Add to the board"><Plus size={20} /></button>
        <button onClick={() => zoomAt(1.25)} aria-label="Zoom in"><Plus size={16} /></button>
        <button onClick={() => zoomAt(0.8)} aria-label="Zoom out"><Minus size={16} /></button>
        <button onClick={fit} aria-label="Show everything"><Maximize2 size={15} /></button>
      </div>
    </div>
  );
};

function PinCard({ pin, scale, focused, maxZ, onChange, onChat, onCommit }: {
  pin: Pin; scale: number; focused: boolean; maxZ: number; onChange: (id: string, p: Partial<Pin>) => void; onChat: (id: string) => void; onCommit: (p: Pin) => void;
}) {
  const me = useMe();
  const open = useOpen();
  const { run } = useAction();
  const [menu, setMenu] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(pin.title);
  const [body, setBody] = useState(pin.body);
  const drag = useRef<{ mode: 'move' | 'size'; sx: number; sy: number; x: number; y: number; w: number; h: number; z: number } | null>(null);
  useEffect(() => { setBody(pin.body); setTitle(pin.title); }, [pin.body, pin.title]);
  const item = pin.item;

  const save = (patch: Partial<Pin>) => run(async () => { await api.patch(`/pins/${pin.id}`, patch); });

  const start = (mode: 'move' | 'size') => (e: RPointerEvent) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (mode === 'move' && t.closest('textarea, input, button, a, .pin-resize')) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { mode, sx: e.clientX, sy: e.clientY, x: pin.x, y: pin.y, w: pin.w, h: pin.h, z: pin.z };
    if (pin.z < maxZ) onChange(pin.id, { z: maxZ + 1 });
  };
  const move = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / scale;
    const dy = (e.clientY - d.sy) / scale;
    if (d.mode === 'move') onChange(pin.id, { x: Math.round(Math.max(0, Math.min(WALL - d.w, d.x + dx))), y: Math.round(Math.max(0, d.y + dy)) });
    else onChange(pin.id, { w: Math.round(Math.max(120, Math.min(WALL - d.x, d.w + dx))), h: Math.round(Math.max(80, Math.min(1600, d.h + dy))) });
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const moved = d.mode === 'move' ? pin.x !== d.x || pin.y !== d.y : pin.w !== d.w || pin.h !== d.h;
    if (moved || pin.z !== d.z) save({ x: pin.x, y: pin.y, w: pin.w, h: pin.h, z: pin.z });
  };

  const saveTitle = () => {
    setEditingTitle(false);
    const t = title.trim();
    if (t && t !== pin.title) { onChange(pin.id, { title: t }); save({ title: t }); } else setTitle(pin.title);
  };
  const saveBody = () => { if (body !== pin.body) { onChange(pin.id, { body }); save({ body }); } };
  const chats = item ? item.thread : pin.thread;

  return (
    <article id={`pin-${pin.id}`} className={`pin kind-${pin.kind} c-${pin.color} ${item ? 'on-list' : 'idea'} ${focused ? 'focused' : ''}`}
      style={{ left: pin.x, top: pin.y, width: pin.w, height: pin.h, zIndex: pin.z, transform: `rotate(${pin.rotation}deg)`, ['--list' as any]: item?.list?.color ?? undefined }}
      onPointerDown={start('move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} aria-label={pin.title}>
      <header className="pin-head">
        {editingTitle && !item ? (
          <input className="pin-title-input" autoFocus value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle}
            onKeyDown={(e) => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') { setTitle(pin.title); setEditingTitle(false); } }} aria-label="Sticky name" />
        ) : (
          <span className="pin-title" onDoubleClick={() => !item && setEditingTitle(true)} title="Drag to move">{item ? `#${item.title}` : pin.title}</span>
        )}
        {pin.private && <Lock size={12} className="pin-lock" aria-label="Private" />}
        <button className="pin-btn" onClick={() => onChat(pin.id)} aria-label={`Chat about ${pin.title}`}>
          <MessageCircle size={14} />{chats.total > 0 && <span>{chats.total}</span>}{chats.unread > 0 && <i className="unread-dot" />}
        </button>
        <div className="menu-wrap">
          <button className="pin-btn" onClick={() => setMenu((x) => !x)} aria-label="Sticky options" aria-expanded={menu}><MoreHorizontal size={14} /></button>
          {menu && (
            <div className="pop-menu" role="menu" onMouseLeave={() => setMenu(false)}>
              {item ? (
                <button role="menuitem" onClick={() => { setMenu(false); open('item', item.id); }}><Pencil size={14} /> Item details</button>
              ) : (
                <button role="menuitem" onClick={() => { setMenu(false); onCommit(pin); }}><ListPlus size={14} /> Add to a list</button>
              )}
              {pin.kind !== 'photo' && (
                <div className="color-row" role="group" aria-label="Colour">
                  {COLORS.map((c) => <button key={c} className={`dot c-${c} ${pin.color === c ? 'on' : ''}`} aria-label={COLOR_LABEL[c]} onClick={() => { onChange(pin.id, { color: c }); save({ color: c }); }} />)}
                </div>
              )}
              {!item && <button role="menuitem" onClick={() => { setMenu(false); setEditingTitle(true); }}><Pencil size={14} /> Rename</button>}
              {pin.can_lock && !item && (
                <button role="menuitem" onClick={() => run(async () => { await api.post(`/pins/${pin.id}/privacy`, { private: !pin.private }); setMenu(false); emitChange(); }, pin.private ? 'Shared on the board' : 'Only you can see it now')}>
                  {pin.private ? <LockOpen size={14} /> : <Lock size={14} />} {pin.private ? `Share with ${me.partner?.display_name ?? 'partner'}` : 'Make private'}
                </button>
              )}
              <button role="menuitem" className="danger" onClick={() => run(async () => { await api.post(`/entities/pin/${pin.id}/archive`); emitChange(); }, item ? `Took “${pin.title}” off the board` : `Archived “${pin.title}”`)}>
                <Archive size={14} /> {item ? 'Take off the board' : 'Archive'}
              </button>
            </div>
          )}
        </div>
      </header>
      <div className="pin-body">
        {item ? <PinSummary item={item} small /> : <>
          {pin.kind === 'photo' && (pin.images[0] ? <img src={pin.images[0].url} alt={pin.title} draggable={false} /> : <p className="muted small">Uploading…</p>)}
          {pin.kind === 'link' && pin.link_url && (
            <a className="pin-link" href={pin.link_url} target="_blank" rel="noreferrer noopener" draggable={false}>
              {pin.link_image_url && <img src={pin.link_image_url} alt="" draggable={false} referrerPolicy="no-referrer" />}
              <span className="pin-link-title">{pin.link_title ?? pin.link_url.replace(/^https?:\/\/(www\.)?/, '')}</span>
              <span className="muted tiny"><ExternalLink size={11} /> {pin.link_site_name ?? new URL(pin.link_url).hostname}</span>
            </a>
          )}
          <textarea className={`pin-body-edit ${pin.kind === 'text' ? 'words' : ''}`} value={body} onChange={(e) => setBody(e.target.value)} onBlur={saveBody}
            placeholder={pin.kind === 'photo' ? 'Add a caption…' : 'Write a note…'} aria-label={`${pin.title} text`} />
        </>}
      </div>
      <span className="pin-resize" onPointerDown={start('size')} onPointerMove={move} onPointerUp={end} aria-hidden title="Drag to resize" />
    </article>
  );
}

/** Add to the board: a new idea, or something already on a list (#lamp, #raincoat…), a photo or a link. */
function AddSheet({ onClose, onIdea, onItem, onPhoto, onLink }: {
  onClose: () => void; onIdea: (title: string) => void; onItem: (id: string) => void; onPhoto: (f: File) => void; onLink: (url: string) => void;
}) {
  const [text, setText] = useState('');
  const [link, setLink] = useState(false);
  const { data } = useApi<{ items: { id: string; title: string; list: string; emoji: string | null }[] }>(`/board/candidates${text.trim() ? `?q=${encodeURIComponent(text.trim())}` : ''}`);
  const fileRef = useRef<HTMLInputElement>(null);
  const isUrl = /^https?:\/\/\S+\.\S+/.test(text.trim());
  return (
    <Sheet title="Add to the board" onClose={onClose} compact>
      <form className="card-x-add" onSubmit={(e) => { e.preventDefault(); if (isUrl) onLink(text.trim()); else onIdea(text.trim()); }}>
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={link ? 'Paste a link…' : 'A new idea… or find an item'} aria-label="New idea or search" inputMode={link ? 'url' : undefined} />
        <button className="btn small primary">{isUrl ? 'Pin link' : 'New idea'}</button>
      </form>
      {(data?.items.length ?? 0) > 0 && <>
        <h3 className="mini-title">From your lists</h3>
        <div className="chips">
          {data!.items.map((i) => <button key={i.id} className="chip" onClick={() => onItem(i.id)} title={i.list}>#{i.title.toLowerCase()}</button>)}
        </div>
      </>}
      <div className="row gap-s">
        <button className="btn small ghost" onClick={() => fileRef.current?.click()}><ImageIcon size={14} /> Photo</button>
        <button className="btn small ghost" onClick={() => setLink(true)}><Link2 size={14} /> Link</button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) onPhoto(f); e.target.value = ''; }} />
      </div>
    </Sheet>
  );
}

/** Commit a floating idea to a list: it becomes an item there and the sticky shows its details. */
function CommitSheet({ pin, onClose }: { pin: Pin; onClose: () => void }) {
  const { lists } = useLists();
  const { run, busy } = useAction();
  const choose = (key: string, label: string) => run(async () => {
    await api.post(`/pins/${pin.id}/commit`, { list: key });
    emitChange();
    onClose();
  }, `“${pin.title}” is on ${label} now`);
  return (
    <Sheet title={`Add “${pin.title}” to a list`} onClose={onClose} compact>
      <ul className="pick-list">
        {lists.filter((l) => !(pin.space === 'us' && l.private)).map((l) => (
          <li key={l.key}><button disabled={busy} onClick={() => choose(l.module === 'custom' ? l.id! : l.module, l.label)}><span className="list-icon tiny" style={{ background: l.color }}>{l.emoji}</span> {l.label}</button></li>
        ))}
      </ul>
    </Sheet>
  );
}

export function LinkSheet({ onClose, onAdd }: { onClose: () => void; onAdd: (url: string, title: string) => void }) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const valid = /^https?:\/\/\S+\.\S+/.test(url.trim());
  return (
    <Sheet title="Pin a link" onClose={onClose} compact footer={<><button className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!valid} onClick={() => onAdd(url.trim(), title.trim())}>Pin it</button></>}>
      <Field label="Link"><input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" inputMode="url" onKeyDown={(e) => e.key === 'Enter' && valid && onAdd(url.trim(), title.trim())} /></Field>
      <Field label="Name (optional)" hint="Leave empty to use the page’s title."><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} /></Field>
    </Sheet>
  );
}
