import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, Archive, ExternalLink, LayoutGrid, Pencil, Image as ImageIcon, Link2, Lock, LockOpen, MessageCircle, MessagesSquare, MoreHorizontal, PanelRightClose, PanelRightOpen, StickyNote, Type } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { prepareUpload } from '../lib/image';
import { Thread } from '../components/Thread';
import { Linked } from '../components/Linked';
import { Field, Loading, Sheet, useAction } from '../components/ui';

interface Pin {
  id: string; kind: 'note' | 'photo' | 'link' | 'text'; title: string; body: string; color: string; link_url: string | null; link_title: string | null;
  link_image_url: string | null; link_site_name: string | null; x: number; y: number; w: number; h: number; rotation: number; z: number; tags: string[];
  private: boolean; can_lock: boolean; space: 'me' | 'us'; images: { id: string; url: string; filename: string }[]; thread: { total: number; unread: number };
  created_by_name: string | null;
}

const WALL = 1200;
const COLORS = ['butter', 'blush', 'sage', 'sky', 'lilac', 'paper', 'ink'] as const;
const COLOR_LABEL: Record<string, string> = { butter: 'Butter', blush: 'Blush', sage: 'Sage', sky: 'Sky', lilac: 'Lilac', paper: 'Paper', ink: 'Ink' };

/**
 * The Board: a wall to pin sticky notes, photos, links and words on, like a
 * fridge door. Drag to move, pull the corner to resize. The main chat sits on
 * the side, and every pin can be @-mentioned there (type @ and its name).
 */
export function BoardPage() {
  const [params, setParams] = useSearchParams();
  const { data, setData } = useApi<{ pins: Pin[] }>('/board');
  const { data: general } = useApi<{ topic: any }>('/chat/general');
  const [panel, setPanel] = useState(() => window.innerWidth > 1100);
  const [chatPin, setChatPin] = useState<string | null>(null);
  const [linkSheet, setLinkSheet] = useState(false);
  const { run } = useAction();
  const fileRef = useRef<HTMLInputElement>(null);
  const focus = params.get('pin');
  const pins = data?.pins ?? [];

  useEffect(() => {
    if (!focus || !data) return;
    const el = document.getElementById(`pin-${focus}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [focus, data]);

  const update = useCallback((id: string, patch: Partial<Pin>) => {
    setData((d) => (d ? { ...d, pins: d.pins.map((p) => (p.id === id ? { ...p, ...patch } : p)) } : d));
  }, [setData]);

  const add = (body: Record<string, unknown>, after?: (pin: Pin) => Promise<void>) => run(async () => {
    const wallEl = document.querySelector('.wall');
    const wallTop = wallEl ? Math.max(0, Math.round(-wallEl.getBoundingClientRect().top / scaleOf())) : 0;
    const r = await api.post<{ pin: Pin }>('/pins', { x: 40 + Math.round(Math.random() * 500), y: wallTop + 30 + Math.round(Math.random() * 60), ...body });
    if (after) await after(r.pin);
    emitChange();
    const n = new URLSearchParams(params); n.set('pin', r.pin.id); setParams(n, { replace: true });
  });
  const addPhoto = (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    add({ kind: 'photo', color: 'paper' }, async (pin) => {
      const fd = new FormData();
      fd.set('entity_type', 'pin'); fd.set('entity_id', pin.id); fd.set('file', await prepareUpload(f));
      await api.post('/attachments', fd);
    });
  };

  const openChat = (id: string | null) => { setChatPin(id); setPanel(true); };
  const current = pins.find((p) => p.id === chatPin);

  return (
    <div className={`page board-page ${panel ? 'with-panel' : ''}`}>
      <header className="board-head">
        <h1><LayoutGrid size={22} /> Board</h1>
        <div className="board-tools" role="toolbar" aria-label="Add to the board">
          <button className="tool" onClick={() => add({ kind: 'note', color: COLORS[Math.floor(Math.random() * 5)] })}><StickyNote size={16} /> Sticky</button>
          <button className="tool" onClick={() => add({ kind: 'text', body: '' })}><Type size={16} /> Words</button>
          <button className="tool" onClick={() => fileRef.current?.click()}><ImageIcon size={16} /> Photo</button>
          <button className="tool" onClick={() => setLinkSheet(true)}><Link2 size={16} /> Link</button>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => { addPhoto(e.target.files); e.target.value = ''; }} />
          <button className="icon-btn" onClick={() => setPanel((x) => !x)} aria-label={panel ? 'Hide chat' : 'Show chat'} title={panel ? 'Hide chat' : 'Show chat'}>
            {panel ? <PanelRightClose size={19} /> : <PanelRightOpen size={19} />}
          </button>
        </div>
      </header>
      <div className="board-layout">
        {!data ? <Loading /> : <Wall pins={pins} focus={focus} onChange={update} onChat={openChat} />}
        {panel && (
          <aside className="board-chat" aria-label="Chat">
            {current ? (
              <>
                <header className="board-chat-head">
                  <button className="icon-btn small" onClick={() => setChatPin(null)} aria-label="Back to Our chat"><ArrowLeft size={16} /></button>
                  <b className="grow clamp1">{current.title}</b>
                  {current.private && <Lock size={13} className="muted" aria-label="Private" />}
                </header>
                <Linked type="pin" id={current.id} compact />
                <Thread key={current.id} type="pin" id={current.id} space={current.space} autoFocus placeholder={`About “${current.title}”… @ to link`} />
              </>
            ) : (
              <>
                <header className="board-chat-head"><MessagesSquare size={16} /><b className="grow">Our chat</b><span className="muted tiny">@ a pin to point at it</span></header>
                {general ? <Thread type="topic" id={general.topic.id} space="us" placeholder="Message… type @ and a pin’s name" /> : <Loading />}
              </>
            )}
          </aside>
        )}
      </div>
      {linkSheet && <LinkSheet onClose={() => setLinkSheet(false)} onAdd={(url, title) => { setLinkSheet(false); add({ kind: 'link', link_url: url, title: title || undefined, color: 'paper' }); }} />}
    </div>
  );
}

function scaleOf() {
  const el = document.querySelector<HTMLElement>('.wall');
  return el ? Number(el.dataset.scale || 1) : 1;
}

function Wall({ pins, focus, onChange, onChat }: { pins: Pin[]; focus: string | null; onChange: (id: string, p: Partial<Pin>) => void; onChat: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  // On a phone the wall would be too small to read, so pins stack in a column instead.
  const stacked = width > 0 && width < 640;
  const scale = width ? width / WALL : 1;
  const height = Math.max(900, ...pins.map((p) => p.y + p.h + 160));
  const maxZ = useMemo(() => Math.max(0, ...pins.map((p) => p.z)), [pins]);
  const ordered = stacked ? [...pins].sort((a, b) => a.y - b.y || a.x - b.x) : pins;

  return (
    <div ref={ref} className={`wall ${stacked ? 'stacked' : ''}`} data-scale={scale} style={stacked ? undefined : { height: height * scale }}>
      {!pins.length && <p className="wall-empty">An empty wall. Add a sticky, some words, a photo or a link, then drag them where you like.</p>}
      <div className="wall-inner" style={stacked ? undefined : { width: WALL, height, transform: `scale(${scale})` }}>
        {ordered.map((p) => <PinCard key={p.id} pin={p} scale={scale} stacked={stacked} focused={focus === p.id} maxZ={maxZ} onChange={onChange} onChat={onChat} />)}
      </div>
    </div>
  );
}

function PinCard({ pin, scale, stacked, focused, maxZ, onChange, onChat }: {
  pin: Pin; scale: number; stacked: boolean; focused: boolean; maxZ: number; onChange: (id: string, p: Partial<Pin>) => void; onChat: (id: string) => void;
}) {
  const me = useMe();
  const { run } = useAction();
  const [menu, setMenu] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [title, setTitle] = useState(pin.title);
  const [body, setBody] = useState(pin.body);
  const drag = useRef<{ mode: 'move' | 'size'; sx: number; sy: number; x: number; y: number; w: number; h: number; z: number } | null>(null);
  useEffect(() => { setBody(pin.body); setTitle(pin.title); }, [pin.body, pin.title]);

  const save = (patch: Partial<Pin>) => run(async () => { await api.patch(`/pins/${pin.id}`, patch); });

  const start = (mode: 'move' | 'size') => (e: RPointerEvent) => {
    if (stacked || e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (mode === 'move' && t.closest('textarea, input, button, a, .pin-body-edit')) return;
    e.preventDefault();
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

  const style = stacked
    ? undefined
    : { left: pin.x, top: pin.y, width: pin.w, height: pin.h, zIndex: pin.z, transform: `rotate(${pin.rotation}deg)` };

  return (
    <article id={`pin-${pin.id}`} className={`pin kind-${pin.kind} c-${pin.color} ${focused ? 'focused' : ''}`} style={style}
      onPointerDown={start('move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} aria-label={pin.title}>
      <header className="pin-head">
        {editingTitle ? (
          <input className="pin-title-input" autoFocus value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle}
            onKeyDown={(e) => { if (e.key === 'Enter') saveTitle(); if (e.key === 'Escape') { setTitle(pin.title); setEditingTitle(false); } }} aria-label="Pin name" />
        ) : (
          <span className="pin-title" onDoubleClick={() => setEditingTitle(true)} title="Drag to move · double-click to rename">{pin.title}</span>
        )}
        {pin.private && <Lock size={12} className="pin-lock" aria-label="Private" />}
        <button className="pin-btn" onClick={() => onChat(pin.id)} aria-label={`Chat about ${pin.title}`}>
          <MessageCircle size={14} />{pin.thread.total > 0 && <span>{pin.thread.total}</span>}{pin.thread.unread > 0 && <i className="unread-dot" />}
        </button>
        <div className="menu-wrap">
          <button className="pin-btn" onClick={() => setMenu((x) => !x)} aria-label="Pin options" aria-expanded={menu}><MoreHorizontal size={14} /></button>
          {menu && (
            <div className="pop-menu" role="menu" onMouseLeave={() => setMenu(false)}>
              {pin.kind !== 'photo' && (
                <div className="color-row" role="group" aria-label="Colour">
                  {COLORS.map((c) => <button key={c} className={`dot c-${c} ${pin.color === c ? 'on' : ''}`} aria-label={COLOR_LABEL[c]} onClick={() => { onChange(pin.id, { color: c }); save({ color: c }); }} />)}
                </div>
              )}
              <button role="menuitem" onClick={() => { setMenu(false); setEditingTitle(true); }}><Pencil size={14} /> Rename</button>
              {pin.can_lock && (
                <button role="menuitem" onClick={() => run(async () => { await api.post(`/pins/${pin.id}/privacy`, { private: !pin.private }); setMenu(false); emitChange(); }, pin.private ? 'Shared on the board' : 'Only you can see it now')}>
                  {pin.private ? <LockOpen size={14} /> : <Lock size={14} />} {pin.private ? `Share with ${me.partner?.display_name ?? 'partner'}` : 'Make private'}
                </button>
              )}
              <button role="menuitem" className="danger" onClick={() => run(async () => { await api.post(`/entities/pin/${pin.id}/archive`); emitChange(); }, `Archived “${pin.title}”`)}><Archive size={14} /> Archive</button>
            </div>
          )}
        </div>
      </header>
      <div className="pin-body">
        {pin.kind === 'photo' && (pin.images[0] ? <img src={pin.images[0].url} alt={pin.title} draggable={false} /> : <p className="muted small">Uploading…</p>)}
        {pin.kind === 'link' && pin.link_url && (
          <a className="pin-link" href={pin.link_url} target="_blank" rel="noreferrer noopener" draggable={false}>
            {pin.link_image_url && <img src={pin.link_image_url} alt="" draggable={false} referrerPolicy="no-referrer" />}
            <span className="pin-link-title">{pin.link_title ?? pin.link_url.replace(/^https?:\/\/(www\.)?/, '')}</span>
            <span className="muted tiny"><ExternalLink size={11} /> {pin.link_site_name ?? new URL(pin.link_url).hostname}</span>
          </a>
        )}
        <textarea className={`pin-body-edit ${pin.kind === 'text' ? 'words' : ''}`} value={body} onChange={(e) => setBody(e.target.value)} onBlur={saveBody}
          placeholder={pin.kind === 'text' ? 'Write something…' : pin.kind === 'note' ? 'Write a note…' : 'Add a caption…'} aria-label={`${pin.title} text`} />
      </div>
      {!stacked && <span className="pin-resize" onPointerDown={start('size')} onPointerMove={move} onPointerUp={end} aria-hidden title="Drag to resize" />}
    </article>
  );
}

function LinkSheet({ onClose, onAdd }: { onClose: () => void; onAdd: (url: string, title: string) => void }) {
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
