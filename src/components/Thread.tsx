import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy, CornerUpLeft, MessagesSquare, Paperclip, Pencil, Send, Trash2, X } from 'lucide-react';
import { api, emitChange, useApi } from '../lib/api';
import { useMe } from '../lib/session';
import { prepareUpload } from '../lib/image';
import { REF_RE, refPrefix } from '../lib/lists';
import { useNick } from '../lib/nick';
import { Loading, useAction } from './ui';
import { cardPath, useOpen } from './Layout';

interface Msg {
  id: string; author_id: string; author_name: string; body: string; reply_to_id: string | null; created_at: string;
  edited_at: string | null; deleted_at: string | null; mention_ids: string[]; mirrored_from_id?: string | null; attachments: { id: string; filename: string; content_type: string; url: string }[];
}
interface Suggestion { kind: 'person' | 'card'; type?: string; label: string; sub?: string; insert: string }

const URL_RE = /(https?:\/\/[^\s<>()]+[^\s<>().,!?;:'"])/g;

/** A clickable card reference inside a message: @ for whole cards, # for things in them. */
export function RefChip({ type, id, title }: { type: string; id: string; title: string }) {
  const open = useOpen();
  const nav = useNavigate();
  return (
    <button type="button" className={`ref-chip ref-${type}`} onClick={() => { const p = cardPath(type, id); if (p) nav(p); else open(type as any, id); }} title={`Open “${title}”`}>
      {refPrefix(type)}{title}
    </button>
  );
}

/** Message text → mentions, card references and links. */
export function MessageBody({ body, names }: { body: string; names: string[] }) {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  const pushText = (text: string) => {
    for (const piece of text.split(URL_RE)) {
      if (!piece) continue;
      if (/^https?:\/\//.test(piece)) {
        out.push(<a key={k++} href={piece} target="_blank" rel="noreferrer noopener">{piece.replace(/^https?:\/\/(www\.)?/, '').slice(0, 48)}</a>);
        continue;
      }
      for (const p of piece.split(/(@[\p{L}\p{N}_.-]+)/u)) {
        const isMention = p.startsWith('@') && (['@me', '@you'].includes(p.toLowerCase()) || names.some((n) => p.slice(1).toLowerCase() === n.split(' ')[0].toLowerCase()));
        out.push(isMention ? <span key={k++} className="mention">{p}</span> : <Fragment key={k++}>{p}</Fragment>);
      }
    }
  };
  for (const m of body.matchAll(REF_RE)) {
    pushText(body.slice(last, m.index));
    out.push(<RefChip key={k++} title={m[1]} type={m[2]} id={m[3]} />);
    last = (m.index ?? 0) + m[0].length;
  }
  pushText(body.slice(last));
  return <>{out}</>;
}

/** Plain-text preview of a message (card references shown as @Card / #item). */
export function previewText(body: string) {
  return body.replace(REF_RE, (_, t, type) => `${refPrefix(type)}${t}`);
}

const clock = (ts: string) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * One conversation, kept compact like a messenger: your messages on the
 * right, theirs on the left with their name. Hold a message to edit or
 * delete it, swipe it to the right to reply. Type @ for a card, # for an item.
 */
export function Thread({ type, id, space, compact, autoFocus, placeholder }: {
  type: string; id: string; space: 'me' | 'us'; compact?: boolean; autoFocus?: boolean; placeholder?: string;
}) {
  const me = useMe();
  const { name: nick } = useNick();
  const { data, loading, reload } = useApi<{ messages: Msg[]; last_read_at: string | null }>(`/threads/${type}/${id}`);
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; filename: string }[]>([]);
  const [showAll, setShowAll] = useState(!compact);
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [sugIndex, setSugIndex] = useState(0);
  const [pull, setPull] = useState<{ id: string; dx: number } | null>(null);
  const { busy, run } = useAction();
  const listRef = useRef<HTMLOListElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const press = useRef<{ id: string; x: number; y: number; timer: number; swiping?: boolean; held?: boolean } | null>(null);
  const names = useMemo(() => me.members.map((m) => m.display_name), [me]);
  const byId = useMemo(() => new Map((data?.messages ?? []).map((m) => [m.id, m])), [data]);

  useEffect(() => {
    if (data?.messages.length) {
      api.post(`/threads/${type}/${id}/read`).then(emitChange).catch(() => {});
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [data?.messages.length, type, id]);
  const ready = Boolean(data);
  useEffect(() => { if (autoFocus && ready && !window.matchMedia('(pointer: coarse)').matches) inputRef.current?.focus(); }, [autoFocus, ready]);
  useEffect(() => {
    if (!menuFor) return;
    const close = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.msg-menu')) setMenuFor(null); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuFor]);

  // ---- @ cards and people, # items
  const trigger = (text: string, caret: number) => {
    const m = /(^|\s)([@#])([^\s@#\[\]]{0,30})$/.exec(text.slice(0, caret));
    return m ? { sign: m[2] as '@' | '#', term: m[3] } : null;
  };
  const refreshSuggestions = async (text: string, caret: number) => {
    const t = trigger(text, caret);
    if (!t) { setSugs([]); return; }
    const people: Suggestion[] = t.sign === '@' && space === 'us'
      ? me.members.filter((m) => m.id !== me.user.id && m.display_name.toLowerCase().startsWith(t.term.toLowerCase()))
        .map((m) => ({ kind: 'person', label: nick(m.id), sub: 'mention', insert: `@${m.display_name.split(' ')[0]} ` }))
      : [];
    let cards: Suggestion[] = [];
    try {
      const r = await api.get<{ references: any[] }>(`/chat/references?scope=${space === 'us' ? 'us' : 'all'}&kind=${t.sign === '#' ? 'items' : 'cards'}${t.term ? `&q=${encodeURIComponent(t.term)}` : ''}`);
      cards = r.references
        .filter((x) => !(x.type === type && x.id === id))
        .map((x) => ({ kind: 'card', type: x.type, label: x.title, sub: x.subtitle, insert: `@[${x.title.replace(/[\[\]]/g, '')}](${x.type}:${x.id}) ` }));
    } catch { /* suggestions are optional */ }
    const now = trigger(inputRef.current?.value ?? '', inputRef.current?.selectionStart ?? 0);
    if (now && now.sign === t.sign && now.term === t.term) {
      setSugs([...people, ...cards].slice(0, 8));
      setSugIndex(0);
    }
  };
  const choose = (s: Suggestion) => {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? body.length;
    const before = body.slice(0, caret).replace(/[@#]([^\s@#\[\]]{0,30})$/, '');
    const next = before + s.insert + body.slice(caret);
    setBody(next);
    setSugs([]);
    requestAnimationFrame(() => { el?.focus(); const pos = (before + s.insert).length; el?.setSelectionRange(pos, pos); });
  };

  const send = () => run(async () => {
    if (!body.trim() && !pending.length) return;
    await api.post(`/threads/${type}/${id}/messages`, { body: body.trim(), reply_to_id: replyTo?.id ?? null, attachment_ids: pending.map((p) => p.id) });
    setBody('');
    setReplyTo(null);
    setPending([]);
    setSugs([]);
    await reload();
    emitChange();
  });

  const attach = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files).slice(0, 5)) {
      await run(async () => {
        const fd = new FormData();
        fd.set('entity_type', 'message');
        fd.set('space', space);
        fd.set('file', await prepareUpload(f));
        const r = await api.post('/attachments', fd);
        setPending((p) => [...p, { id: r.attachment.id, filename: r.attachment.filename }]);
      });
    }
  };

  // ---- hold for the menu, swipe right to reply
  const onDown = (m: Msg) => (e: React.PointerEvent) => {
    if (m.deleted_at || e.button !== 0 || (e.target as HTMLElement).closest('a, button, textarea')) return;
    const p = { id: m.id, x: e.clientX, y: e.clientY, timer: 0 } as NonNullable<typeof press.current>;
    p.timer = window.setTimeout(() => { if (press.current === p && !p.swiping) { p.held = true; setMenuFor(m.id); navigator.vibrate?.(10); } }, 450);
    press.current = p;
  };
  const onMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p || p.held) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!p.swiping && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
      clearTimeout(p.timer);
      if (dx > 0 && Math.abs(dx) > Math.abs(dy)) { p.swiping = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } else { press.current = null; return; }
    }
    if (p.swiping) setPull({ id: p.id, dx: Math.min(80, Math.max(0, dx)) });
  };
  const onUp = () => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    clearTimeout(p.timer);
    if (p.swiping && pull && pull.dx > 50) { const m = byId.get(p.id); if (m) { setReplyTo(m); inputRef.current?.focus(); } }
    setPull(null);
  };

  if (loading && !data) return <Loading />;
  const all = data?.messages ?? [];
  const msgs = showAll ? all : all.slice(-3);
  const lastRead = data?.last_read_at ? new Date(data.last_read_at).getTime() : 0;

  return (
    <div className={`thread chat-compact ${compact ? 'compact' : ''}`}>
      {space === 'me' && !compact && <p className="note subtle tiny">Private: only you can see this.</p>}
      {!all.length && <p className="muted small thread-empty">No messages yet.</p>}
      {!showAll && all.length > msgs.length && <button className="link-btn tiny" onClick={() => setShowAll(true)}>{all.length - msgs.length} earlier</button>}
      <ol className="messages" ref={listRef}>
        {msgs.map((m, i) => {
          const mine = m.author_id === me.user.id;
          const prev = msgs[i - 1];
          const first = !prev || prev.author_id !== m.author_id;
          const parent = m.reply_to_id ? byId.get(m.reply_to_id) : null;
          const unread = !mine && new Date(m.created_at).getTime() > lastRead;
          const canChange = mine && !m.mirrored_from_id && !m.deleted_at;
          return (
            <li key={m.id} className={`msg ${mine ? 'mine' : ''} ${first ? 'first' : ''} ${unread ? 'unread' : ''}`}
              style={pull?.id === m.id ? { transform: `translateX(${pull.dx}px)` } : undefined}
              onPointerDown={onDown(m)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
              onContextMenu={(e) => { if (!m.deleted_at) { e.preventDefault(); setMenuFor(m.id); } }}>
              {pull?.id === m.id && <span className="reply-hint" aria-hidden><CornerUpLeft size={14} /></span>}
              {!mine && first && <div className="msg-author">{nick(m.author_id, m.author_name ?? 'Former member')}{m.mirrored_from_id && <MessagesSquare size={10} aria-label="From Our chat" />}</div>}
              {parent && <div className="msg-quote">{parent.deleted_at ? 'Deleted message' : `${parent.author_id === me.user.id ? 'You' : nick(parent.author_id, parent.author_name)}: ${previewText(parent.body).slice(0, 70)}`}</div>}
              {m.deleted_at ? <div className="msg-body muted"><i>Deleted</i></div> : editing === m.id ? (
                <div className="msg-edit">
                  <textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={2} aria-label="Edit message" autoFocus />
                  <div className="row gap-s">
                    <button className="btn small primary" disabled={busy || !editBody.trim()} onClick={() => run(async () => { await api.patch(`/messages/${m.id}`, { body: editBody }); setEditing(null); await reload(); })}>Save</button>
                    <button className="btn small ghost" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="msg-body"><MessageBody body={m.body} names={names} /><span className="msg-time">{m.edited_at ? 'edited · ' : ''}{clock(m.created_at)}</span></div>
              )}
              {!m.deleted_at && m.attachments.length > 0 && (
                <div className="msg-atts">
                  {m.attachments.map((a) => a.content_type.startsWith('image/')
                    ? <a key={a.id} href={a.url} target="_blank" rel="noreferrer"><img src={a.url} alt={a.filename} loading="lazy" /></a>
                    : <a key={a.id} href={a.url} target="_blank" rel="noreferrer" className="chip">{a.filename}</a>)}
                </div>
              )}
              {menuFor === m.id && (
                <div className="msg-menu" role="menu">
                  <button role="menuitem" onClick={() => { setMenuFor(null); setReplyTo(m); inputRef.current?.focus(); }}><CornerUpLeft size={14} /> Reply</button>
                  <button role="menuitem" onClick={() => { setMenuFor(null); navigator.clipboard?.writeText(previewText(m.body)).catch(() => {}); }}><Copy size={14} /> Copy</button>
                  {canChange && <button role="menuitem" onClick={() => { setMenuFor(null); setEditing(m.id); setEditBody(m.body); }}><Pencil size={14} /> Edit</button>}
                  {canChange && <button role="menuitem" className="danger" onClick={() => { setMenuFor(null); run(async () => { await api.del(`/messages/${m.id}`); await reload(); }); }}><Trash2 size={14} /> Delete</button>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <div className="composer">
        {replyTo && <div className="replying"><span className="grow clamp1">↪ {replyTo.author_id === me.user.id ? 'You' : nick(replyTo.author_id, replyTo.author_name)}: {previewText(replyTo.body).slice(0, 60)}</span><button className="icon-btn small" onClick={() => setReplyTo(null)} aria-label="Cancel reply"><X size={14} /></button></div>}
        {pending.length > 0 && <div className="row gap-s wrap">{pending.map((p) => <span className="chip" key={p.id}>{p.filename} <button className="link-btn" aria-label={`Remove ${p.filename}`} onClick={() => setPending((x) => x.filter((y) => y.id !== p.id))}><X size={12} /></button></span>)}</div>}
        {sugs.length > 0 && (
          <ul className="suggest" role="listbox" aria-label="Link a card or an item">
            {sugs.map((s, i) => (
              <li key={s.insert} role="option" aria-selected={i === sugIndex}>
                <button type="button" className={i === sugIndex ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); choose(s); }}>
                  <span className="at">{s.kind === 'card' ? refPrefix(s.type ?? '') : '@'}</span>
                  <span className="grow clamp1">{s.label}</span>
                  {s.sub && <span className="muted tiny">{s.sub}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="composer-row">
          <label className="icon-btn small" aria-label="Attach photo or file" title="Attach">
            <Paperclip size={17} />
            <input type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => attach(e.target.files)} />
          </label>
          <textarea
            ref={inputRef}
            value={body}
            rows={1}
            placeholder={placeholder ?? 'Message'}
            aria-label="Message"
            onChange={(e) => { setBody(e.target.value); refreshSuggestions(e.target.value, e.target.selectionStart); }}
            onKeyDown={(e) => {
              if (sugs.length) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setSugIndex((i) => (i + 1) % sugs.length); return; }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSugIndex((i) => (i - 1 + sugs.length) % sugs.length); return; }
                if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); choose(sugs[sugIndex]); return; }
                if (e.key === 'Escape') { setSugs([]); return; }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
            }}
            onBlur={() => setTimeout(() => setSugs([]), 150)}
          />
          <button className="send-btn" disabled={busy || (!body.trim() && !pending.length)} onClick={send} aria-label="Send"><Send size={16} /></button>
        </div>
      </div>
    </div>
  );
}
